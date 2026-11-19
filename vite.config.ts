import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 版本分支的唯一真相来源：electron/edition.json（由 scripts/gen-edition.mjs 写入）
// 环境变量优先，方便临时切换；但打包时一定以文件为准，因为双击 exe 没有环境变量
let edition = process.env.DAFEIYU_EDITION || "";
if (!edition) {
  const f = join(process.cwd(), "electron", "edition.json");
  if (existsSync(f)) {
    try { edition = JSON.parse(readFileSync(f, "utf8")).edition || ""; } catch {}
  }
}
const EDITION = edition === "personal" ? "personal" : "public";
const APP_NAME = EDITION === "personal" ? "Lessseriousness" : "大肥鱼";

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    "import.meta.env.VITE_EDITION": JSON.stringify(EDITION),
    "import.meta.env.VITE_APP_NAME": JSON.stringify(APP_NAME),
  },
  build: { outDir: "dist", emptyOutDir: true },
});
