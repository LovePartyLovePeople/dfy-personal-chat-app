import { useEffect, useRef, useState } from "react";
import { db, resetDb } from "./core/db";
import { appendMessage, buildContext, maybeRollSummary, rememberFact, renderMemoryBlock, exportCharacter } from "./core/memory";
import { chat, testConnection } from "./core/llm";
import { compressImage, pickImage, pickImages } from "./core/image";
import { searchWeb, resolveSearchBase, shouldSearch, renderSearchBlock, extractUrl, fetchPage, renderPageBlock, cleanQuery, DEFAULT_SEARCH_MODE } from "./core/search";
import type { SearchMode } from "./core/search";
import { syncWith } from "./core/sync";
import type { Character, Fact, Message, ProviderConfig, Sticker, Summary } from "./core/types";
import { DEFAULT_MEMORY } from "./core/types";
import { SEED_PROVIDER, SEED_CHARACTER, SEED_LOCAL_PRESETS, SEED_REMOTE_BASE } from "./seed";

const VERSION = "0.9.0";

/** 构建时由 vite.config.ts 注入 */
const EDITION = (import.meta.env.VITE_EDITION as string) === "personal" ? "personal" : "public";
const IS_PERSONAL = EDITION === "personal";
const APP_TITLE = (import.meta.env.VITE_APP_NAME as string) || "大肥鱼";

/** 自动化测试专用：带 ?test=1 打开时不弹 18+、不拦空 Key（外部会把 fetch 桩掉） */
const TEST_MODE = typeof location !== "undefined" && new URLSearchParams(location.search).has("test");

/** 兜底：模型偶尔会把注入的资料整段抄回来，把标记之后的垃圾切掉 */function stripInjected(text: string): string {
  if (!text) return text;
  const cut = text.search(/【(联网检索结果|我的问题|用户贴的网页正文|你刚查到的情况)】/);
  if (cut >= 0) return text.slice(0, cut).trim();
  return text;
}

/** 气泡样式：背景、边框颜色/粗细、圆角、文字色 */
export type BubbleStyle = { bg: string; border: string; width: number; radius: number; text?: string };

export const BUBBLE_PRESETS: { name: string; style: BubbleStyle }[] = [
  { name: "微信绿", style: { bg: "#95ec69", border: "transparent", width: 0, radius: 8 } },
  { name: "描边白", style: { bg: "#ffffff", border: "#2f4f3f", width: 3, radius: 16 } },
  { name: "描边界绿", style: { bg: "#f7fff4", border: "#7dcf5a", width: 2, radius: 18 } },
  { name: "深色描边", style: { bg: "#2b2b2b", border: "#e8e8e8", width: 2, radius: 16, text: "#f2f2f2" } },
  { name: "淡蓝无框", style: { bg: "#dbe4ff", border: "transparent", width: 0, radius: 18 } },
];

const DEFAULT_BUBBLE_STYLE = BUBBLE_PRESETS[0].style;

