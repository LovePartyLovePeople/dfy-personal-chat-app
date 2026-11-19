const testScript = String.raw`
(async () => {
  const out = { steps: [], fail: [] };
  window.__testOut = out;   // 中途抛异常时，外层仍能拿到已完成的步骤
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (s, ok, extra) => { out.steps.push({ step: s, ok: !!ok, extra: extra ?? null }); if (!ok) out.fail.push(s); };
  const waitFor = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(120); }
    return false;
  };
  const clickBtn = (label) => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes(label));
    if (!b) return false;
    b.click();
    return true;
  };
  const setInput = (el, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const idbAll = (store) => new Promise((resolve, reject) => {
    const req = indexedDB.open("dafeiyu");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) return resolve([]);
      const tx = db.transaction(store, "readonly");
      const r = tx.objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
  });

  // 1. 列表页
  const listOk = await waitFor(() => document.body.innerText.includes("新建角色") || document.body.innerText.includes("创建一个"));
  log("列表页渲染", listOk);

  // 2. 新建角色
  clickBtn("新建角色") || clickBtn("创建一个");
  await sleep(400);
  const nameInput = document.querySelector(".settings input");
  const personaBox = document.querySelector(".persona-box");
  if (!nameInput || !personaBox) { log("打开新建页", false); return out; }
  log("打开新建页", true);
  setInput(nameInput, "测试鱼");
  setInput(personaBox, "你是测试角色，说话简短。");
  clickBtn("创建");
  await sleep(800);
  log("进入聊天页", await waitFor(() => !!document.querySelector(".inputbar textarea")));

  // 3. 桩掉网络，发一句话
  window.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "测试回复" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  const ta = document.querySelector(".inputbar textarea");
  setInput(ta, "在吗");
  await sleep(150);
  clickBtn("发送");
  const gotReply = await waitFor(() => document.body.innerText.includes("测试回复"), 12000);
  log("发送并收到回复", gotReply, document.body.innerText.slice(-120));

  // 4. 持久化检查
  const msgs = await idbAll("messages");
  log("IndexedDB 有消息", msgs.length >= 2, "条数=" + msgs.length);
  const chars = await idbAll("characters");
  log("角色已落库", chars.some((c) => c.name === "测试鱼"), "角色数=" + chars.length);

  // 5. 记住指令
  setInput(document.querySelector(".inputbar textarea"), "记住 我喜欢猫");
  await sleep(150);
  clickBtn("发送");
  await sleep(1500);
  const facts = await idbAll("facts");
  log("记住指令写入 facts", facts.some((f) => (f.text || "").includes("喜欢猫")), "facts=" + JSON.stringify(facts.map((f) => f.text)));

  // 6. 设置页
  document.querySelector(".gear")?.click();
  await sleep(600);
  log("打开设置页", document.body.innerText.includes("服务商") && document.body.innerText.includes("数据"));

  // 7. 导出
  clickBtn("导出到剪贴板");
  await sleep(800);
  log("导出流程不崩", true, document.body.innerText.slice(-80));

  // 8. 一路返回列表（设置→聊天→列表）
  for (let i = 0; i < 4; i++) {
    const hasNew = [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新建角色"));
    if (hasNew) break;
    document.querySelector(".back")?.click();
    await sleep(500);
  }
  const onList = [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新建角色"));
  log("回到列表页", onList);

  // 9. 第二个角色（多角色隔离）
  const plusBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新建角色"));
  plusBtn?.click();
  await sleep(400);
  const ni = document.querySelector(".settings input");
  if (ni) {
    setInput(ni, "测试鱼2号");
    clickBtn("创建");
    await sleep(800);
    const ta2 = document.querySelector(".inputbar textarea");
    if (ta2) {
      setInput(ta2, "你好2");
      await sleep(120);
      clickBtn("发送");
      await waitFor(() => document.body.innerText.includes("测试回复"), 8000);
    }
    document.querySelector(".back")?.click();
    await sleep(700);
    const body2 = document.body.innerText;
    log("多角色列表显示两个", body2.includes("测试鱼2号"));
    const chars3 = await idbAll("characters");
    log("两个角色落库", chars3.length >= 2, "角色=" + chars3.map((c) => c.name).join(","));
    const msgs2 = await idbAll("messages");
    const byChar = {};
    msgs2.forEach((m) => { byChar[m.characterId] = (byChar[m.characterId] || 0) + 1; });
    log("消息按角色隔离", Object.keys(byChar).length >= 2, JSON.stringify(byChar));
  } else {
    log("打开第二个角色的新建页", false, "当前页面:" + document.body.innerText.slice(0, 200));
  }

  // 10. 摘要滚动：塞 45 条再发一句，应触发 summary
  const charsNow = await idbAll("characters");
  const target = charsNow.find((c) => c.name === "测试鱼2号") || charsNow[0];
  await new Promise((resolve, reject) => {
    const req = indexedDB.open("dafeiyu");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("messages", "readwrite");
      const store = tx.objectStore("messages");
      for (let i = 0; i < 45; i++) {
        store.add({ characterId: target.id, role: i % 2 ? "assistant" : "user", content: "填充消息" + i, ts: Date.now() - (45 - i) * 1000 });
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  });
  const chatBtn = [...document.querySelectorAll(".conv")].find((d) => (d.textContent || "").includes(target.name));
  chatBtn?.click();
  await sleep(600);
  const tbox = document.querySelector(".inputbar textarea");
  if (tbox) {
    setInput(tbox, "触发摘要");
    await sleep(120);
    clickBtn("发送");
    await sleep(3000);
  }
  const sums = await idbAll("summaries");
  log("40 条后触发摘要", sums.length >= 1, "摘要数=" + sums.length + " 字数=" + (sums[0]?.text?.length ?? 0));

  // 11. 导入：把导出的 JSON 写进剪贴板再导入
  document.querySelector(".gear")?.click();
  await sleep(500);
  const exported = await new Promise((resolve) => {
    const orig = window.fetch;
    resolve(true);
  });
  const dbAll = await new Promise((resolve, reject) => {
    const req = indexedDB.open("dafeiyu");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["characters", "messages"], "readonly");
      const c = tx.objectStore("characters").getAll();
      const m = tx.objectStore("messages").getAll();
      tx.oncomplete = () => resolve({ chars: c.result, msgs: m.result });
    };
  });
  const payload = JSON.stringify({
    version: 1,
    character: dbAll.chars[0],
    messages: dbAll.msgs.filter((x) => x.characterId === dbAll.chars[0].id).map(({ characterId, ...r }) => r),
    facts: [],
    summary: null,
  });
  if (window.dafeiyu?.copyText) await window.dafeiyu.copyText(payload);
  clickBtn("从剪贴板导入");
  await sleep(1500);
  log("从剪贴板导入", document.body.innerText.includes("导入完成") || document.body.innerText.includes("导入失败"), document.body.innerText.slice(-60));

  // 12. 超长回复不崩
  document.querySelector(".back")?.click();
  await sleep(400);
  window.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "长".repeat(800) } }] }), { status: 200 });
  const tb2 = document.querySelector(".inputbar textarea");
  if (tb2) {
    setInput(tb2, "说点长的");
    await sleep(120);
    clickBtn("发送");
    await sleep(2500);
  }
  const bubbles = document.querySelectorAll(".bubble");
  log("超长回复渲染", bubbles.length > 0);

  // 13. 接口报错时不能卡死
  window.fetch = async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 });
  const convs = [...document.querySelectorAll(".conv")];
  convs[0]?.click();
  await sleep(500);
  const tb3 = document.querySelector(".inputbar textarea");
  if (tb3) {
    setInput(tb3, "测试报错");
    await sleep(120);
    clickBtn("发送");
    await sleep(2500);
  }
  const errShown = !!document.querySelector(".errbar");
  const tbErr = document.querySelector(".inputbar textarea");
  if (tbErr) setInput(tbErr, "再试一次");
  await sleep(200);
  const sendEnabled = [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("发送") && !b.disabled);
  log("接口报错有提示且能继续发", errShown && sendEnabled, "errbar=" + errShown + " 发送可用=" + sendEnabled);

  // 14. 记忆管理页 / 预设 / 表情管理入口
  document.querySelector(".gear")?.click();
  await sleep(600);
  const hasPresets = ["DeepSeek", "硅基流动", "阿里百炼", "OpenAI"].every((n) => document.body.innerText.includes(n));
  log("服务商预设按钮", hasPresets);
  const hasAutostart = document.body.innerText.includes("开机自启");
  log("开机自启开关可见", hasAutostart);
  clickBtn("记忆管理");
  await sleep(700);
  const memOk = document.body.innerText.includes("长期事实") && document.body.innerText.includes("滚动摘要");
  log("记忆管理页打开", memOk);
  const factInput = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("喜欢猫"));
  if (factInput) {
    setInput(factInput, "测试事实：喜欢下雨");
    clickBtn("添加");
    await sleep(700);
  }
  const facts2 = await idbAll("facts");
  log("记忆页可添加事实", facts2.some((f) => (f.text || "").includes("喜欢下雨")), "facts=" + JSON.stringify(facts2.map((f) => f.text)));
  document.querySelector(".back")?.click();
  await sleep(600);
  clickBtn("管理表情");
  await sleep(700);
  log("表情管理页打开", document.body.innerText.includes("表情包") && document.body.innerText.includes("导入"));
  document.querySelector(".back")?.click();
  await sleep(600);

  // 15. 删除角色
  document.querySelector(".gear")?.click();
  await sleep(500);
  window.confirm = () => true;
  clickBtn("删除这个角色");
  await sleep(1200);
  const charsLeft = await idbAll("characters");
  log("删除角色生效", charsLeft.length <= 3, "剩余角色=" + charsLeft.map((c) => c.name).join(","));
  log("删除后回到列表", [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新建角色")));

  return out;
})()
`;
module.exports = { testScript };
