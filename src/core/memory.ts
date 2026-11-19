import { db } from "./db";
import type { Character, Message, MemoryConfig, Role } from "./types";
import { DEFAULT_MEMORY } from "./types";

export type Summarizer = (prompt: string) => Promise<string>;

/** 追加一条消息 */
export async function appendMessage(characterId: string, role: Role, content: string, image?: string) {
  await db.messages.add({ characterId, role, content, image, ts: Date.now() });
}

/** 记一条长期事实 */
export async function rememberFact(characterId: string, text: string, cfg = DEFAULT_MEMORY) {
  const t = text.trim();
  if (!t) return;
  await db.facts.add({ characterId, text: t.slice(0, 400), ts: Date.now() });
  const all = await db.facts.where("characterId").equals(characterId).sortBy("ts");
  if (all.length > cfg.factMax) {
    const drop = all.slice(0, all.length - cfg.factMax);
    await db.facts.bulkDelete(drop.map((f) => f.id!).filter(Boolean));
  }
}

/** 读取最近 N 条 + 摘要 + 事实，拼成给模型的上下文 */
export async function buildContext(characterId: string, cfg = DEFAULT_MEMORY) {
  const recent = await db.messages
    .where("characterId").equals(characterId)
    .reverse().limit(cfg.recentCount).toArray();
  recent.reverse();

  const factRows = await db.facts.where("characterId").equals(characterId).sortBy("ts");
  const summary = await db.summaries.get(characterId);

  return {
    facts: factRows.map((f) => f.text),
    summary: summary?.text ?? "",
    recent,
  };
}

/** 把上下文渲染成 system prompt 追加块。longTerm=false 时只带最近的原文，不注入事实和摘要 */
export function renderMemoryBlock(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  opts: { longTerm?: boolean } = {}
) {
  const longTerm = opts.longTerm !== false;
  const parts: string[] = [];
  if (longTerm && ctx.facts.length) {
    parts.push("【你记住过的事】\n" + ctx.facts.map((f) => `- ${f}`).join("\n"));
  }
  if (longTerm && ctx.summary) {
    parts.push("【更早的聊天摘要】\n" + ctx.summary);
  }
  if (ctx.recent.length) {
    parts.push(
      "【最近的聊天】\n" +
        ctx.recent.map((m) => `${m.role === "user" ? "主人" : "你"}: ${m.content.slice(0, 200)}`).join("\n")
    );
  }
  return parts.join("\n\n");
}

/** 消息攒够一批就滚动摘要（由调用方提供 LLM 函数） */
export async function maybeRollSummary(
  characterId: string,
  summarize: Summarizer,
  cfg = DEFAULT_MEMORY
): Promise<boolean> {
  const total = await db.messages.where("characterId").equals(characterId).count();
  const cur = await db.summaries.get(characterId);
  const done = cur?.summarizedCount ?? 0;
  if (total - done < cfg.summaryBatch) return false;

  const batch = await db.messages
    .where("characterId").equals(characterId)
    .offset(done).limit(total - done).toArray();
  if (!batch.length) return false;

  const dialogue = batch
    .map((m) => `${m.role === "user" ? "主人" : "你"}: ${m.content}`)
    .join("\n");

  const prompt =
    "你在维护一段长期记忆摘要。把【新增对话】并入【已有摘要】，" +
    `输出不超过 ${cfg.summaryMaxChars} 字的中文摘要，保留：主人的稳定偏好、正在做的事、约定、情绪变化、重要的人和事。` +
    "不要编造，不要逐句复述，直接输出摘要正文。\n\n" +
    `【已有摘要】\n${cur?.text ?? "（无）"}\n\n【新增对话】\n${dialogue}`;

  const text = (await summarize(prompt)).trim();
  if (!text) return false;
  await db.summaries.put({ characterId, text, summarizedCount: total, updatedAt: Date.now() });
  return true;
}

/** 初始化一个角色 */
export async function createCharacter(input: Partial<Character> & { name: string; persona: string }) {
  const id = input.id ?? `char_${Date.now().toString(36)}`;
  const c: Character = {
    id,
    name: input.name,
    persona: input.persona,
    avatar: input.avatar,
    background: input.background,
    createdAt: Date.now(),
  };
  await db.characters.put(c);
  return c;
}

/** 导出整个角色的数据（用于备份/迁移） */
export async function exportCharacter(characterId: string) {
  const character = await db.characters.get(characterId);
  const messages = await db.messages.where("characterId").equals(characterId).sortBy("ts");
  const facts = await db.facts.where("characterId").equals(characterId).sortBy("ts");
  const summary = await db.summaries.get(characterId);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    character,
    messages: messages.map(({ characterId: _c, ...m }) => m),
    facts: facts.map(({ characterId: _c, ...f }) => f),
    summary,
  };
}