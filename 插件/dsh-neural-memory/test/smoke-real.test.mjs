/**
 * 真库冒烟测试：用假 ctx + 真库，跑一遍所有只读接口
 * 目的：重启前确认插件能加载、能读我的库、不写坏它
 *
 * 库路径按插件自己的顺序找（跟 lib/index.js 一致）：
 *   ① 环境变量 NEURAL_MEMORY_DB
 *   ② ~/.dsh-neural-memory/config.json 的 dbPath
 *   ③ ~/.dsh-neural-memory/neural-memory.json
 * 都不在、或者库是空的 → 跳过（不是失败）
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveDb() {
  const env = process.env.NEURAL_MEMORY_DB;
  if (env && env.trim()) return env.trim();
  const cfgPath = join(homedir(), ".dsh-neural-memory", "config.json");
  try {
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (typeof cfg.dbPath === "string" && cfg.dbPath.trim()) return cfg.dbPath.trim();
    }
  } catch { /* 配置坏了就用默认 */ }
  return join(homedir(), ".dsh-neural-memory", "neural-memory.json");
}

const REAL_DB = resolveDb();

if (!existsSync(REAL_DB)) {
  console.log("跳过：没找到库（" + REAL_DB + "）");
  console.log("这个用例是对着填满的库跑只读接口，空库没意义。");
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log("  ✓ " + n); }
  else { fail++; console.log("  ✗ " + n + (extra ? "  → " + extra : "")); }
};

const dbRaw = JSON.parse(await readFile(REAL_DB, "utf8"));
if (!dbRaw.nodes || Object.keys(dbRaw.nodes).length === 0) {
  console.log("跳过：库是空的（" + REAL_DB + "），先灌几条再跑");
  process.exit(0);
}
const expNodes = Object.keys(dbRaw.nodes).length;
const expEdges = Object.keys(dbRaw.edges).length;
const before = await readFile(REAL_DB);
const beforeHash = createHash("sha256").update(before).digest("hex").slice(0, 12);
const beforeSize = before.length;
console.log("重启前库指纹: " + beforeHash + " (" + Math.round(beforeSize / 1024) + " KB)");

const routes = {};
const fakeCtx = {
  webServer: { register(e) { routes[e.path] = e.handler; return () => {}; } },
  on() {}, inject() {},
};

console.log("\n=== 1. 加载插件 ===");
const plugin = await import("../lib/index.js");
check("import 成功", true);
check("有 apply", typeof plugin.apply === "function");

console.log("\n=== 2. apply（指向真库，只读） ===");
// 显式给真库路径，模拟我的 profile 配置
plugin.apply(fakeCtx, {
  dbPath: REAL_DB,
  injectOnStart: false,
});
check("apply 不抛错", true);
check("路由数 = " + Object.keys(routes).length, Object.keys(routes).length >= 9);

const server = http.createServer((req, res) => {
  const h = routes[req.url.split("?")[0]];
  if (!h) { res.writeHead(404); res.end(); return; }
  h(req, res);
});
await new Promise(r => server.listen(18098, "127.0.0.1", r));

async function get(path) {
  const r = await fetch("http://127.0.0.1:18098" + path);
  return { status: r.status, text: await r.text() };
}
async function post(path, body) {
  const r = await fetch("http://127.0.0.1:18098" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

console.log("\n=== 3. 只读接口（真库 1244 条） ===");
const st = await get("/neural/stats");
const stJson = JSON.parse(st.text);
check("stats 200", st.status === 200);
check("节点 " + expNodes, stJson.nodes === expNodes, "实际 " + stJson.nodes);
check("边 " + expEdges, stJson.edges === expEdges, "实际 " + stJson.edges);
check("dropped = 0（没有误删）", stJson.dropped === 0, "dropped=" + stJson.dropped);
check("天数为正", stJson.days > 0, "实际 " + stJson.days);
check("dbPath 是一个绝对路径", /^[A-Za-z]:[\\/]|^\//.test(stJson.dbPath || ""), stJson.dbPath);

const ex = await get("/neural/export");
check("export 200", ex.status === 200);
check("export 是 markdown", ex.text.startsWith("# 神经记忆导出"));

const sn = await get("/neural/snapshot");
check("snapshot 200", sn.status === 200);
const snJson = JSON.parse(sn.text);
check("snapshot 节点数一致", Object.keys(snJson.nodes).length === expNodes);
check("snapshot 边数一致", Object.keys(snJson.edges).length === expEdges);

const gd = await get("/neural/graph-data");
check("graph-data 200", gd.status === 200);
check("graph-data 是 js", gd.text.startsWith("window.BRAIN_DATA = "));

const pn = await get("/neural-panel");
check("panel 200", pn.status === 200 && pn.text.includes("<html"));

const gp = await get("/neural-graph");
check("graph 200", gp.status === 200 && gp.text.includes("<html"));

console.log("\n=== 4. preview 召回（不写库） ===");
const rv = await post("/neural/recall", { query: "失望", top: 5, preview: true });
check("recall 200", rv.status === 200);
check("有结果", rv.json.items.length > 0, rv.json.items.length + " 条");
check("strengthened=false", rv.json.strengthened === false);
check("第一条是失望相关", /失望/.test(rv.json.items[0].text), rv.json.items[0].text.slice(0, 40));

console.log("\n=== 5. 坏入参（不写库） ===");
const b1 = await post("/neural/remember", { text: 123 });
check("text=123 → 400", b1.status === 400, "status " + b1.status);
const b2 = await post("/neural/connect", { a: "n999999", b: "n1" });
check("不存在的节点 → 400（且不写库）", b2.status === 400, "status " + b2.status);

console.log("\n=== 6. 库没被改动 ===");
const after = await readFile(REAL_DB);
const afterHash = createHash("sha256").update(after).digest("hex").slice(0, 12);
check("库指纹不变", beforeHash === afterHash, beforeHash + " → " + afterHash);
check("库大小不变", before.length === after.length);

server.close();

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
