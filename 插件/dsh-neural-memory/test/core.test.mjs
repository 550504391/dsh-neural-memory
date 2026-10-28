/**
 * 核心行为测试 —— 直接 import ../lib/core.js，不复制实现
 *
 * （2026-10-28 修：原来是复制一份函数来测，测的和跑的不是同一份代码。）
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadDb, saveDb, addNode, connectNodes, recall,
  decayFactor, baseScore, matchScore, nowSec, exportMarkdown,
} from "../lib/core.js";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

const dir = await mkdtemp(join(tmpdir(), "neural-core-"));

try {
  // ---------- add ----------
  console.log("=== 1. add ===");
  const db = { nodes: {}, edges: {}, next_id: 1 };
  const a = addNode(db, "预算：只给1500", "事件", 0.9);
  const b = addNode(db, "最后谈成2000", "事件", 0.9);
  const c = addNode(db, "她问我：你会不会对我失望", "情绪", 1.0);
  check("add 返回递增 id", a === "n1" && b === "n2" && c === "n3");
  check("节点数 3", Object.keys(db.nodes).length === 3);
  check("空文本抛错", (() => { try { addNode(db, "  "); return false; } catch { return true; } })());

  // ---------- connect ----------
  console.log("\n=== 2. connect ===");
  const w1 = connectNodes(db, a, b);
  check("连上（权重 0.1）", Math.abs(w1 - 0.1) < 1e-9);
  connectNodes(db, b, c);
  check("边数 2", Object.keys(db.edges).length === 2);
  check("自己连自己报错", (() => { try { connectNodes(db, a, a); return false; } catch { return true; } })());
  check("不存在的节点报错", (() => { try { connectNodes(db, "n999", a); return false; } catch { return true; } })());

  connectNodes(db, b, a);
  check("反向连接是同一条边", Object.keys(db.edges).length === 2);
  check("权重累加", Math.abs(db.edges[[a, b].sort().join("|")].weight - 0.2) < 1e-9);

  // ---------- recall ----------
  console.log("\n=== 3. recall（字面） ===");
  const r1 = recall(db, "预算", 10, 1, 0.5, false);
  check("召回非空", r1.length > 0);
  check("第一条是预算那条", r1[0].id === a);

  console.log("\n=== 4. recall（扩散） ===");
  const r2 = recall(db, "失望", 10, 1, 0.5, false);
  check("失望排第一", r2[0].id === c);
  check("扩散到 2000", r2.some(x => x.id === b), "只有 " + r2.map(x => x.id).join(","));

  const r3 = recall(db, "失望", 10, 0, 0.5, false);
  check("spread=0 时不带邻居", !r3.some(x => x.id === b), r3.map(x => x.id).join(","));

  console.log("\n=== 5. 空查询 ===");
  check("空查询返回空", recall(db, "", 10, 1, 0.5, false).length === 0);

  // ---------- 衰减 ----------
  console.log("\n=== 6. 衰减 ===");
  const fresh = { importance: 0.8, lastActivated: nowSec() };
  const stale = { importance: 0.8, lastActivated: nowSec() - 60 * 86400 };
  check("60 天没激活的分更低", baseScore(stale) < baseScore(fresh));
  check("30 天正好减半", Math.abs(decayFactor({ lastActivated: nowSec() - 30 * 86400 }) - 0.5) < 0.01);
  check("刚激活 ≈ 1", Math.abs(decayFactor({ lastActivated: nowSec() }) - 1) < 0.01);

  // ---------- 巩固 ----------
  console.log("\n=== 7. 巩固 ===");
  const impBefore = db.nodes[a].importance;
  const cntBefore = db.nodes[a].activationCount;
  recall(db, "预算", 10, 1, 0.5, true);
  check("被召回后重要性 +0.01", Math.abs(db.nodes[a].importance - (impBefore + 0.01)) < 1e-9);
  check("激活次数 +1", db.nodes[a].activationCount === cntBefore + 1);

  // ---------- 存盘 / 读回 ----------
  console.log("\n=== 8. 存盘 → 读回 ===");
  const p = join(dir, "db.json");
  await saveDb(p, db);
  const back = await loadDb(p);
  check("读回节点数一致", Object.keys(back.nodes).length === 3);
  check("读回边数一致", Object.keys(back.edges).length === 2);
  check("文本一致", back.nodes.n1.text === "预算：只给1500");
  check("next_id 一致", back.next_id === db.next_id);

  // ---------- 新库 ----------
  console.log("\n=== 9. 文件不存在 = 新库 ===");
  const fresh2 = await loadDb(join(dir, "nope.json"));
  check("返回空库", Object.keys(fresh2.nodes).length === 0);
  check("标记 _new", fresh2._new === true);

  // ---------- 导出 ----------
  console.log("\n=== 10. 导出 md ===");
  const md = exportMarkdown(db);
  check("含标题", md.includes("# 神经记忆导出"));
  check("含节点文本", md.includes("预算：只给1500"));
  check("写明不是无损备份", md.includes("不含连接和激活历史"));

  // ---------- matchScore ----------
  console.log("\n=== 11. matchScore ===");
  check("精确命中", matchScore("预算", { text: "预算：只给1500" }) > 0.6);
  check("完全不相关为 0", matchScore("量子力学", { text: "预算：只给1500" }) === 0);

} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
