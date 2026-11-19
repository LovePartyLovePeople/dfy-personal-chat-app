// 写入版本标记：electron/edition.json
// vite.config.ts 和 electron/main.cjs 都读它，保证渲染进程和主进程对「这是哪个版本」的认知一致。
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const edition = process.argv[2] === "personal" ? "personal" : "public";
const target = join(process.cwd(), "electron", "edition.json");
writeFileSync(target, JSON.stringify({ edition }, null, 2) + "\n", "utf8");
console.log(`[edition] ${edition} -> electron/edition.json`);