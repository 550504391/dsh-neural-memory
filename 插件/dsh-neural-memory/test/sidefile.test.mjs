/**
 * 辅助文件（候选 / 黑名单）的读写契约
 *
 * 为什么单独测：这两个文件坏了被当"空"的后果，是把你拒绝过的关联
 * 重新建议甚至自动连上。所以"坏了要报错"是这个测试的重点。
 */
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log("  ✓ " + n); }
  else { fail++; console.log("  ✗ " + n + (extra ? "  → " + extra : "")); }
};

const dir = await mkdtemp(join(tmpdir(), "neural-side-"));
const DB = join(dir, "neural-memory.json");

try {
  const core = await import("../lib/core.js");
  const db = { nodes: {}, edges: {}, next_id: 1 };
  core.addNode(db, "A 一条足够长的测试记忆内容", "事件", 0.5, "2026-10-28");
  await core.saveDb(DB, db);

  const plugin = await import("../lib/index.js");

  function makeCtx() {
    const routes = {};
    return {
      routes,
      ctx: {
        webServer: { register(r) { routes[r.path] = r.handler; return () => {}; } },
        on() {},
      },
    };
  }
  const call = async (routes, path, body) => {
    const h = routes[path];
    if (!h) return { status: 404, body: { ok: false, error: "no route" } };
    let done = null;
    const res = {
      statusCode: 200,
      setHeader() {},
      writeHead(c) { this.statusCode = c; return this; },
      end(s) { done = s; },
      write(s) { done = (done || "") + s; },
      on() {},
    };
    const listeners = {};
    const req = {
      method: "POST", url: path, headers: { "content-type": "application/json" },
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      destroy() {},
    };
    const pending = h(req, res);
    const fired = () => (listeners.data || []).forEach(f => f(Buffer.from(JSON.stringify(body || {}))));
    fired();
    (listeners.end || []).forEach(f => f());
    try { await pending; } catch (e) { return { status: 500, body: { ok: false, error: String(e.message || e) } }; }
    try { return { status: res.statusCode, body: JSON.parse(done) }; }
    catch { return { status: res.statusCode, body: done }; }
  };

  console.log("=== 1. 黑名单不存在 → 正常 ===");
  {
    const { ctx, routes } = makeCtx();
    plugin.apply(ctx, { dbPath: DB });
    const r = await call(routes, "/neural/bridges", {});
    check("bridges 返回 200", r.status === 200, "status " + r.status);
    check("有 candidates 字段", r.body && "candidates" in r.body);
  }

  console.log("\n=== 2. 黑名单损坏 → 必须报错，不能当空 ===");
  {
    const bl = join(dir, "桥黑名单.json");
    await writeFile(bl, "{ 这不是合法 JSON", "utf8");
    const { ctx, routes } = makeCtx();
    plugin.apply(ctx, { dbPath: DB });
    const r = await call(routes, "/neural/bridges", {});
    const text = JSON.stringify(r.body);
    check("没有静默成功", !(r.status === 200 && r.body && r.body.ok !== false),
          "status " + r.status);
    check("报错里提到损坏", /损坏|拒绝/.test(text), text.slice(0, 120));
  }

  console.log("\n=== 3. 恢复成合法黑名单 → 又能用 ===");
  {
    const bl = join(dir, "桥黑名单.json");
    await writeFile(bl, JSON.stringify({ pairs: {} }), "utf8");
    const { ctx, routes } = makeCtx();
    plugin.apply(ctx, { dbPath: DB });
    const r = await call(routes, "/neural/bridges", {});
    check("恢复后 200", r.status === 200, "status " + r.status);
  }

  console.log("\n=== 4. 写候选用的是原子写（不留 .tmp）===");
  {
    const before = await readdir(dir);
    const { ctx, routes } = makeCtx();
    plugin.apply(ctx, { dbPath: DB });
    await call(routes, "/neural/bridge", { a: "n1", b: "n2", action: "accept" });
    const after = await readdir(dir);
    const leftovers = after.filter(f => /\.tmp-/.test(f));
    check("没有残留临时文件", leftovers.length === 0, leftovers.join(","));
    const bl = join(dir, "桥黑名单.json");
    const txt = await readFile(bl, "utf8").catch(() => "");
    check("黑名单文件仍可解析", (() => { try { JSON.parse(txt); return true; } catch { return false; } })());
  }

} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
