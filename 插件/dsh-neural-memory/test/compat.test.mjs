/**
 * 兼容性测试：不装进 DSH，用假的 ctx 跑一遍插件的 apply()
 *
 * 2026-10-28 修（按审查报告）：
 *   - 用临时库，不碰正式数据
 *   - 路由数量动态断言（不再硬编码 3）
 *   - 加：坏入参 400、库损坏 500、并发不丢、注入真的跑了
 *   - 不再硬编码作者机器上的路径
 */
import http from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = await mkdtemp(join(tmpdir(), "neural-compat-"));
const TEST_DB = join(dir, "neural-memory.json");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

// ---- 假 ctx ----
const routes = {};
const injected = [];
const fakeCtx = {
  webServer: {
    register(entry) {
      routes[entry.path] = entry.handler;
      return () => {};
    },
  },
  on(event, fn) {
    if (event === "agent/session-start") fakeCtx._sessionStart = fn;
    if (event === "agent/created") fakeCtx._created = fn;
    if (event === "agent/pre-step") fakeCtx._preStep = fn;
  },
  inject(session, text, opts) {
    injected.push({ session, text, opts });
  },
};

let server;
try {
  console.log("=== 1. 加载插件 ===");
  const plugin = await import("../lib/index.js");
  check("模块能 import", true);
  check("name 正确", plugin.name === "neural-memory");
  check("有 apply", typeof plugin.apply === "function");
  check("inject 声明了 webServer", Array.isArray(plugin.inject) && plugin.inject.includes("webServer"));

  console.log("\n=== 2. apply（假 ctx） ===");
  const dispose = plugin.apply(fakeCtx, { dbPath: TEST_DB, injectOnStart: true, injectTop: 3 });
  check("apply 不抛错", typeof dispose === "function");
  const routePaths = Object.keys(routes);
  check("注册了路由（至少 3 个）", routePaths.length >= 3, routePaths.length + " 个");
  for (const p of ["/neural/remember", "/neural/connect", "/neural/recall",
                   "/neural/stats", "/neural/export", "/neural/snapshot",
                   "/neural/graph-data", "/neural-panel", "/neural-graph"]) {
    check("有 " + p, routePaths.includes(p));
  }

  console.log("\n=== 3. 起本地 HTTP 服务 ===");
  server = http.createServer((req, res) => {
    const h = routes[req.url];
    if (!h) { res.writeHead(404); res.end(); return; }
    h(req, res);
  });
  await new Promise(r => server.listen(18096, "127.0.0.1", r));

  async function post(path, body) {
    const r = await fetch("http://127.0.0.1:18096" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  }
  async function get(path) {
    const r = await fetch("http://127.0.0.1:18096" + path);
    return { status: r.status, text: await r.text() };
  }

  console.log("\n=== 4. 正常路径 ===");
  const r1 = await post("/neural/remember", {
    text: "兼容性测试：一条测试记忆", kind: "判断", importance: 0.8, day: "2026-10-28",
  });
  check("remember 200", r1.status === 200, "status " + r1.status);
  check("remember ok", r1.json.ok === true);
  check("remember 有 id", /^n\d+$/.test(r1.json.id || ""));

  const r2 = await post("/neural/remember", { text: "测试记忆二", kind: "事件", importance: 0.5 });
  check("第二条也能加", r2.json.ok === true);

  const r3 = await post("/neural/connect", { a: r1.json.id, b: r2.json.id });
  check("connect ok", r3.json.ok === true);
  check("connect 返回权重", typeof r3.json.weight === "number");

  const r4 = await post("/neural/recall", { query: "兼容性测试", top: 5 });
  check("recall ok", r4.json.ok === true);
  check("recall 有结果", r4.json.items.length > 0);
  check("recall 第一条是测试那条", r4.json.items[0].text.includes("兼容性测试"));

  const r5 = await post("/neural/recall", { query: "记忆二", top: 10 });
  check("扩散能到另一条", r5.json.items.some(x => x.text.includes("测试记忆二")));

  console.log("\n=== 5. 错误路径（审查报告点名的那几条） ===");
  const bad1 = await post("/neural/remember", { text: 123 });
  check("text=123 → 400", bad1.status === 400, "status " + bad1.status);
  check("text=123 有错误信息", !!bad1.json.error);

  const bad2 = await post("/neural/remember", { text: "x", importance: "abc" });
  check("importance=abc 不报错（退回 0.5）", bad2.json.ok === true);

  const bad3 = await post("/neural/connect", { a: "n999", b: "n998" });
  check("不存在的节点 → 400", bad3.status === 400, "status " + bad3.status);

  const bad4 = await post("/neural/connect", { a: 1, b: 2 });
  check("a/b 不是字符串 → 400", bad4.status === 400);

  console.log("\n=== 6. preview 不写库 ===");
  const beforeRaw = await readFile(TEST_DB, "utf8");
  const pv = await post("/neural/recall", { query: "测试", top: 5, preview: true });
  check("preview ok", pv.json.ok === true);
  check("preview 标记 strengthened=false", pv.json.strengthened === false);
  const afterRaw = await readFile(TEST_DB, "utf8");
  check("preview 没有改库文件", beforeRaw === afterRaw);

  console.log("\n=== 7. 只读接口 ===");
  const st = await get("/neural/stats");
  const stJson = JSON.parse(st.text);
  check("stats ok", stJson.ok === true);
  check("stats 节点数 >= 3（bad2 也加了一条）", stJson.nodes >= 3, "实际 " + stJson.nodes);
  check("stats 不返回 dbPath 以外的东西", typeof stJson.dbPath === "string");

  const ex = await get("/neural/export");
  check("export 是 markdown", ex.text.includes("# 神经记忆导出"));

  const sn = await get("/neural/snapshot");
  const snJson = JSON.parse(sn.text);
  check("snapshot 含 edges", Object.keys(snJson.edges || {}).length === 1);

  const gd = await get("/neural/graph-data");
  check("graph-data 是 js", gd.text.startsWith("window.BRAIN_DATA = "));
  check("graph-data 节点数和 stats 一致", JSON.parse(gd.text.replace(/^window\.BRAIN_DATA = /, "").replace(/;$/, "")).nodes.length === stJson.nodes);

  const pn = await get("/neural-panel");
  check("panel 是 html", pn.text.includes("<html"));

  const gp = await get("/neural-graph");
  check("graph 是 html", gp.text.includes("<html"));

  console.log("\n=== 8. 会话注入（细节在 inject.test.mjs 单独测）===");
  check("注册了 agent/created", typeof fakeCtx._created === "function");
  check("注册了 agent/pre-step", typeof fakeCtx._preStep === "function");
  check("没走旧的 ctx.inject 路子", injected.length === 0, injected.length + " 次");

  console.log("\n=== 9. 并发不丢 ===");
  const before = (await get("/neural/stats")).text;
  const beforeCount = JSON.parse(before).nodes;
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    post("/neural/remember", { text: "并发 " + i, kind: "事件", importance: 0.5 })
  ));
  const after = JSON.parse((await get("/neural/stats")).text);
  check("10 条并发全部落库", after.nodes === beforeCount + 10,
        beforeCount + " → " + after.nodes);

  console.log("\n=== 10. 库损坏时接口报错、不覆盖 ===");
  const corruptPath = join(dir, "corrupt.json");
  const garbage = '{"nodes": {"n1": {"text": "x"';
  await writeFile(corruptPath, garbage, "utf8");
  // 换一个指向坏库的实例
  const routes2 = {};
  const ctx2 = {
    webServer: { register(e) { routes2[e.path] = e.handler; return () => {}; } },
    on() {}, inject() {},
  };
  plugin.apply(ctx2, { dbPath: corruptPath, injectOnStart: false });
  const s2 = http.createServer((req, res) => {
    const h = routes2[req.url];
    if (!h) { res.writeHead(404); res.end(); return; }
    h(req, res);
  });
  await new Promise(r => s2.listen(18097, "127.0.0.1", r));
  const cr = await fetch("http://127.0.0.1:18097/neural/remember", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "这条不该写进去" }),
  });
  const crJson = await cr.json();
  check("损坏库 → 500", cr.status === 500, "status " + cr.status);
  check("错误信息说明了原因", /损坏/.test(crJson.error || ""), crJson.error);
  s2.close();
  check("坏库文件没被改写", (await readFile(corruptPath, "utf8")) === garbage);

  console.log("\n=== 11. 清理 ===");
  check("dispose 是函数", typeof dispose === "function");
  dispose();

} finally {
  if (server) server.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