function loadBubbleStyle(): BubbleStyle {
  try {
    const raw = localStorage.getItem("bubbleStyle");
    if (raw) return { ...DEFAULT_BUBBLE_STYLE, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_BUBBLE_STYLE;
}

function isLocalUrl(url: string) {
  return /localhost|127\.0\.0\.1|192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\./.test(url || "");
}


const DEFAULT_PERSONA = `你是谁，你自己决定。说话短、口语、有脾气。
不要用"我保持中立""作为AI"这类话，不要每句都问回去，不要客套。
你有自己的判断和偏好。`;

const DEFAULT_PROVIDER: ProviderConfig = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
};

/** 自用构建的默认服务商：本机模型，离线、免费 */
const LOCAL_PROVIDER: ProviderConfig = {
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "local",
  model: "dafeiyu",
};

/**
 * 手机上 127.0.0.1 指的是手机自己，那儿没有模型。
 * 所以安卓端默认连「远程地址」——具体是什么地址由 seed 决定（个人地址不写进源码）。
 */
const REMOTE_PROVIDER: ProviderConfig = SEED_REMOTE_BASE
  ? { baseUrl: SEED_REMOTE_BASE, apiKey: "local", model: "dafeiyu" }
  : LOCAL_PROVIDER;

/** 桌面壳会注入 window.dafeiyu，安卓上没有 */
const ON_DESKTOP = typeof window !== "undefined" && (window as any).dafeiyu?.isDesktop === true;

/** 常见服务商预设：点一下只改地址和模型，Key 自己填 */
const PROVIDER_PRESETS = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"] },
  { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3", models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "THUDM/GLM-4-9B-0414"] },
  { name: "阿里百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", models: ["qwen-plus", "qwen-max", "qwen-turbo"] },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", models: ["gpt-4o-mini", "gpt-4o"] },
];

type Preset = { name: string; baseUrl: string; model: string; models: string[] };

/** 额外预设：本机模型固定走 127.0.0.1；远程地址来自 seed（不写死在这里） */
const LOCAL_PRESETS: Preset[] = [
  { name: "本地 Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "dafeiyu", models: ["dafeiyu", "qwen2.5:7b", "qwen2.5:14b"] },
  ...(SEED_LOCAL_PRESETS as Preset[]),
];

const PRESETS = IS_PERSONAL ? [...LOCAL_PRESETS, ...PROVIDER_PRESETS] : PROVIDER_PRESETS;

function fmtTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function loadProvider(): ProviderConfig {
  try {
    const raw = localStorage.getItem("provider");
    if (raw) return { ...DEFAULT_PROVIDER, ...JSON.parse(raw) };
  } catch {}
  // 自用构建：桌面默认本机模型，手机默认连远程地址
  if (IS_PERSONAL) return ON_DESKTOP ? LOCAL_PROVIDER : REMOTE_PROVIDER;
  if (SEED_PROVIDER.apiKey) return { ...DEFAULT_PROVIDER, ...SEED_PROVIDER };
  return DEFAULT_PROVIDER;
}

type Sampling = { temperature: number; topP: number; maxTokens: number };

/** 默认采样参数 */
const DEFAULT_SAMPLING: Sampling = IS_PERSONAL
  ? { temperature: 0.9, topP: 0.95, maxTokens: 1200 }
  : { temperature: 1.05, topP: 1, maxTokens: 800 };

function loadSampling(): Sampling {
  try {
    const raw = localStorage.getItem("sampling");
    if (raw) return { ...DEFAULT_SAMPLING, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_SAMPLING;
}

type View =
  | { kind: "list" }
  | { kind: "chat"; id: string }
  | { kind: "settings"; id: string }
  | { kind: "memory"; id: string }
  | { kind: "stickers" }
  | { kind: "new" };

export default function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  const [chars, setChars] = useState<Character[]>([]);
  const [lastMsg, setLastMsg] = useState<Record<string, string>>({});
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderConfig>(loadProvider);
  const [draft, setDraft] = useState<ProviderConfig>(loadProvider);
  const [sampling, setSampling] = useState<Sampling>(loadSampling);
  const [meAvatar, setMeAvatar] = useState<string>(() => localStorage.getItem("meAvatar") || "");
  const [meFrame, setMeFrame] = useState<string>(() => localStorage.getItem("meFrame") || "");
  const [bubbleStyle, setBubbleStyle] = useState<BubbleStyle>(loadBubbleStyle);
  const [meFramePos, setMeFramePos] = useState<"outer" | "corner">(() => (localStorage.getItem("meFramePos") as any) || "corner");
  const [charFramePos, setCharFramePos] = useState<"outer" | "corner">(() => (localStorage.getItem("charFramePos") as any) || "corner");
  const [searchMode, setSearchMode] = useState<SearchMode>(() => {
    const v = localStorage.getItem("searchMode");
    return v === "off" || v === "always" || v === "auto" ? (v as SearchMode) : DEFAULT_SEARCH_MODE;
  });
  const [ageOk, setAgeOk] = useState<boolean>(!IS_PERSONAL || TEST_MODE || localStorage.getItem("ageOk") === "1");
  /** 长期记忆（事实 + 摘要）默认关：塞太多东西进 system，7B 会被带偏，聊什么都能拐到那几条事实上 */
  const [memoryOn, setMemoryOn] = useState<boolean>(() => localStorage.getItem("memoryOn") === "1");
  /** 模型是否支持看图。关：只发「[图片]」占位；开：按多模态格式真发图片（文本模型开了会报错） */
  const [visionOn, setVisionOn] = useState<boolean>(() => localStorage.getItem("visionOn") === "1");
  const [status, setStatus] = useState("");
  const [newName, setNewName] = useState("");
  const [newPersona, setNewPersona] = useState(DEFAULT_PERSONA);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [showStickers, setShowStickers] = useState(false);
  const [stickerBack, setStickerBack] = useState<View>({ kind: "list" });
  const [closeAction, setCloseAction] = useState<"tray" | "exit">("tray");
  const [autostart, setAutostart] = useState(false);
  const [proactive, setProactive] = useState<boolean>(localStorage.getItem("proactive") !== "off");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [msgCount, setMsgCount] = useState(0);
  const [newFact, setNewFact] = useState("");
  const desktop = typeof window !== "undefined" && (window as any).dafeiyu?.isDesktop === true;
  const listRef = useRef<HTMLDivElement>(null);

  const current = view.kind === "list" || view.kind === "new" || view.kind === "stickers"
    ? null
    : chars.find((c) => c.id === view.id) ?? null;

  async function refreshList() {
    let all = await db.characters.toArray();
    if (!all.length && SEED_CHARACTER.name) {
      // 首次启动：仅自用构建预置角色
      await db.characters.put({
        id: "seed_char",
        name: SEED_CHARACTER.name,
        persona: SEED_CHARACTER.persona,
        createdAt: Date.now(),
      } as Character);
      all = await db.characters.toArray();
    }
    setChars(all.sort((a, b) => b.createdAt - a.createdAt));
    const map: Record<string, string> = {};
    for (const c of all) {
      const last = await db.messages.where("characterId").equals(c.id).reverse().first();
      map[c.id] = last ? (last.image && !last.content ? "[图片]" : last.content) : "还没有聊过";
    }
    setLastMsg(map);
  }

  useEffect(() => {
    document.title = APP_TITLE;
    // 数据库体检：曾出现过「异常关闭 → IndexedDB 损坏 → 角色列表变空」，
    // 这里主动检测，坏了就提示重建（重建后同步会把数据拉回来）
    db.open().catch(() => {
      if (confirm("本地数据库损坏（通常是异常关闭/强杀进程导致）。\n\n是否重建？重建后本机聊天记录会被清空。")) {
        resetDb().then(() => location.reload());
      }
    });
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    refreshList();
    loadStickers();
    // 启动时静默同步一次，把另一台设备的内容拉回来
    if (IS_PERSONAL) setTimeout(() => { doSync(true); }, 2000);
    if (desktop) {
      (window as any).dafeiyu.getConfig().then((c: any) => { if (c?.closeAction) setCloseAction(c.closeAction); });
      (window as any).dafeiyu.getAutostart?.().then((s: any) => setAutostart(!!s?.enabled));
    }
  }, []);

  // 切到后台（手机按 Home / 锁屏）时补一次同步，避免刚说的话没上传
  useEffect(() => {
    if (!IS_PERSONAL) return;
    const onHide = () => { if (document.hidden) doSync(true); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  // 主动消息：超过 3 小时没聊，她自己找一句
  useEffect(() => {
    if (!proactive) return;
    const timer = setInterval(async () => {
      if (!provider.apiKey || document.hidden) return;
      const cs = await db.characters.toArray();
      for (const c of cs) {
        const last = await db.messages.where("characterId").equals(c.id).reverse().first();
        if (!last) continue;
        if (Date.now() - last.ts < 3 * 60 * 60 * 1000) continue;
        try {
          const ctx = await buildContext(c.id, DEFAULT_MEMORY);
          const system = [c.persona, renderMemoryBlock(ctx, { longTerm: memoryOn })].filter(Boolean).join("\n\n");
          const reply = await chat(provider, [
            { role: "system", content: system },
            { role: "user", content: "（已经好几个小时没说话了。你主动冒个泡，一句话，别问「在吗」，像想起什么随口说一句。）" },
          ], { temperature: 1.1 });
          if (reply) {
            await appendMessage(c.id, "assistant", reply);
            if ("Notification" in window && Notification.permission === "granted") new Notification(c.name, { body: reply.slice(0, 100) });
          }
        } catch {}
      }
    }, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [proactive, provider.apiKey]);

  async function loadStickers() {
    setStickers(await db.stickers.orderBy("ts").reverse().toArray());
  }

  async function addStickers() {
    const file = await pickImage();
    if (!file) return;
    const data = await compressImage(file, 360, 0.9);
    await db.stickers.add({ data, ts: Date.now() });
    await loadStickers();
  }

  async function batchAddStickers() {
    const files = await pickImages();
    if (!files.length) return;
    setStatus(`导入 ${files.length} 张…`);
    let ok = 0;
    for (const f of files) {
      try {
        const data = await compressImage(f, 360, 0.9);
        await db.stickers.add({ data, ts: Date.now() });
        ok++;
      } catch {}
    }
    await loadStickers();
    setStatus(`已导入 ${ok}/${files.length} 张表情`);
  }

  async function removeSticker(s: Sticker) {
    if (!s.id) return;
    if (!confirm("删掉这张表情？")) return;
    await db.stickers.delete(s.id);
    await loadStickers();
  }

  async function sendSticker(s: Sticker) {
    if (!current || busy) return;
    setShowStickers(false);
    setBusy(true);
    await appendMessage(current.id, "user", "[表情]", s.data);
    setMsgs((m) => [...m, { characterId: current.id, role: "user", content: "[表情]", image: s.data, ts: Date.now() }]);
    try {
      const ctx = await buildContext(current.id, DEFAULT_MEMORY);
      const system = [current.persona, renderMemoryBlock(ctx, { longTerm: memoryOn })].filter(Boolean).join("\n\n");
      const history = ctx.recent.map((m) => ({ role: m.role, content: m.content }));
      const reply = await chat(provider, [{ role: "system", content: system }, ...history, { role: "user", content: "[发了一个表情]" }], { temperature: 1.05 });
      const finalText = reply || "……";
      await appendMessage(current.id, "assistant", finalText);
      setMsgs((m) => [...m, { characterId: current.id, role: "assistant", content: finalText, ts: Date.now() }]);
    } catch (e) {
      setStatus(String(e).slice(0, 120));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (view.kind !== "chat") return;
    (async () => {
      const rows = await db.messages.where("characterId").equals(view.id).sortBy("ts");
      setMsgs(rows);
    })();
  }, [view]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  async function loadMemory(id: string) {
    const fs = await db.facts.where("characterId").equals(id).sortBy("ts");
    const sum = await db.summaries.get(id);
    const total = await db.messages.where("characterId").equals(id).count();
    setFacts(fs);
    setSummary(sum ?? null);
    setMsgCount(total);
  }

  useEffect(() => {
    if (view.kind === "memory") loadMemory(view.id);
  }, [view]);

  async function addFact() {
    if (!current) return;
    const t = newFact.trim();
    if (!t) return;
    await rememberFact(current.id, t);
    setNewFact("");
    await loadMemory(current.id);
  }

  async function delFact(f: Fact) {
    if (!current || !f.id) return;
    await db.facts.delete(f.id);
    await loadMemory(current.id);
  }

  async function clearSummary() {
    if (!current) return;
    if (!confirm("清空滚动摘要？之后的对话会重新开始积累。")) return;
    await db.summaries.delete(current.id);
    await loadMemory(current.id);
  }

  async function createNew() {
    const name = newName.trim() || "新角色";
    const c: Character = {
      id: `char_${Date.now().toString(36)}`,
      name,
      persona: newPersona.trim() || DEFAULT_PERSONA,
      createdAt: Date.now(),
    };
    await db.characters.put(c);
    await refreshList();
    setNewName("");
    setNewPersona(DEFAULT_PERSONA);
    setView({ kind: "chat", id: c.id });
  }

  async function attach() {
    const file = await pickImage();
    if (!file) return;
    setPending(await compressImage(file, 1280, 0.85));
  }

  async function send() {
    if ((!input.trim() && !pending) || busy || !current) return;
    if (!provider.apiKey && !isLocalUrl(provider.baseUrl) && !TEST_MODE) {
      setStatus("先点右上角设置填 Key");
      setView({ kind: "settings", id: current.id });
      return;
    }
    const text = input.trim();
    const image = pending ?? undefined;
    setInput("");
    setPending(null);
    setBusy(true);
    const content = text || "[图片]";
    await appendMessage(current.id, "user", content, image);
    setMsgs((m) => [...m, { characterId: current.id, role: "user", content, image, ts: Date.now() }]);

    if (/^(记住|记一下|别忘了|记着)/.test(text)) {
      await rememberFact(current.id, text.replace(/^(记住|记一下|别忘了|记着)[：:，,\s]*/, ""));
    }

    try {
      const ctx = await buildContext(current.id, DEFAULT_MEMORY);
      const system = [current.persona, renderMemoryBlock(ctx, { longTerm: memoryOn })].filter(Boolean).join("\n\n");

      // 检索/网页资料不塞 system prompt，而是拼进「最后一条用户消息」。
      // 7B 模型对 system 里的长资料基本无视，但对上一条用户消息反应明显。
      let injected = "";
      const linkedUrl = IS_PERSONAL ? extractUrl(text) : null;
      if (linkedUrl) {
        setStatus("抓取网页正文…");
        const page = await fetchPage(resolveSearchBase(desktop, provider.baseUrl), linkedUrl);
        injected = renderPageBlock(page);
        setStatus(page && !page.error ? `已读完：${(page.title || linkedUrl).slice(0, 24)}` : "这个网页抓不到，已如实告诉她");
      } else if (IS_PERSONAL && searchMode !== "off" && (searchMode === "always" || shouldSearch(text))) {
        const query = cleanQuery(text);
        setStatus("联网检索中…");
        const hits = await searchWeb(resolveSearchBase(desktop, provider.baseUrl), query);
        if (hits.length) {
          injected = renderSearchBlock(query, hits);
          setStatus(`查到 ${hits.length} 条资料`);
        } else {
          setStatus("没检索到结果，按已有对话回答");
        }
      }

      // 注意：ctx.recent 里**已经包含**刚发出去的这条用户消息，
      // 所以不能再 push 一次（旧代码就是这么干的，等于把问题问了两遍）
      const history = ctx.recent.map((m) => ({ role: m.role, content: m.content })) as { role: "user" | "assistant"; content: string; images?: string[] }[];
      // 开了「支持看图」才把图片真发给模型；否则只发文字占位
      if (visionOn && image) {
        const lastM = history[history.length - 1];
        if (lastM && lastM.role === "user") lastM.images = [image];
      }

      // 两段式：资料太长，7B 会整段照抄。先让模型只用资料提炼一句结论，
      // 再把这一句塞进 system（短句它不会复述），最后由角色用自己的语气说话。
      const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
      let finalSystem = system + `\n\n【今天是】${today}（模型的知识可能停在更早，涉及新闻/现状时要靠检索资料判断）`;
      // 搜索结果：直接给几句带日期的原文，不再让模型二次总结（7B 一总结就张冠李戴）。
      // 网页正文：太长，还是先提炼一句，否则它会整段抄。
      if (injected && linkedUrl) {
        let brief = "";
        try {
          brief = await chat(
            provider,
            [
              { role: "system", content: `你是信息提取器。今天是 ${today}。只依据给定资料回答，不展开、不复述原文、不列来源清单。` },
              { role: "user", content: `${injected}\n\n【问题】${text}\n\n只用一两句话给出结论（60 字内），优先采用日期最新的资料。资料里没有就回答「资料没有提到」。` },
            ],
            { temperature: 0.2, maxTokens: 200 }
          );
        } catch {}
        if (brief) {
          finalSystem +=
            `\n\n【你刚查到的情况】${brief}\n` +
            `（用你自己的语气自然带出来，别照抄上面的文字，别列来源链接）\n` +
            `【重要】主人刚才的说法可能是错的。如果和你查到的冲突，直接指出他哪里说得不对，` +
            `不要为了顺着他就改口、不要顺着他的定义往下接。拿不准就说拿不准，不要附和。`;
        }
      } else if (injected) {
        finalSystem += "\n\n" + injected;
      }

      const reply = await chat(provider, [{ role: "system", content: finalSystem }, ...history], {
        temperature: sampling.temperature,
        topP: sampling.topP,
        maxTokens: sampling.maxTokens,
      });
      const finalText = stripInjected(reply) || "……";
      await appendMessage(current.id, "assistant", finalText);
      setMsgs((m) => [...m, { characterId: current.id, role: "assistant", content: finalText, ts: Date.now() }]);
      await maybeRollSummary(current.id, async (p) => chat(provider, [{ role: "user", content: p }], { temperature: 0.3, maxTokens: 900 }));
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification(current.name, { body: finalText.slice(0, 120) });
      }
      refreshList();
      // 每说一句就静默同步，否则另一台设备要等下次启动才看得到
      if (IS_PERSONAL) doSync(true);
    } catch (e) {
      setStatus(String(e).slice(0, 140));
    } finally {
      setBusy(false);
    }
  }

  function updateSampling(patch: Partial<Sampling>) {
    const next = { ...sampling, ...patch };
    setSampling(next);
    localStorage.setItem("sampling", JSON.stringify(next));
  }

  function updateSearchMode(mode: SearchMode) {
    setSearchMode(mode);
    localStorage.setItem("searchMode", mode);
  }

  /** 记忆同步：把本地推到电脑，再把并集拉回来 */
  async function doSync(silent = false) {
    if (!IS_PERSONAL) return;
    const base = resolveSearchBase(desktop, provider.baseUrl);
    if (!silent) setStatus("同步中…");
    try {
      const r = await syncWith(base);
      await refreshList();
      if (!silent) setStatus(r.pulled > 0 ? `同步完成，拉回 ${r.pulled} 条` : "同步完成，没有新内容");
    } catch (e) {
      if (!silent) setStatus("同步失败：" + String(e).slice(0, 60));
    }
  }

  async function saveProvider() {
    localStorage.setItem("provider", JSON.stringify(draft));
    setProvider(draft);
    setStatus("已保存");
  }

  async function checkProvider() {
    setStatus("测试中…");
    try {
      await testConnection(draft);
      setStatus("连接正常 ✓");
    } catch (e) {
      setStatus("失败：" + String(e).slice(0, 100));
    }
  }

  async function setAvatar() {
    const f = await pickImage();
    if (!f || !current) return;
    const data = await compressImage(f, 256, 0.9);
    const next = { ...current, avatar: data };
    await db.characters.put(next);
    await refreshList();
  }

  async function setBackground() {
    const f = await pickImage();
    if (!f || !current) return;
    const data = await compressImage(f, 1080, 0.8);
    const next = { ...current, background: data };
    await db.characters.put(next);
    await refreshList();
  }

  // ---- 外观：我的头像 / 头像挂饰 / 气泡颜色 ----

  async function changeMyAvatar() {
    const f = await pickImage();
    if (!f) return;
    const data = await compressImage(f, 256, 0.9);
    setMeAvatar(data);
    localStorage.setItem("meAvatar", data);
    setStatus("我的头像已更新");
  }

  async function changeMyFrame() {
    const f = await pickImage();
    if (!f) return;
    const data = await compressImage(f, 320, 0.9, true);  // 保留透明
    setMeFrame(data);
    localStorage.setItem("meFrame", data);
    setStatus("我的头像挂饰已更新");
  }

  function removeMyFrame() {
    setMeFrame("");
    localStorage.removeItem("meFrame");
  }

  async function changeCharFrame() {
    if (!current) return;
    const f = await pickImage();
    if (!f) return;
    const data = await compressImage(f, 320, 0.9, true);
    await db.characters.put({ ...current, frame: data });
    await refreshList();
    setStatus("她的头像挂饰已更新");
  }

  async function removeCharFrame() {
    if (!current) return;
    await db.characters.put({ ...current, frame: undefined });
    await refreshList();
  }

  function applyBubbleStyle(s: BubbleStyle) {
    setBubbleStyle(s);
    localStorage.setItem("bubbleStyle", JSON.stringify(s));
  }

  function patchBubble(p: Partial<BubbleStyle>) {
    applyBubbleStyle({ ...bubbleStyle, ...p });
  }

  function setFramePos(who: "me" | "char", pos: "outer" | "corner") {
    if (who === "me") {
      setMeFramePos(pos);
      localStorage.setItem("meFramePos", pos);
    } else {
      setCharFramePos(pos);
      localStorage.setItem("charFramePos", pos);
    }
  }

  async function renameCurrent() {
    if (!current) return;
    const name = prompt("改名字", current.name);
    if (!name) return;
    const next = { ...current, name: name.trim() || current.name };
    await db.characters.put(next);
    await refreshList();
  }

  async function removeCurrent() {
    if (!current) return;
    if (!confirm(`删除「${current.name}」和它的全部聊天记录？`)) return;
    await db.messages.where("characterId").equals(current.id).delete();
    await db.facts.where("characterId").equals(current.id).delete();
    await db.summaries.delete(current.id);
    await db.characters.delete(current.id);
    await refreshList();
    setView({ kind: "list" });
  }

  async function toggleAutostart() {
    const next = !autostart;
    try {
      const r = await (window as any).dafeiyu.setAutostart(next);
      setAutostart(!!r?.enabled);
      setStatus(r?.enabled ? "已设为开机自启" : "已取消开机自启");
    } catch (e) {
      setStatus("设置失败：" + String(e).slice(0, 80));
    }
  }

  async function exportData() {
    if (!current) return;
    const data = await exportCharacter(current.id);
    const text = JSON.stringify(data);
    try {
      if (desktop) await (window as any).dafeiyu.copyText(text);
      else await navigator.clipboard.writeText(text);
      setStatus(`已复制备份（${Math.round(text.length / 1024)} KB）`);
    } catch (e) {
      setStatus("复制失败：" + String(e).slice(0, 60));
    }
  }

  async function importData() {
    try {
      const text = desktop ? await (window as any).dafeiyu.readText() : await navigator.clipboard.readText();
      const data = JSON.parse(text);
      if (!data?.character) throw new Error("格式不对");
      await db.characters.put(data.character);
      for (const m of data.messages ?? []) {
        await db.messages.add({ characterId: data.character.id, role: m.role, content: m.content, image: m.image, ts: m.ts });
      }
      for (const f of data.facts ?? []) {
        await db.facts.add({ characterId: data.character.id, text: f.text, ts: f.ts });
      }
      if (data.summary) await db.summaries.put(data.summary);
      await refreshList();
      setStatus("导入完成");
    } catch (e) {
      setStatus("导入失败：" + String(e).slice(0, 80));
    }
  }

  if (IS_PERSONAL && !ageOk) {
    return (
      <div className="page">
        <div className="topbar"><div className="title">{APP_TITLE}</div></div>
        <div className="settings">
          <h3>18+ 确认</h3>
          <div className="hint">
            这个版本连的是你自己的模型，不经过任何平台审核。内容边界由你和你选的权重决定，出了事也由你自己负责。
          </div>
          <div className="hint">确认你已年满 18 周岁，且使用方式不违反所在地法律。涉及未成年人的内容在任何地方都是刑事红线。</div>
          <div className="row-btns">
            <button onClick={() => { localStorage.setItem("ageOk", "1"); setAgeOk(true); }}>我已成年，继续</button>
          </div>
        </div>
      </div>
    );
  }

  if (view.kind === "new") {
    return (
      <div className="page">
        <div className="topbar"><div className="back" onClick={() => setView({ kind: "list" })}>←</div><div className="title">新角色</div></div>
        <div className="settings">
          <h3>名字</h3>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="比如：大肥鱼2号" />
          <h3>人格（她的性格、说话方式）</h3>
          <textarea className="persona-box" value={newPersona} onChange={(e) => setNewPersona(e.target.value)} />
          <div className="row-btns"><button onClick={createNew}>创建</button></div>
        </div>
      </div>
    );
  }

  if (view.kind === "stickers") {
    return (
      <div className="page">
        <div className="topbar">
          <div className="back" onClick={() => setView(stickerBack)}>←</div>
          <div className="title">表情包</div>
          <div className="gear" onClick={batchAddStickers}>导入</div>
        </div>
        <div className="settings">
          <div className="hint">可以一次选多张。图片压到 360px 存在本机，不联网。点右上角 × 删除。</div>
          <div className="sticker-manage">
            {stickers.map((s) => (
              <div className="sticker-cell" key={s.id}>
                <img src={s.data} alt="" onClick={() => removeSticker(s)} />
                <div className="sticker-del" onClick={() => removeSticker(s)}>×</div>
              </div>
            ))}
            <div className="sticker-add" onClick={batchAddStickers}>＋</div>
          </div>
          {!stickers.length && <div className="hint" style={{ marginTop: 10 }}>还没有表情，点 ＋ 导入。</div>}
          {status && <div className="hint" style={{ marginTop: 16 }}>{status}</div>}
        </div>
      </div>
    );
  }

  if (view.kind === "memory" && current) {
    return (
      <div className="page">
        <div className="topbar"><div className="back" onClick={() => setView({ kind: "settings", id: current.id })}>←</div><div className="title">记忆</div></div>
        <div className="settings">
          <div className="hint">共 {msgCount} 条消息 · 事实 {facts.length}/{DEFAULT_MEMORY.factMax} 条 · 摘要 {summary?.text.length ?? 0}/{DEFAULT_MEMORY.summaryMaxChars} 字</div>

          <h3>长期事实（她会一直记得）</h3>
          <div className="row-btns">
            <input
              style={{ flex: "1 1 auto", width: "auto", marginBottom: 0 }}
              value={newFact}
              onChange={(e) => setNewFact(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addFact(); }}
              placeholder="比如：喜欢猫，养了一只叫年糕"
            />
            <button onClick={addFact}>添加</button>
          </div>
          {facts.map((f) => (
            <div className="fact" key={f.id}>
              <span>{f.text}</span>
              <button className="mini danger" onClick={() => delFact(f)}>删</button>
            </div>
          ))}
          {!facts.length && <div className="hint">还没有事实。聊天时说「记住 xxx」也会写进来。</div>}

          <h3>滚动摘要</h3>
          {summary ? (
            <>
              <textarea className="persona-box summary-box" readOnly value={summary.text} />
              <div className="hint">覆盖前 {summary.summarizedCount} 条 · {new Date(summary.updatedAt).toLocaleString("zh-CN")}</div>
              <div className="row-btns"><button className="danger" onClick={clearSummary}>清空摘要</button></div>
            </>
          ) : (
            <div className="hint">还没生成。聊满 {DEFAULT_MEMORY.summaryBatch} 条会自动压缩成摘要，之后只带摘要 + 最近 {DEFAULT_MEMORY.recentCount} 条进上下文。</div>
          )}

          <h3>说明</h3>
          <div className="hint">
            这些内容只保存在本机 IndexedDB 里，不会上传到除你填的模型接口之外的任何地方。
            删掉事实或摘要后，她下一次回复就不记得了。
          </div>
        </div>
      </div>
    );
  }

  if (view.kind === "settings" && current) {
    const activePreset = PRESETS.find((p) => p.baseUrl === draft.baseUrl);
    return (
      <div className="page">
        <div className="topbar"><div className="back" onClick={() => setView({ kind: "chat", id: current.id })}>←</div><div className="title">设置</div></div>
        <div className="settings">
          <h3>服务商</h3>
          <div className="chips">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                className={"chip" + (activePreset?.name === p.name ? " on" : "")}
                onClick={() => setDraft({ ...draft, baseUrl: p.baseUrl, model: p.model })}
              >
                {p.name}
              </button>
            ))}
          </div>
          <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="Base URL（以 /v1 结尾）" />
          <input value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder="API Key" type="password" />
          <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="模型名" />
          {activePreset && (
            <div className="chips">
              {activePreset.models.map((m) => (
                <button key={m} className={"chip small" + (draft.model === m ? " on" : "")} onClick={() => setDraft({ ...draft, model: m })}>{m}</button>
              ))}
            </div>
          )}
          <div className="row-btns"><button onClick={checkProvider}>测试连接</button><button onClick={saveProvider}>保存</button></div>
          <div className="hint">Key 只存在这台设备（localStorage），不会写进导出备份。</div>

          <div className="row-btns">
            <button
              style={visionOn ? { background: "#dbe4ff" } : undefined}
              onClick={() => {
                const v = !visionOn;
                setVisionOn(v);
                localStorage.setItem("visionOn", v ? "1" : "0");
              }}
            >
              {visionOn ? "✓ " : ""}模型支持看图
            </button>
          </div>
          <div className="hint">
            打开后才会把图片真正发给模型。DeepSeek、Qwen 文本版这类没有视觉能力，开了会报错；
            用 GPT-4o、通义 qwen-vl、Qwen2.5-VL 这种才需要打开。
          </div>

          {IS_PERSONAL && (
            <>
              <h3>采样参数</h3>
              <div className="hint">本地模型靠这三个数活命：temperature 0.8–1.0 有活人味，top_p 0.9–0.95 防止胡说，max_tokens 决定她一次能说多长。</div>
              <input type="number" step="0.05" min="0" max="2" value={sampling.temperature} onChange={(e) => updateSampling({ temperature: Number(e.target.value) })} placeholder="temperature" />
              <input type="number" step="0.05" min="0" max="1" value={sampling.topP} onChange={(e) => updateSampling({ topP: Number(e.target.value) })} placeholder="top_p" />
              <input type="number" step="50" min="100" max="4000" value={sampling.maxTokens} onChange={(e) => updateSampling({ maxTokens: Number(e.target.value) })} placeholder="max_tokens" />
              <div className="row-btns">
                <button onClick={() => updateSampling(DEFAULT_SAMPLING)}>恢复默认</button>
              </div>

              <h3>联网搜索</h3>
              <div className="row-btns">
                <button style={searchMode === "off" ? { background: "#dbe4ff" } : undefined} onClick={() => updateSearchMode("off")}>
                  {searchMode === "off" ? "✓ " : ""}关闭
                </button>
                <button style={searchMode === "auto" ? { background: "#dbe4ff" } : undefined} onClick={() => updateSearchMode("auto")}>
                  {searchMode === "auto" ? "✓ " : ""}需要时查
                </button>
                <button style={searchMode === "always" ? { background: "#dbe4ff" } : undefined} onClick={() => updateSearchMode("always")}>
                  {searchMode === "always" ? "✓ " : ""}每句都查
                </button>
              </div>
              <div className="hint">
                搜索由电脑代查：国内站直连，Google 等走电脑的 VPN。所以手机只要能访问这台电脑，不必额外配置代理也能查到境外内容。
                想强制查一次，发「/搜 关键词」。
              </div>
              <div className="hint">
                手机上连电脑：地址填 «http://电脑内网IP:11434/v1»（不是 127.0.0.1），并且要在 Ollama 那台机器上设
                OLLAMA_HOST=0.0.0.0。手机若开着 VPN，记得在 Hiddify 里打开「绕过局域网」，否则连不上家里的模型。
              </div>
            </>
          )}

          <h3>角色 · {current.name}</h3>
          <div className="row-btns">
            <button onClick={setAvatar}>换头像</button>
            <button onClick={setBackground}>换背景</button>
            <button onClick={renameCurrent}>改名</button>
          </div>
          {current.background && (
            <div className="hint" onClick={async () => { const next = { ...current, background: undefined }; await db.characters.put(next); await refreshList(); }}>清除背景</div>
          )}

          <h3>记忆</h3>
          <div className="row-btns">
            <button
              style={memoryOn ? { background: "#dbe4ff" } : undefined}
              onClick={() => {
                const v = !memoryOn;
                setMemoryOn(v);
                localStorage.setItem("memoryOn", v ? "1" : "0");
              }}
            >
              {memoryOn ? "✓ " : ""}长期记忆（事实 + 摘要）
            </button>
            <button onClick={() => setView({ kind: "memory", id: current.id })}>记忆管理</button>
            <button onClick={async () => { await db.summaries.delete(current.id); setStatus("摘要已清空"); }}>清空摘要</button>
          </div>
          <div className="hint">
            关掉后只带最近 20 条原文，不注入「记住过的事」和摘要——上下文干净，模型不容易被带偏；代价是更早的事就真的忘了。
          </div>

          <h3>表情包</h3>
          <div className="row-btns">
            <button onClick={() => { setStickerBack({ kind: "settings", id: current.id }); setView({ kind: "stickers" }); }}>管理表情（{stickers.length} 张）</button>
          </div>

          <h3>应用</h3>
          {desktop && (
            <>
              <div className="row-btns">
                <button
                  style={closeAction === "tray" ? { background: "#dbe4ff" } : undefined}
                  onClick={() => { setCloseAction("tray"); (window as any).dafeiyu.setConfig({ closeAction: "tray" }); }}
                >
                  {closeAction === "tray" ? "✓ " : ""}关闭时缩到托盘
                </button>
                <button
                  style={closeAction === "exit" ? { background: "#dbe4ff" } : undefined}
                  onClick={() => { setCloseAction("exit"); (window as any).dafeiyu.setConfig({ closeAction: "exit" }); }}
                >
                  {closeAction === "exit" ? "✓ " : ""}关闭时直接退出
                </button>
              </div>
              <div className="row-btns">
                <button style={autostart ? { background: "#dbe4ff" } : undefined} onClick={toggleAutostart}>
                  {autostart ? "✓ " : ""}开机自启
                </button>
              </div>
            </>
          )}
          <div className="row-btns">
            <button
              style={proactive ? { background: "#dbe4ff" } : undefined}
              onClick={() => { const v = !proactive; setProactive(v); localStorage.setItem("proactive", v ? "on" : "off"); }}
            >
              {proactive ? "✓ " : ""}她会主动找你（3 小时没聊时）
            </button>
          </div>

          {IS_PERSONAL && (<>
          <h3>外观</h3>
          <div className="row-btns">
            <button onClick={changeMyAvatar}>我的头像</button>
            <button onClick={changeMyFrame}>我的挂饰</button>
            {meFrame && <button onClick={removeMyFrame}>清除我的挂饰</button>}
          </div>
          <div className="row-btns">
            <button onClick={changeCharFrame}>她的挂饰</button>
            {current.frame && <button onClick={removeCharFrame}>清除她的挂饰</button>}
          </div>
          <div className="hint">挂饰用透明 PNG，会叠在头像上。位置可以选「贴角落」或「外圈」。</div>
          <div className="row-btns">
            <span className="hint">我的挂饰：</span>
            <button
              style={meFramePos === "corner" ? { background: "#dbe4ff" } : undefined}
              onClick={() => setFramePos("me", "corner")}
            >贴角落</button>
            <button
              style={meFramePos === "outer" ? { background: "#dbe4ff" } : undefined}
              onClick={() => setFramePos("me", "outer")}
            >外圈</button>
          </div>
          <div className="row-btns">
            <span className="hint">她的挂饰：</span>
            <button
              style={charFramePos === "corner" ? { background: "#dbe4ff" } : undefined}
              onClick={() => setFramePos("char", "corner")}
            >贴角落</button>
            <button
              style={charFramePos === "outer" ? { background: "#dbe4ff" } : undefined}
              onClick={() => setFramePos("char", "outer")}
            >外圈</button>
          </div>

          <div className="hint">气泡样式</div>
          <div className="row-btns" style={{ flexWrap: "wrap" }}>
            {BUBBLE_PRESETS.map((p) => (
              <button
                key={p.name}
                className={"chip" + (JSON.stringify(bubbleStyle) === JSON.stringify({ ...DEFAULT_BUBBLE_STYLE, ...p.style }) ? " on" : "")}
                onClick={() => applyBubbleStyle({ ...DEFAULT_BUBBLE_STYLE, ...p.style })}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="row-btns">
            <span className="hint">背景</span>
            <input type="color" value={bubbleStyle.bg} onChange={(e) => patchBubble({ bg: e.target.value })} style={{ width: 42, height: 34, border: "none", background: "transparent" }} />
            <span className="hint">边框</span>
            <input type="color" value={bubbleStyle.border === "transparent" ? "#2f4f3f" : bubbleStyle.border} onChange={(e) => patchBubble({ border: e.target.value })} style={{ width: 42, height: 34, border: "none", background: "transparent" }} />
          </div>
          <div className="hint">边框粗细：{bubbleStyle.width}px</div>
          <input type="range" min="0" max="6" step="1" value={bubbleStyle.width} onChange={(e) => patchBubble({ width: Number(e.target.value) })} />
          <div className="hint">圆角：{bubbleStyle.radius}px</div>
          <input type="range" min="0" max="28" step="1" value={bubbleStyle.radius} onChange={(e) => patchBubble({ radius: Number(e.target.value) })} />

          <h3>记忆同步</h3>
          <div className="row-btns">
            <button onClick={() => doSync(false)}>立即同步</button>
          </div>
          <div className="hint">
            以电脑为中心：手机和桌面把各自记录推给电脑，电脑合并后再发回来。启动时会自动同步一次。
            同步地址跟着服务商走：服务商指向远程地址时，同步也走同一条链路。
            注意：删除操作不会同步——在一边删掉的东西，下次同步可能被另一边带回来。
          </div>

          </>)}

          <h3>数据</h3>
          <div className="row-btns">
            <button onClick={exportData}>导出到剪贴板</button>
            <button onClick={importData}>从剪贴板导入</button>
          </div>
          <div className="row-btns"><button onClick={removeCurrent} className="danger">删除这个角色</button></div>

          <div className="hint" style={{ marginTop: 16 }}>{status}</div>
          <div className="hint">{APP_TITLE} v{VERSION}{desktop ? " · Windows" : ""}</div>
        </div>
      </div>
    );
  }

  if (view.kind === "chat" && current) {
    return (
      <div className="page">
        <div className="topbar">
          <div className="back" onClick={() => { setView({ kind: "list" }); refreshList(); }}>←</div>
          <div className="avatar" onClick={() => { setDraft(provider); setView({ kind: "settings", id: current.id }); }}>
            {current.avatar ? <img src={current.avatar} alt="" /> : current.name.slice(0, 1)}
          </div>
          <div className="title">{current.name}</div>
          <div className="gear" onClick={() => { setDraft(provider); setView({ kind: "settings", id: current.id }); }}>设置</div>
        </div>

        <div className="msgs" ref={listRef} style={current.background ? { backgroundImage: `url(${current.background})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
          {msgs.length === 0 && <div className="time-sep">开始聊天吧</div>}
          {msgs.map((m, i) => {
            const prev = msgs[i - 1];
            const showTime = !prev || m.ts - prev.ts > 5 * 60 * 1000;
            return (
              <div key={m.ts + "-" + i}>
                {showTime && <div className="time-sep">{fmtTime(m.ts)}</div>}
                <div
                  className={"row " + (m.role === "user" ? "me" : "")}
                  onContextMenu={async (e) => {
                    e.preventDefault();
                    if (!confirm("删除这条消息？")) return;
                    await db.messages.delete(m.id!);
                    setMsgs((all) => all.filter((x) => x !== m));
                  }}
                >
                  <div className="avatar-wrap">
                    <div className="avatar-sm">
                      {m.role === "user"
                        ? (meAvatar ? <img src={meAvatar} alt="" /> : "我")
                        : (current.avatar ? <img src={current.avatar} alt="" /> : current.name.slice(0, 1))}
                    </div>
                    {(m.role === "user" ? meFrame : current.frame) && (
                      <div className={"frame-ov" + ((m.role === "user" ? meFramePos : charFramePos) === "corner" ? " corner" : "")}>
                        <img src={(m.role === "user" ? meFrame : current.frame) || ""} alt="" />
                      </div>
                    )}
                  </div>
                  <div
                    className="bubble"
                    style={{
                      background: m.role === "user" ? bubbleStyle.bg : "#fff",
                      borderColor: bubbleStyle.border,
                      borderWidth: bubbleStyle.width + "px",
                      borderRadius: bubbleStyle.radius + "px",
                      color: bubbleStyle.text || undefined,
                    } as React.CSSProperties}
                  >
                    {m.image && <img className="bubble-img" src={m.image} alt="" />}
                    {m.content && m.content !== "[图片]" && m.content !== "[表情]" && <div>{m.content}</div>}
                  </div>
                </div>
              </div>
            );
          })}
          {busy && <div className="row"><div className="avatar-sm">…</div><div className="bubble typing">…</div></div>}
        </div>

        {status && <div className="errbar" onClick={() => setStatus("")}>{status}</div>}
        {pending && <div className="preview"><img src={pending} alt="" /><span onClick={() => setPending(null)}>×</span></div>}
        {showStickers && (
          <div className="sticker-panel">
            <div className="sticker-panel-bar">
              <span onClick={() => { setStickerBack({ kind: "chat", id: current.id }); setShowStickers(false); setView({ kind: "stickers" }); }}>管理 / 批量导入</span>
            </div>
            <div className="sticker-grid">
              {stickers.map((s) => (
                <img key={s.id} src={s.data} alt="" onClick={() => sendSticker(s)} />
              ))}
              <div className="sticker-add" onClick={addStickers}>＋</div>
            </div>
          </div>
        )}

        <div className="inputbar">
          <button className="icon" onClick={attach} disabled={busy}>图</button>
          <button className="icon" onClick={() => setShowStickers((v) => !v)}>表</button>
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            placeholder={provider.apiKey || isLocalUrl(provider.baseUrl) ? "说点什么（Enter 发送，Shift+Enter 换行）" : "先设置 API Key"}
          />
          <button disabled={busy || (!input.trim() && !pending)} onClick={send}>发送</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="topbar"><div className="title">{APP_TITLE}</div><div className="gear" onClick={() => setView({ kind: "new" })}>＋</div></div>
      <div className="msgs">
        {chars.length === 0 && (
          <div className="empty">
            <div className="hint">还没有角色</div>
            <div className="row-btns" style={{ justifyContent: "center" }}><button onClick={() => setView({ kind: "new" })}>创建一个</button></div>
          </div>
        )}
        {chars.map((c) => (
          <div key={c.id} className="conv" onClick={() => setView({ kind: "chat", id: c.id })}>
            <div className="avatar-lg">{c.avatar ? <img src={c.avatar} alt="" /> : c.name.slice(0, 1)}</div>
            <div className="conv-body">
              <div className="conv-name">{c.name}</div>
              <div className="conv-last">{lastMsg[c.id] ?? ""}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="inputbar">
        <button style={{ flex: 1 }} onClick={() => setView({ kind: "new" })}>＋ 新建角色</button>
      </div>
    </div>
  );
}
