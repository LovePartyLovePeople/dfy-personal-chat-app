/**
 * 联网检索：不在手机/浏览器里直接查，而是交给跑在电脑上的 /__search 接口代查。
 * 这样手机上只要连得到电脑（局域网或私有网段），不额外配代理也能查到境外内容。
 */

export type SearchHit = { title: string; url: string; snippet: string; date?: string };

/** off = 不联网；auto = 需要时自动查；always = 每句话都查 */
export type SearchMode = "off" | "auto" | "always";

export const DEFAULT_SEARCH_MODE: SearchMode = "auto";

/** 电脑端搜索口的端口，跟特供版桌面端固定端口一致 */
const DESKTOP_PORT = 51790;

/** 桌面端同源调用；安卓端从模型地址推出电脑地址 */
export function resolveSearchBase(isDesktop: boolean, providerBaseUrl: string): string {
  if (isDesktop) {
    return typeof location !== "undefined" ? location.origin : "";
  }
  try {
    const u = new URL(providerBaseUrl);
    return `${u.protocol}//${u.hostname}:${DESKTOP_PORT}`;
  } catch {
    return "";
  }
}

export async function searchWeb(base: string, query: string, timeoutMs = 12000): Promise<SearchHit[]> {
  if (!base || !query.trim()) return [];
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${base}/__search?q=${encodeURIComponent(query)}`, {
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 判断这句话要不要联网：显式要求查，或者问的是有时效性的内容 */
export function shouldSearch(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\/搜\s*/.test(t)) return true;
  if (/(查一下|查查|搜一下|搜搜|搜索一下|帮我查|帮我搜|去查|查下)/.test(t)) return true;
  if (/(今天|昨天|明天|现在|最新|最近|今年|本月|新闻|天气|股价|汇率|多少钱|价格|几点|发生了|夺冠|比分)/.test(t)) return true;
  if (/https?:\/\/\S+/.test(t)) return true;
  return false;
}

/** 消息里带的第一个链接（去掉尾部标点） */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s，。；、）)】"']+/);
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null;
}

export type PageContent = { url: string; title: string; text: string; truncated?: boolean; error?: string };

/** 抓网页正文（同样由电脑代抓，手机不需要能翻墙） */
export async function fetchPage(base: string, url: string, timeoutMs = 25000): Promise<PageContent | null> {
  if (!base || !url) return null;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${base}/__fetch?url=${encodeURIComponent(url)}`, {
      signal: ctl ? ctl.signal : undefined,
    });
    const data: any = await res.json();
    if (!res.ok) return { url, title: "", text: "", error: String(data?.error || `HTTP ${res.status}`) };
    return data as PageContent;
  } catch (e) {
    return { url, title: "", text: "", error: String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把网页正文渲染成参考资料 */
export function renderPageBlock(page: PageContent | null): string {
  if (!page || page.error) {
    return `【网页抓取失败】${page?.url ?? ""} —— ${page?.error ?? "未知错误"}。如果用户想看这个链接，直接说明抓不到，不要编造里面的内容。`;
  }
  return (
    `【用户贴的网页正文】标题：${page.title || "(无标题)"}\n地址：${page.url}\n\n` +
    page.text +
    (page.truncated ? "\n\n（正文过长，已截断）" : "") +
    `\n\n用法要求：基于这篇正文回答，不要编造正文里没有的内容；正文没提到就明说没提到。`
  );
}


/** 把用户那句话清洗成适合搜索的查询串（去掉语气词和客套，避免整句丢给搜索引擎） */
export function cleanQuery(text: string): string {
  return text
    .replace(/^\/搜\s*/, "")
    .replace(/[，。！？、；：""''（）()【】\[\]…~～]/g, " ")
    .replace(/^(请|麻烦|帮我|能不能|可以|你|我想?|想问|问一下|搜一下|查一下|看一下)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** 把检索结果渲染成可以塞进 system prompt 的参考资料 */
/** 从摘要里挑一句最贴题的原句（代码来做，别指望 7B 总结） */
function pickQuote(snippet: string, query: string): string {
  const sents = String(snippet || "")
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 6);
  const toks = query.split(/\s+/).filter((t) => t.length >= 2);
  const hit = sents.find((s) => toks.some((t) => s.includes(t)));
  return (hit || sents[0] || snippet || "").slice(0, 110);
}

/** 把检索结果渲染成可以塞进 system prompt 的参考资料（短、带日期、基本是原话） */
export function renderSearchBlock(query: string, hits: SearchHit[]): string {
  if (!hits.length) return "";
  const top = hits.slice(0, 3);
  const lines = top.map((h, i) => {
    const when = h.date ? `[${h.date}] ` : "";
    return `${i + 1}. ${when}${h.title.slice(0, 46)}\n   原句：${pickQuote(h.snippet, query)}`;
  });
  return (
    `【联网查到的原文】\n` + lines.join("\n") +
    `\n\n要求：只用上面几句原话说事；没提到的就说「没查到」；不要替主人补细节，也不要因为主人坚持就改口。`
  );
}
