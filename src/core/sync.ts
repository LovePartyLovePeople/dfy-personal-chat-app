/**
 * 记忆同步：电脑当中心节点，手机和桌面都往它推、从它取。
 *
 * 关键设计：**不依赖自增 id**。两台设备的 Dexie 各自从 1 开始生成消息 id，按 id 合并必然撞车。
 * 这里用「类型 + 角色 + 时间戳 + 内容前缀」做指纹去重，时间戳是毫秒级，跨设备基本不会重复。
 *
 * 限制（目前有意不做）：删除不同步。在 A 设备删掉的消息，下次同步会从 B 设备被带回来。
 */
import { db } from "./db";
import type { Character, Fact, Message, Summary } from "./types";

export type SyncStore = {
  characters: Character[];
  messages: Message[];
  facts: Fact[];
  summaries: Summary[];
};

function fingerprint(kind: string, rec: any): string {
  if (kind === "characters") return `c:${rec.id}`;
  if (kind === "messages") return `m:${rec.characterId}:${rec.ts}:${rec.role}:${String(rec.content || "").slice(0, 60)}`;
  if (kind === "facts") return `f:${rec.characterId}:${String(rec.text || "")}`;
  if (kind === "summaries") return `s:${rec.characterId}`;
  return `${kind}:${JSON.stringify(rec).slice(0, 80)}`;
}

export async function collectLocal(): Promise<SyncStore> {
  return {
    characters: await db.characters.toArray(),
    messages: await db.messages.toArray(),
    facts: await db.facts.toArray(),
    summaries: await db.summaries.toArray(),
  };
}

/** 把远端合并进本地；返回新增条数 */
export async function mergeLocal(store: Partial<SyncStore>): Promise<number> {
  let added = 0;

  const charIds = new Set((await db.characters.toArray()).map((c) => c.id));
  for (const c of store.characters || []) {
    if (!charIds.has(c.id)) {
      await db.characters.put(c);
      charIds.add(c.id);
      added++;
    }
  }

  const msgKeys = new Set((await db.messages.toArray()).map((m) => fingerprint("messages", m)));
  const newMsgs: Message[] = [];
  for (const m of store.messages || []) {
    if (!charIds.has(m.characterId)) continue;
    const k = fingerprint("messages", m);
    if (msgKeys.has(k)) continue;
    msgKeys.add(k);
    const { id: _drop, ...rest } = m;
    newMsgs.push(rest as Message);
  }
  if (newMsgs.length) {
    await db.messages.bulkAdd(newMsgs);
    added += newMsgs.length;
  }

  const factKeys = new Set((await db.facts.toArray()).map((f) => fingerprint("facts", f)));
  const newFacts: Fact[] = [];
  for (const f of store.facts || []) {
    if (!charIds.has(f.characterId)) continue;
    const k = fingerprint("facts", f);
    if (factKeys.has(k)) continue;
    factKeys.add(k);
    const { id: _drop, ...rest } = f;
    newFacts.push(rest as Fact);
  }
  if (newFacts.length) {
    await db.facts.bulkAdd(newFacts);
    added += newFacts.length;
  }

  for (const s of store.summaries || []) {
    const cur = await db.summaries.get(s.characterId);
    if (!cur || (s.updatedAt || 0) > (cur.updatedAt || 0)) {
      await db.summaries.put(s);
      added++;
    }
  }

  return added;
}

export type SyncResult = { pulled: number; remoteTotal: number };

/** 推本地 → 拿回并集 → 合并进本地 */
export async function syncWith(base: string, timeoutMs = 30000): Promise<SyncResult> {
  if (!base) throw new Error("没有同步地址");
  const local = await collectLocal();
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${base}/__sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(local),
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    const pulled = await mergeLocal(data.store || {});
    return { pulled, remoteTotal: (data.store?.messages || []).length };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
