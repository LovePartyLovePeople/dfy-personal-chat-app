import type { ProviderConfig } from "./types";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
  /** 附带的图片（dataURL）。只有支持视觉的模型才该带，否则服务端会报错 */
  images?: string[];
}

export interface ChatOpts {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
}

/** 有图的消息按 OpenAI 多模态格式拼 content，没图就保持纯字符串 */
function toApiMessage(m: ChatMsg) {
  if (!m.images || !m.images.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: "text", text: m.content }] : []),
      ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  };
}

/** OpenAI 兼容接口调用（DeepSeek / Ollama / 各类中转站都是这个协议） */
export async function chat(cfg: ProviderConfig, messages: ChatMsg[], opts?: ChatOpts) {
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map(toApiMessage),
    temperature: opts?.temperature ?? 1.0,
    max_tokens: opts?.maxTokens ?? 800,
  };
  if (typeof opts?.topP === "number") body.top_p = opts.topP;
  if (typeof opts?.frequencyPenalty === "number") body.frequency_penalty = opts.frequencyPenalty;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey || "none"}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

export async function testConnection(cfg: ProviderConfig) {
  const text = await chat(cfg, [{ role: "user", content: "回复两个字：在的" }], { maxTokens: 20 });
  return text.length > 0;
}
