const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, ipcMain, clipboard, net } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIST = path.join(__dirname, "..", "dist");

// 版本分支：public = 合规公开版，personal = 特供版。
// 优先读环境变量（开发时用），其次读构建期写入的 edition.json（打包后用，因为双击 exe 没有环境变量）。
let editionHint = process.env.DAFEIYU_EDITION || "";
if (!editionHint) {
  try { editionHint = JSON.parse(fs.readFileSync(path.join(__dirname, "edition.json"), "utf8")).edition || ""; } catch {}
}
const EDITION = editionHint === "personal" ? "personal" : "public";
const IS_TEST = process.env.DAFEIYU_TEST === "1";
const IS_HEADLESS = process.env.DAFEIYU_HEADLESS === "1";
const APP_NAME = EDITION === "personal" ? "Lessseriousness" : "大肥鱼";

// 两个版本用各自的数据目录，装在同一台机器上也互不污染
if (EDITION === "personal") {
  app.setPath("userData", path.join(app.getPath("appData"), "dafeiyu-personal"));
}

// 自动化测试用独立目录：测试会建角色、删角色，绝不能写进真实数据
if (IS_TEST) {
  app.setPath("userData", path.join(app.getPath("temp"), "dafeiyu-test"));
}

const CONFIG_PATH = path.join(app.getPath("userData"), "desktop-config.json");

// 关键：Hiddify 等工具会设置系统代理（127.0.0.1:12334），Chromium 会把「所有」请求都塞进代理，
// 而代理不认识 Tailscale（100.64.0.0/10）和局域网网段，直接返回 502。
// 把私有网段和本机加入绕过列表，本地模型和 /__search 才不会被代理截胡。
app.commandLine.appendSwitch(
  "proxy-bypass-list",
  "<local>;127.0.0.1;localhost;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16;100.64.0.0/10"
);

// 固定端口：IndexedDB 按 origin 隔离，端口是 origin 的一部分。
// 以前用 listen(0) 每次随机端口，等于每次启动都是一个空库——重启即丢光所有数据。
const PORT = EDITION === "personal" ? 51790 : 51789;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}
function writeConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
}
let config = { closeAction: "tray" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

let server;
let win;
let tray;
let quitting = false;

/**
 * 走 Chromium 网络栈的 fetch：会遵守 Windows 系统代理（Hiddify 开着才连得上境外站点），
 * 也会遵守我们设置的 proxy-bypass-list（本地/Tailscale 不被代理截胡）。
 * Node 自带的 fetch 不认系统代理，境外站点会全部失败——这是踩过的坑。
 */
function httpFetch(url, opts) {
  try {
    if (net && typeof net.fetch === "function") return net.fetch(url, opts);
  } catch {}
  return fetch(url, opts);
}

/** 去掉 CDATA / HTML 标签 / 常见实体，RSS 摘要里全是这些 */
function cleanText(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 网页搜索。跑在主进程里，用的是这台电脑的网络（VPN 开着走 VPN，关着走直连）。
 * 主源：必应 RSS（国内可直连、结构稳定）；空了再补 DuckDuckGo（需要能出去）。
 */
async function webSearch(query, limit = 6) {
  // 关键：多词查询必须用 + 连接。用 %20 的话必应只会拿第一个词去搜（实测会返回「人工」这种无关结果）
  const q = encodeURIComponent(query).replace(/%20/g, "+");
  const results = [];
  const seen = new Set();
  const push = (title, url, snippet, date) => {
    const t = cleanText(title), u = String(url || "").trim(), s = cleanText(snippet);
    if (!t || !u || seen.has(u)) return;
    seen.add(u);
    results.push({ title: t, url: u, snippet: s.slice(0, 400), date: date || "" });
  };  // RSS 的 pubDate 形如 "Tue, 17 Nov 2026 19:50:00 GMT"，只取日期
  const dateOf = (raw) => {
    const m = String(raw || "").match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})/i);
    if (!m) return "";
    const mon = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[2].toLowerCase().slice(0, 3)) + 1;
    return `${m[3]}-${String(mon).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  };

  // 时效性问题（新闻/最新/今天/价格…）优先走「新闻」源，普通网页搜索返回的常常是好几年前的页面
  const timeSensitive = /(新闻|最新|今天|昨天|最近|今年|本月|发布|上线|开售|宣布|价格|多少钱|股价|汇率|比分|选举|当选|去世|逝世)/.test(query);

  if (timeSensitive) {
    try {
      const res = await httpFetch(`https://www.bing.com/news/search?q=${q}&format=rss`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(9000),
      });
      const xml = await res.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const body = m[1];
        push(
          (body.match(/<title>([\s\S]*?)<\/title>/) || [])[1],
          (body.match(/<link>([\s\S]*?)<\/link>/) || [])[1],
          (body.match(/<description>([\s\S]*?)<\/description>/) || [])[1],
          dateOf((body.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1])
        );
        if (results.length >= limit) break;
      }
    } catch {}
  }

  // 普通网页：cn 优先（国内直连），不给东西再试 www。
  // 但新闻源已经拿到足够结果时就不再掺普通网页——混进来往往是几年前的页面，把时效性冲掉。
  for (const host of ["cn.bing.com", "www.bing.com"]) {
    if (results.length >= (timeSensitive ? 3 : limit)) break;
    try {
      const res = await httpFetch(`https://${host}/search?q=${q}&format=rss&count=10`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(9000),
      });
      const xml = await res.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const body = m[1];
        push(
          (body.match(/<title>([\s\S]*?)<\/title>/) || [])[1],
          (body.match(/<link>([\s\S]*?)<\/link>/) || [])[1],
          (body.match(/<description>([\s\S]*?)<\/description>/) || [])[1],
          dateOf((body.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1])
        );
        if (results.length >= limit) break;
      }
    } catch {}
  }

  // 2) 必应没给东西，试 DuckDuckGo（走 VPN 出口）
  if (results.length < 3) {
    try {
      const res = await httpFetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(9000),
      });
      const html = await res.text();
      const blocks = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,600}?)(?=<a[^>]+class="result__a"|$)/g)];
      for (const b of blocks) {
        const snip = (b[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/) || [])[1];
        push(b[2], decodeURIComponent(b[1]), snip);
        if (results.length >= limit) break;
      }
    } catch {}
  }
  // 相关度过滤：标题/摘要里必须出现查询里的某个实词，否则视为跑题（必应经常给无关的老页面）
  const tokens = query
    .replace(/[，。！？、；：""''（）()【】\[\]…~～\s]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (tokens.length) {
    const relevant = results.filter((r) => {
      const hay = r.title + " " + r.snippet;
      return tokens.some((t) => hay.includes(t));
    });
    if (relevant.length >= 2) return relevant.slice(0, limit);
  }
  return results.slice(0, limit);
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

/** 粗暴但有效的正文提取：干掉脚本/样式/导航，优先取 article/main，其余按块级标签断行 */
function htmlToText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanText(decodeEntities(titleMatch ? titleMatch[1] : ""));

  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form|svg|iframe)[\s\S]*?<\/\1>/gi, " ");

  const main = h.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main) h = main[2];

  let text = h
    .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = decodeEntities(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ");

  // 逐行清洗：去空白行、去只剩标点的行，避免正文里塞满空行把上下文浪费掉
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /[\u4e00-\u9fa5A-Za-z0-9]/.test(line))
    .join("\n")
    .trim();

  return { title, text };
}

