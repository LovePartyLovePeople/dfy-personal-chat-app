export type Role = "user" | "assistant";

export interface Character {
  id: string;
  name: string;
  avatar?: string;      // dataUrl 或本地路径
  persona: string;      // 人格提示词
  background?: string;  // 聊天背景
  frame?: string;       // 头像挂饰（透明 PNG，叠在头像外围）
  createdAt: number;
}

export interface Message {
  id?: number;
  characterId: string;
  role: Role;
  content: string;
  image?: string;   // dataURL，用户发的图
  ts: number;
}

export interface Fact {
  id?: number;
  characterId: string;
  text: string;
  ts: number;
}

export interface Summary {
  characterId: string;
  text: string;
  summarizedCount: number;
  updatedAt: number;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface MemoryConfig {
  recentCount: number;    // 注入最近多少条原文
  summaryBatch: number;   // 每积累多少条触发一次摘要
  summaryMaxChars: number;
  factMax: number;        // 最多保留多少条事实
}

export const DEFAULT_MEMORY: MemoryConfig = {
  recentCount: 20,
  summaryBatch: 40,
  summaryMaxChars: 1200,
  factMax: 80,
};
export interface Sticker {
  id?: number;
  data: string;   // dataURL
  ts: number;
}