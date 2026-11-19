import Dexie, { type Table } from "dexie";
import type { Character, Message, Fact, Summary, Sticker } from "./types";

export class AppDB extends Dexie {
  characters!: Table<Character, string>;
  messages!: Table<Message, number>;
  facts!: Table<Fact, number>;
  summaries!: Table<Summary, string>;
  settings!: Table<{ key: string; value: unknown }, string>;
  stickers!: Table<Sticker, number>;

  constructor() {
    super("dafeiyu");
    this.version(1).stores({
      characters: "id, name, createdAt",
      messages: "++id, characterId, ts, [characterId+ts]",
      facts: "++id, characterId, ts",
      summaries: "characterId",
      settings: "key",
    });
    this.version(2).stores({
      stickers: "++id, ts",
    });
  }
}

export const db = new AppDB();

/** 数据库损坏时用：关掉连接并整个删除（下次打开会是空库，随后靠同步把数据拉回来） */
export async function resetDb() {
  try { db.close(); } catch {}
  await Dexie.delete("dafeiyu");
}