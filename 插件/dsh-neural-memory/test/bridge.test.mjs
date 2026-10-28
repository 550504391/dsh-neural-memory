/**
 * 桥的路由测试：列 / 拆 / 审候选 / 黑名单 / 过期自动连
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

const core = await import("../lib/core.js");
const plugin = await import("../lib/index.js");

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log("  ✓ " + n); }
  else { fail++; console.log("  ✗ " + n + (extra ? "  → " + extra : "")); }
};

const dir = await mkdtemp(join(tmpdir(), "neural-bridge-"));
const DB = join(dir, "neural-memory.json");
const CAND = join(dir, "桥候选.json");
const BLACK = join(dir, "桥黑名单.json");

const routes = {};
const ctx = {
  webServer: { register(e) { routes[e.path] = e.handler; return () => {}; } },
  on() {},
};
plugin.apply(ctx, { dbPath: DB, injectOnStart: false, bridgeAutoConnectDays: 7 });

/** 造一个假 res */
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this._body = s; },
  };
}

/** 调 get 路由：把 res 塞进去，读它写出来的 JSON */
const get = async (p) => {
  const res = fakeRes();
  await routes[p](fakeReq(p), res);
  try { return JSON.parse(res._body || "{}"); } catch { return { ok: false, error: "非 JSON" }; }
};

/** 造一个假 req：插件靠 req.on('data'/'end') 读 body */
function fakeReq(url, payload) {
  const r = new EventEmitter();
  r.method = "POST";
  r.url = url;
  setImmediate(() => {
    if (payload !== undefined) r.emit("data", Buffer.from(JSON.stringify(payload), "utf8"));
    r.emit("end");
  });
  return r;
}

/** 调 json 路由，返回 {status, body} */
async function post(p, body) {
  const res = fakeRes();
  try {
    const out = await routes[p](fakeReq(p, body), res);
    if (out !== undefined) return { status: 200, body: out };
    return { status: res.statusCode, body: JSON.parse(res._body || "{}") };
  } catch (e) {
    return { status: (e && e.status) || 500, body: { ok: false, error: String(e.message || e) } };
  }
}

