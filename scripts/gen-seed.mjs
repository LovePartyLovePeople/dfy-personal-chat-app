import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const flavor = process.argv[2] === "personal" ? "personal" : "public";
const src = join(process.cwd(), "src");
const target = join(src, "seed.ts");
const personal = join(src, "seed.personal.ts");

if (flavor === "personal") {
  if (!existsSync(personal)) {
    console.error("缺少 src/seed.personal.ts");
    process.exit(1);
  }
  writeFileSync(target, readFileSync(personal, "utf8"), "utf8");
  console.log("[seed] personal：已注入 API Key、预置角色与本地地址");
} else {
  const blank = `// 构建时生成：不预置任何 Key、角色或地址
export const SEED_PROVIDER = { baseUrl: "", apiKey: "", model: "" };
export const SEED_CHARACTER = { name: "", persona: "" };
export const SEED_LOCAL_PRESETS = [];
export const SEED_REMOTE_BASE = "";
`;
  writeFileSync(target, blank, "utf8");
  console.log("[seed] public：空白配置，用户首次启动自行填写");
}