/**
 * 抓一个网页的正文。跑在主进程，走这台电脑的网络（VPN 开着就翻墙）。
 * 只抓公开页面，不带任何登录态/cookie，也不绕付费墙。
 */
async function fetchPage(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("URL 格式不对"); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("只支持 http/https");

  const res = await httpFetch(u.href, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const type = res.headers.get("content-type") || "";
  if (/^image\//.test(type)) {
    return { url: u.href, title: "", text: `（这是一个图片：${u.href}）`, truncated: false };
  }

  const html = (await res.text()).slice(0, 400000);
  const { title, text } = htmlToText(html);
  const LIMIT = 12000;
  return {
    url: res.url || u.href,
    title: title || u.hostname,
    text: text.slice(0, LIMIT),
    truncated: text.length > LIMIT,
  };
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

// ---- 记忆同步：电脑当中枢，手机/桌面都往这里推，取回的是合并后的并集 ----

const SYNC_PATH = path.join(app.getPath("userData"), "sync-store.json");

/** 记录指纹：用「类型 + 字符 + 内容」，不依赖自增 id（两台设备的 id 会撞） */
function fp(kind, rec) {
  if (kind === "characters") return `c:${rec.id}`;
  if (kind === "messages") return `m:${rec.characterId}:${rec.ts}:${rec.role}:${String(rec.content || "").slice(0, 60)}`;
  // 事实只按内容去重：带上 ts 的话，同一条内容在两端生成的时间不同就会变成两条
  if (kind === "facts") return `f:${rec.characterId}:${String(rec.text || "")}`;
  if (kind === "summaries") return `s:${rec.characterId}`;
  return `${kind}:${JSON.stringify(rec).slice(0, 80)}`;
}

function emptyStore() {
  return { characters: [], messages: [], facts: [], summaries: [] };
}

function readSyncStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(SYNC_PATH, "utf8"));
    return { ...emptyStore(), ...raw };
  } catch {
    return emptyStore();
  }
}

