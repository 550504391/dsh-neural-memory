/**
 * 多进程并发写：不能丢数据
 *
 * 真起子进程。之前只测过"同进程内的冲突"，那道锁挡不住两个真实进程 ——
 * 实测（2026-10-28）两进程各写 25 条，只活下来 31 条：
 *   Windows 的 rename 覆盖不是原子的，校验通过之后仍然会被插队覆盖。
 * 现在靠 .lock 文件把"核对 + 写临时 + 替换"整段串行化。
 */
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log("  ✓ " + n); }
  else { fail++; console.log("  ✗ " + n + (extra ? "  → " + extra : "")); }
};

const CORE = new URL("../lib/core.js", import.meta.url).href;
const root = await mkdtemp(join(tmpdir(), "neural-concur-"));
const DB = join(root, "db.json");
const WORKER = join(root, "worker.mjs");

await writeFile(WORKER, `
const { loadDb, saveDb, addNode } = await import(${JSON.stringify(CORE)});
const [dbPath, tag, count] = process.argv.slice(2);
let done = 0, conflicts = 0;
for (let i = 0; i < Number(count); i++) {
  let ok = false;
  for (let attempt = 0; attempt < 20 && !ok; attempt++) {
    const db = await loadDb(dbPath);
    const expect = db.__fp === undefined ? null : db.__fp;
    addNode(db, "并发 " + tag + " 第 " + i + " 条", "事件", 0.5, "2026-10-28");
    try {
      await saveDb(dbPath, db, { expect });
      ok = true; done++;
    } catch (e) {
      if (e.code !== "DB_CONFLICT") throw e;
      conflicts++;
      await new Promise(r => setTimeout(r, 5 + Math.random() * 30));
    }
  }
  if (!ok) { console.error("放弃第 " + i + " 条"); process.exit(2); }
}
console.log(JSON.stringify({ tag, done, conflicts }));
`, "utf8");

const run = (tag, count) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [WORKER, DB, tag, String(count)],
                  { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", d => out += d);
  p.stderr.on("data", d => err += d);
  p.on("close", code => code === 0 ? resolve(out.trim())
                                   : reject(new Error(err || ("exit " + code))));
});

try {
  console.log("=== 1. 两个进程各写 25 条 ===");
  const [a, b] = await Promise.all([run("A", 25), run("B", 25)]);
  const ra = JSON.parse(a), rb = JSON.parse(b);
  console.log("  A: done=" + ra.done + " conflicts=" + ra.conflicts);
  console.log("  B: done=" + rb.done + " conflicts=" + rb.conflicts);

  const db = JSON.parse(await readFile(DB, "utf8"));
  const n = Object.keys(db.nodes).length;
  check("50 条一条不少", n === 50, n + " 条");
  check("没有重复文本", new Set(Object.values(db.nodes).map(x => x.text)).size === 50);
  check("确实发生过冲突", ra.conflicts + rb.conflicts > 0,
        (ra.conflicts + rb.conflicts) + " 次");

  console.log("\n=== 2. 四个进程各写 15 条 ===");
  const base = n;
  const rest = await Promise.all([run("C", 15), run("D", 15), run("E", 15), run("F", 15)]);
  const rs = rest.map(o => JSON.parse(o));
  const db2 = JSON.parse(await readFile(DB, "utf8"));
  check("60 条全在", Object.keys(db2.nodes).length === base + 60,
        Object.keys(db2.nodes).length + " 条（期望 " + (base + 60) + "）");
  check("四个都完成", rs.every(x => x.done === 15));

  console.log("\n=== 3. 没留下垃圾 ===");
  check("锁文件已释放", !existsSync(DB + ".lock"));
  const files = await readdir(root);
  check("没有半截临时文件", files.filter(f => f.includes(".tmp-")).length === 0,
        files.filter(f => f.includes(".tmp-")).join(", "));
  check("没有 .bak 以外的杂物",
        files.filter(f => !["db.json", "db.json.bak", "worker.mjs"].includes(f)).length === 0,
        files.join(", "));

} finally {
  try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* 清理失败不影响结论 */ }
}

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