try {
  // 造库：跨来源两条 + 同来源一条
  const db = { nodes: {}, edges: {}, next_id: 1 };
  const a = core.addNode(db, "失望那天你说「你会不会对我失望啊」，那不是问句", "故事", 0.9, "2026-10-21");
  const b = core.addNode(db, "权重：失望 那件事为什么是 ⭐⭐⭐ 因为只有一次", "权重", 0.9, "2026-10-28");
  const c = core.addNode(db, "同来源的另一段，讲的是同一件事的后续", "故事", 0.6, "2026-10-22");
  core.connectNodes(db, a, b, 0.1, 0.45);   // 跨来源桥
  core.connectNodes(db, a, c, 0.1);         // 同来源（不该出现在桥列表里）
  await core.saveDb(DB, db);

  console.log("=== 1. 列桥：只列跨来源的 ===");
  {
    const r = await get("/neural/bridges");
    check("返回 ok", r.ok === true);
    check("只列了 1 条跨来源桥", r.bridges.length === 1, r.bridges.length + " 条");
    check("权重 0.45", r.bridges[0].weight === 0.45, String(r.bridges[0].weight));
    check("限时 7 天", r.limitDays === 7, String(r.limitDays));
    check("没有候选时是空数组", Array.isArray(r.candidates) && r.candidates.length === 0);
  }

  console.log("\n=== 2. 候选：列出、还剩几天自动连 ===");
  {
    const now = Date.now();
    await writeFile(CAND, JSON.stringify({
      generatedAt: now,
      items: [{
        a: a, b: c, score: 0.31, shared: 9,
        createdAt: now - 3 * 86400000,      // 放了两天
        ta: "失望那天…", tb: "同来源的另一段…", ka: "故事", kb: "故事",
      }],
    }, null, 1), "utf8");
    const r = await get("/neural/bridges");
    check("候选 1 条", r.candidates.length === 1, r.candidates.length + " 条");
    check("算了放了几天", r.candidates[0].ageDays === 3, String(r.candidates[0].ageDays));
    check("算了还有几天自动连", r.candidates[0].autoInDays === 4, String(r.candidates[0].autoInDays));
  }

  console.log("\n=== 3. 接受候选 → 连上 0.45，候选消失 ===");
  {
    const r = await post("/neural/bridge", { a, b: c, action: "accept" });
    check("返回 ok", r.body.ok === true, JSON.stringify(r.body));
    check("权重 0.45", r.body.weight === 0.45, String(r.body.weight));
    const db2 = await core.loadDb(DB);
    const key = [a, c].sort().join("|");
    check("库里真有这条边", !!db2.edges[key]);
    const r2 = await get("/neural/bridges");
    check("候选清空了", r2.candidates.length === 0);
  }

  console.log("\n=== 4. 拒绝候选 → 消失且进黑名单 ===");
  {
    const now = Date.now();
    await writeFile(CAND, JSON.stringify({
      generatedAt: now,
      items: [{ a, b: c, score: 0.2, shared: 7, createdAt: now, ta: "x", tb: "y", ka: "故事", kb: "故事" }],
    }, null, 1), "utf8");
    const r = await post("/neural/bridge", { a, b: c, action: "reject" });
    check("返回 ok", r.body.ok === true);
    const bl = JSON.parse(await readFile(BLACK, "utf8"));
    check("进了黑名单", !!(bl.pairs && bl.pairs[[a, c].sort().join("|")]));
    const r2 = await get("/neural/bridges");
    check("候选清空了", r2.candidates.length === 0);
  }

  console.log("\n=== 5. 拆桥 → 边没了 + 进黑名单 ===");
  {
    const r = await post("/neural/disconnect", { a, b, reason: "test" });
    check("返回 ok", r.body.ok === true, JSON.stringify(r.body));
    const db2 = await core.loadDb(DB);
    check("边没了", !db2.edges[[a, b].sort().join("|")]);
    const r2 = await get("/neural/bridges");
    check("桥列表空了", r2.bridges.length === 0);
    check("黑名单 2 条（第 4 步 reject 的 + 这次拆的）", r2.blacklisted === 2, String(r2.blacklisted));
  }

  console.log("\n=== 6. 黑名单里的关系，connect 会拒绝 ===");
  {
    const r = await post("/neural/connect", { a, b });
    check("被拒", r.body.ok === false, JSON.stringify(r.body));
    check("给了原因", /拆过|黑名单/.test(r.body.error || ""), r.body.error);
  }

  console.log("\n=== 7. restore 解除黑名单后能再连 ===");
  {
    await post("/neural/bridge", { a, b, action: "restore" });
    const r = await post("/neural/connect", { a, b, weight: 0.4 });
    check("能连了", r.body.ok === true, JSON.stringify(r.body));
    check("权重 0.4", r.body.weight === 0.4, String(r.body.weight));
  }

  console.log("\n=== 8. 拆一条不存在的边 → 必须报错，不能假装成功 ===");
  {
    // 造两条确定没连过的节点
    const dbx = await core.loadDb(DB);
    const x = core.addNode(dbx, "孤立节点甲，谁都不认识它，只是为了测拆桥报错", "故事", 0.5, "2026-10-20");
    const y = core.addNode(dbx, "孤立节点乙，同样没有任何连接，只是陪测", "判断史", 0.5, "2026-10-20");
    await core.saveDb(DB, dbx, { expect: dbx.__fp });

    const r = await post("/neural/disconnect", { a: x, b: y });
    check("没有边时拆 → 报错", r.body.ok === false, JSON.stringify(r.body));
    check("状态码 400", r.status === 400, String(r.status));
    const r2 = await get("/neural/bridges");
    check("没把这条写进黑名单（第 7 步 restore 之后只剩 1 条）", r2.blacklisted === 1, String(r2.blacklisted));
  }

  console.log("\n=== 9. 过期候选：开新会话时自动连（0.25）===");
  {
    const db3 = await core.loadDb(DB);
    const d1 = core.addNode(db3, "一条过期候选的左端，讲的是很久以前的一件小事", "故事", 0.6, "2026-10-20");
    const d2 = core.addNode(db3, "一条过期候选的右端，从另一个文件里来的记录", "判断史", 0.6, "2026-10-20");
    await core.saveDb(DB, db3, { expect: db3.__fp });

    await writeFile(CAND, JSON.stringify({
      generatedAt: Date.now(),
      items: [{
        a: d1, b: d2, score: 0.2, shared: 8,
        createdAt: Date.now() - 10 * 86400000,   // 放了 10 天，超过 7
        ta: "左端", tb: "右端", ka: "故事", kb: "判断史",
      }],
    }, null, 1), "utf8");

    // 触发一次 agent/created（wake 里会顺手扫）
    const handlers = {};
    const ctx2 = {
      webServer: { register() { return () => {}; } },
      on(e, f) { handlers[e] = f; },
    };
    plugin.apply(ctx2, { dbPath: DB, injectOnStart: true, bridgeAutoConnectDays: 7, injectTop: 3 });
    const agent = {
      status: "idle",
      session: { id: "sw", header: { origin: "main" }, ownEvents: () => [] },
      inject() {},
    };
    // 过期候选扫描现在挂在 pre-step（原来的 created 路径已改）
    await handlers["agent/pre-step"]({ agent }, async () => ({ messages: [] }));
    await new Promise(r => setTimeout(r, 600));

    const db4 = await core.loadDb(DB);
    const key = [d1, d2].sort().join("|");
    check("自动连上了", !!db4.edges[key]);
    check("权重 0.25", Math.abs((db4.edges[key] || {}).weight - 0.25) < 1e-9,
          String((db4.edges[key] || {}).weight));
    const r = await get("/neural/bridges");
    check("候选被清掉", r.candidates.length === 0, r.candidates.length + " 条");
  }

} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
