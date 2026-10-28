/**
 * 可靠性测试 —— 针对审查报告里点名的每一条
 *
 * 全部用临时库，不碰正式数据。
 *
 * 覆盖：
 *   ① 库损坏时不覆盖（原来会当空库写回）
 *   ② 并发写不丢记录
 *   ③ 坏入参被拒绝（text=123、importance="0.8"）
 *   ④ importance=0 不被当成 0.5
 *   ⑤ day 做了路径/HTML 清洗
 *   ⑥ 保存失败要报错（不假装成功）
 *   ⑦ 原子写 + .bak
 */
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadDb, saveDb, addNode, connectNodes, recall,
  cleanText, cleanImportance, cleanDay, cleanTop, baseScore, exportSnapshot,
  MAX_TEXT,
} from "../lib/core.js";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

const dir = await mkdtemp(join(tmpdir(), "neural-rel-"));
const dbPath = join(dir, "neural-memory.json");

try {
  // ---------- ① 库损坏 ----------
  console.log("=== ① 库损坏时不能覆盖 ===");
  const garbage = '{"nodes": {"n1": {"text": "x"';   // 故意截断
  await writeFile(dbPath, garbage, "utf8");

  let threw = false;
  try {
    const db = await loadDb(dbPath);
    // 如果它不抛错，就是旧行为（返回空库）—— 那是要修掉的
    check("loadDb 对损坏文件抛错", false, "返回了 nodes=" + Object.keys(db.nodes).length);
  } catch (e) {
    threw = true;
    check("loadDb 对损坏文件抛错", /损坏/.test(e.message), e.message);
  }

  const after = await readFile(dbPath, "utf8");
  check("损坏的原文件没被改写", after === garbage, "内容变了");

  // 坏文件 + 写操作 → 应该失败，且不覆盖
  let writeThrew = false;
  try {
    const db = await loadDb(dbPath);
    addNode(db, "新的一条", "事件", 0.8);
    await saveDb(dbPath, db);
  } catch { writeThrew = true; }
  check("损坏时写入失败", writeThrew);
  check("损坏文件仍未被覆盖（第二次）", (await readFile(dbPath, "utf8")) === garbage);

  // ---------- ② 并发 ----------
  console.log("\n=== ② 并发写不丢记录 ===");
  const concurrencyPath = join(dir, "concurrent.json");

  // 模拟插件里的 withLock
  let chain = Promise.resolve();
  const withLock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const N = 20;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    withLock(async () => {
      const db = await loadDb(concurrencyPath);
      addNode(db, "并发记录 " + i, "事件", 0.5);
      await saveDb(concurrencyPath, db);
    })
  ));

  const concurrentDb = await loadDb(concurrencyPath);
  const count = Object.keys(concurrentDb.nodes).length;
  check(N + " 条并发全部保留", count === N, "实际 " + count + " 条");

  // id 不重复
  const ids = Object.keys(concurrentDb.nodes);
  check("id 没有重复", new Set(ids).size === ids.length);

  // ---------- ③ 坏入参 ----------
  console.log("\n=== ③ 坏入参被拒绝 ===");
  check("text=123 不合法", cleanText(123) === null);
  check("text={} 不合法", cleanText({}) === null);
  check("text='   ' 不合法", cleanText("   ") === null);
  check("text 超长被截断", cleanText("字".repeat(MAX_TEXT + 500)).length === MAX_TEXT);
  check("text=123 的 addNode 抛错", (() => {
    try { addNode({ nodes: {}, edges: {}, next_id: 1 }, 123); return false; }
    catch { return true; }
  })());
  check("importance='0.8' 转成 0.8", cleanImportance("0.8") === 0.8);
  check("importance='abc' 退回 0.5", cleanImportance("abc") === 0.5);
  check("importance=NaN 退回 0.5", cleanImportance(NaN) === 0.5);
  check("importance=-1 夹到 0", cleanImportance(-1) === 0);
  check("importance=5 夹到 1", cleanImportance(5) === 1);
  check("top=-3 退回默认", cleanTop(-3) === 20);
  check("top=99999 夹到 100", cleanTop(99999) === 100);

  // ---------- ④ importance = 0 ----------
  console.log("\n=== ④ importance=0 不当成 0.5 ===");
  check("cleanImportance(0) === 0", cleanImportance(0) === 0);
  const zeroNode = {
    id: "n1", text: "零重要性", type: "note", importance: 0,
    created: 1, lastActivated: Date.now() / 1000, activationCount: 0, day: "",
  };
  const hiNode = { ...zeroNode, id: "n2", text: "普通", importance: 0.1 };
  check("importance=0 的基分低于 0.1", baseScore(zeroNode) < baseScore(hiNode),
        baseScore(zeroNode).toFixed(3) + " vs " + baseScore(hiNode).toFixed(3));

  // ---------- ⑤ day 清洗 ----------
  console.log("\n=== ⑤ day 做了清洗 ===");
  check("正常日期保留", cleanDay("2026-10-28") === "2026-10-28");
  check("'常驻' 保留", cleanDay("常驻") === "常驻");
  check("HTML 被清掉", cleanDay("<img src=x onerror=alert(1)>") === "");
  check("路径跳转被清掉", cleanDay("../../etc") === "");
  check("绝对路径被清掉", cleanDay("C:\\Windows") === "");
  check("空串保留为空", cleanDay("") === "");

  // ---------- ⑥ 保存失败要报错 ----------
  console.log("\n=== ⑥ 保存失败必须报错 ===");
  const impossible = join(dir, "no-such-dir-as-file");
  await writeFile(impossible, "占位", "utf8");
  const badPath = join(impossible, "sub", "db.json");   // 父级是文件，必然失败
  let saveThrew = false;
  try {
    await saveDb(badPath, { nodes: {}, edges: {}, next_id: 1 });
  } catch (e) {
    saveThrew = true;
    check("saveDb 失败时抛错", /写临时文件失败|替换库文件失败|目录建不出来/.test(e.message), e.message);
  }
  if (!saveThrew) check("saveDb 失败时抛错", false, "没有抛错（静默失败）");

  // ---------- ⑦ 原子写 + .bak ----------
  console.log("\n=== ⑦ 原子写 + .bak ===");
  const atomicPath = join(dir, "atomic.json");
  await saveDb(atomicPath, { nodes: {}, edges: {}, next_id: 1 });
  check("第一次写入成功", (await stat(atomicPath)).size > 0);

  const files1 = await readdir(dir);
  check("没有留下 .tmp 临时文件", !files1.some(f => f.includes(".tmp-")),
        files1.filter(f => f.includes(".tmp-")).join(","));

  // 第二次写入 → 应该生成 .bak
  const db2 = await loadDb(atomicPath);
  addNode(db2, "第二条", "事件", 0.5);
  await saveDb(atomicPath, db2);

  const files2 = await readdir(dir);
  check("第二次写入后出现 .bak", files2.includes("atomic.json.bak"));

  const bak = await readFile(join(dir, "atomic.json.bak"), "utf8");
  const bakJson = JSON.parse(bak);
  check(".bak 是上一版（0 条）", Object.keys(bakJson.nodes).length === 0,
        Object.keys(bakJson.nodes).length + " 条");

  const now = await loadDb(atomicPath);
  check("正式文件是新版（1 条）", Object.keys(now.nodes).length === 1);

  // ---------- ⑧ 无损快照 ----------
  console.log("\n=== ⑧ 无损快照含边 ===");
  const snapDb = { nodes: {}, edges: {}, next_id: 1 };
  const a = addNode(snapDb, "A", "事件", 0.8);
  const b = addNode(snapDb, "B", "事件", 0.8);
  connectNodes(snapDb, a, b);
  const snap = JSON.parse(exportSnapshot(snapDb));
  check("快照有 nodes", Object.keys(snap.nodes).length === 2);
  check("快照有 edges", Object.keys(snap.edges).length === 1);
  check("快照有 next_id", snap.next_id === 3);
  check("快照能直接当库读回", (() => {
    const back = JSON.parse(exportSnapshot(snapDb));
    return back.nodes[a] && back.edges[[a, b].sort().join("|")];
  })());

  // ---------- ⑨ 坏节点被隔离，不拖垮整库 ----------
  console.log("\n=== ⑨ 坏节点隔离 ===");
  const mixedPath = join(dir, "mixed.json");
  await writeFile(mixedPath, JSON.stringify({
    nodes: {
      n1: { text: "好的", type: "事件", importance: 0.8, created: 1, lastActivated: 1, activationCount: 1, day: "" },
      n2: { text: 123, type: "事件", importance: 0.8 },        // 坏：text 不是字符串
      n3: { type: "事件" },                                     // 坏：没 text
      n4: null,                                                 // 坏
    },
    edges: {
      "n1|n2": { a: "n1", b: "n2", weight: 0.1, count: 1 },
      "n1|n3": { a: "n1", b: "n3", weight: 0.1, count: 1 },
    },
    next_id: 5,
  }), "utf8");

  const mixed = await loadDb(mixedPath);
  check("好节点保留", !!mixed.nodes.n1);
  check("坏节点被丢弃", !mixed.nodes.n2 && !mixed.nodes.n3 && !mixed.nodes.n4);
  check("指向坏节点的边被丢弃", Object.keys(mixed.edges).length === 0);
  check("_dropped 记录了数量", mixed._dropped === 3, "实际 " + mixed._dropped);
  check("坏库仍能召回", recall(mixed, "好的", 10, 1, 0.5, false).length === 1);

  // ---------- ⑩ preview 不强化 ----------
  console.log("\n=== ⑩ preview 不强化 ===");
  const pvDb = { nodes: {}, edges: {}, next_id: 1 };
  const pid = addNode(pvDb, "预览测试", "事件", 0.5);
  const impBefore = pvDb.nodes[pid].importance;
  const cntBefore = pvDb.nodes[pid].activationCount;
  recall(pvDb, "预览", 10, 1, 0.5, false);
  check("preview 不改重要性", pvDb.nodes[pid].importance === impBefore);
  check("preview 不改激活次数", pvDb.nodes[pid].activationCount === cntBefore);
  recall(pvDb, "预览", 10, 1, 0.5, true);
  check("真召回会强化", pvDb.nodes[pid].activationCount === cntBefore + 1);

} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