function writeSyncStore(store) {
  try { fs.writeFileSync(SYNC_PATH, JSON.stringify(store)); } catch (e) { console.error("[sync] 写入失败", e.message); }
}

/** 并集合并；summaries 按 updatedAt 取新的 */
function mergeInto(store, incoming) {
  let added = 0;
  for (const kind of ["characters", "messages", "facts"]) {
    const exist = new Set(store[kind].map((r) => fp(kind, r)));
    for (const rec of incoming?.[kind] || []) {
      const key = fp(kind, rec);
      if (exist.has(key)) continue;
      exist.add(key);
      store[kind].push(rec);
      added++;
    }
  }
  for (const rec of incoming?.summaries || []) {
    const idx = store.summaries.findIndex((s) => s.characterId === rec.characterId);
    if (idx === -1) { store.summaries.push(rec); added++; }
    else if ((rec.updatedAt || 0) > (store.summaries[idx].updatedAt || 0)) { store.summaries[idx] = rec; added++; }
  }
  return added;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 40 * 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}


function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");

      // 检索接口：桌面端同源调用，安卓端走 http://电脑IP:51790/__search
      if (url.pathname === "/__search") {
        cors(res);
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"empty query"}'); return; }
        try {
          const items = await webSearch(q);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ query: q, results: items }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
        return;
      }

      // 网页正文：贴个链接就让鱼读全文
      if (url.pathname === "/__fetch") {
        cors(res);
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        const target = (url.searchParams.get("url") || "").trim();
        if (!target) { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"empty url"}'); return; }
        try {
          const page = await fetchPage(target);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(page));
        } catch (e) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
        return;
      }

      // 记忆同步：POST 推上来并取回合并结果，GET 只取
      if (url.pathname === "/__sync") {
        cors(res);
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        try {
          if (req.method === "POST") {
            const body = JSON.parse((await readBody(req)) || "{}");
            const store = readSyncStore();
            const added = mergeInto(store, body);
            writeSyncStore(store);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ added, store }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ store: readSyncStore() }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
        return;
      }

      let filePath = path.join(DIST, decodeURIComponent(req.url.split("?")[0]));
      if (req.url === "/" || !path.extname(filePath)) filePath = path.join(DIST, "index.html");
      fs.readFile(filePath, (err, data) => {
        if (err) {
          fs.readFile(path.join(DIST, "index.html"), (e2, html) => {
            if (e2) { res.writeHead(404); res.end("not found"); return; }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
          });
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.on("error", (err) => {
      console.error("[server] 监听失败:", err && err.message);
      resolve(PORT);
    });
    // 绑 0.0.0.0：手机要能通过局域网/Tailscale 调 /__search 取检索结果
    server.listen(PORT, "0.0.0.0", () => resolve(server.address().port));
  });
}

function createWindow(port) {
  const startHidden = process.argv.includes("--hidden");
  win = new BrowserWindow({
    title: APP_NAME,
    show: process.env.DAFEIYU_HEADLESS !== "1" && !startHidden,
    width: 460,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: "#ededed",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "tray.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", (e) => {
    if (quitting) return;
    if (config.closeAction === "tray") {
      e.preventDefault();
      win.hide();
    }
  });
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: `打开 ${APP_NAME}`, click: () => { win.show(); win.focus(); } },
    { type: "separator" },
    {
      label: "关闭窗口时：最小化到托盘",
      type: "radio",
      checked: config.closeAction === "tray",
      click: () => { config.closeAction = "tray"; writeConfig(config); buildTray(); },
    },
    {
      label: "关闭窗口时：直接退出",
      type: "radio",
      checked: config.closeAction === "exit",
      click: () => { config.closeAction = "exit"; writeConfig(config); buildTray(); },
    },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(menu);
  tray.on("click", () => { win.show(); win.focus(); });
}

ipcMain.handle("clipboard:write", (_e, text) => { clipboard.writeText(String(text ?? "")); return true; });
ipcMain.handle("clipboard:read", () => clipboard.readText());
// 更新检查/下载按钮要用系统浏览器打开链接，渲染进程里 window.open 会被 setWindowOpenHandler 拦下
ipcMain.handle("shell:openExternal", (_e, url) => {
  const u = String(url || "");
  if (!/^https?:\/\//i.test(u)) return false;
  shell.openExternal(u);
  return true;
});

ipcMain.handle("config:get", () => config);
ipcMain.handle("config:set", (_e, patch) => {
  Object.assign(config, patch || {});
  writeConfig(config);
  if (tray) buildTray();
  return config;
});

// 开机自启：便携版要指向原始 exe，而不是每次解压出来的临时目录
function autostartExe() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}
function autostartState() {
  const exe = autostartExe();
  try {
    const s = app.getLoginItemSettings({ path: exe });
    return { enabled: !!s.openAtLogin, exe };
  } catch (e) {
    return { enabled: false, exe, error: String(e) };
  }
}
ipcMain.handle("autostart:get", () => autostartState());
ipcMain.handle("autostart:set", (_e, on) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: autostartExe(), args: ["--hidden"] });
  } catch {}
  return autostartState();
});

// 同一版本只能有一个实例：固定端口 + 同一个 IndexedDB（LevelDB 单写者）。
// 两个进程同时打开同一个库会直接把库写坏（踩过两次，表现是角色列表突然空了）。
// 探针模式以前跳过了这把锁，结果测试时和托盘里的实例抢库 —— 现在一律加锁。
if (!IS_TEST && !IS_HEADLESS) {
  if (!app.requestSingleInstanceLock()) {
    if (process.env.DAFEIYU_PROBE) {
      console.error("[probe] 已有实例在运行，为避免数据库竞争，本次探针退出");
      app.exit(2);
    } else {
      app.quit();
    }
  } else {
    app.on("second-instance", () => {
      if (win) { win.show(); win.focus(); }
    });
  }
}

app.whenReady().then(async () => {
  if (process.env.DAFEIYU_TEST === "1") {
    const port = await startServer();
    const w = new BrowserWindow({ show: false, width: 460, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") } });
    const logs = [];
    w.webContents.on("console-message", (_e, level, message) => logs.push(`[${level}] ${message}`));
    await w.loadURL(`http://127.0.0.1:${port}/?test=1`);
    await new Promise((r) => setTimeout(r, 2500));
    let result;
    try {
      result = await w.webContents.executeJavaScript(require("./tests.cjs").testScript);
    } catch (e) {
      result = { error: String(e) };
    }
    // 测试中途抛异常时，把已完成的步骤也带回来，否则两眼一抹黑
    try {
      const partial = await w.webContents.executeJavaScript("window.__testOut || null");
      if (partial && (!result || !result.steps)) result.partial = partial;
    } catch {}
    fs.writeFileSync(path.join(__dirname, "..", "test-report.json"), JSON.stringify({ result, logs }, null, 2));
    app.quit();
    return;
  }
  // 通用探针：DAFEIYU_PROBE 传一段 JS，跑完把结果写到 probe.json。
  // 用来验证跨进程持久化（IndexedDB 是否在重启后还在）这类必须真启一次才能测的东西。
  if (process.env.DAFEIYU_PROBE) {
    const portP = await startServer();
    const wp = new BrowserWindow({ show: process.env.DAFEIYU_SHOT === "1", width: 460, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await wp.loadURL(`http://127.0.0.1:${portP}/?test=1`);
    await new Promise((r) => setTimeout(r, 2500));
    let out;
    try {
      out = await wp.webContents.executeJavaScript(decodeURIComponent(process.env.DAFEIYU_PROBE));
    } catch (e) {
      out = { error: String(e) };
    } finally {
      // DAFEIYU_SHOT=1 时把当前页面存成 png，用来核对界面效果
      if (process.env.DAFEIYU_SHOT === "1") {
        try {
          const shot = await wp.webContents.capturePage();
          fs.writeFileSync(path.join(app.getPath("userData"), "shot.png"), shot.toPNG());
        } catch {}
      }
      // 注意：打包后 __dirname 在 app.asar 内（只读），必须写到 userData。
      // 而且无论成败都要 quit，否则会留下占着文件的僵尸进程（曾经留下 8 个，把打包卡死）。
      try { fs.writeFileSync(path.join(app.getPath("userData"), "probe.json"), JSON.stringify(out, null, 2)); } catch {}
      app.quit();
    }
    return;
  }
  if (process.env.DAFEIYU_HEADLESS === "1") {
    const logs = [];
    const port0 = await startServer();
    const w = new BrowserWindow({ show: false, width: 460, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    w.webContents.on("console-message", (_e, level, message) => logs.push(`[${level}] ${message}`));
    await w.loadURL(`http://127.0.0.1:${port0}/`);
    setTimeout(() => {
      fs.writeFileSync(path.join(__dirname, "..", "headless.log"), logs.join("\n") || "(no console output)");
      app.quit();
    }, 5000);
    return;
  }
  Object.assign(config, readConfig());
  if (!config.closeAction) config.closeAction = "tray";
  const port = await startServer();
  createWindow(port);
  buildTray();
});

app.on("window-all-closed", () => {
  if (config.closeAction === "exit") app.quit();
});

app.on("before-quit", () => { quitting = true; if (server) server.close(); });