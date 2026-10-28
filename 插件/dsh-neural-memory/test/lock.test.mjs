/**
 * 乐观锁测试：两个进程同时写，不能互相覆盖
 *
 * 这是唯一会"真丢记忆"的地方，必须有用例。
 */
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const core = await import("../lib/core.js");

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log("  ✓ " + n); }
  else { fail++; console.log("  ✗ " + n + (extra ? "  → " + extra : "")); }
};

const dir = await mkdtemp(join(tmpdir(), "neural-lock-"));
const DB = join(dir, "db.json");

try {
  console.log("=== 1. 指纹一致 → 写成功 ===");
  {
    const db0 = { nodes: {}, edges: {}, next_id: 1 };
    await core.saveDb(DB, db0);
    const db = await core.loadDb(DB);
    check("loadDb 带了指纹", typeof db.__fp === "string" && db.__fp.length > 0);
    core.addNode(db, "第一版", "事件", 0.5, "2026-10-28");
    await core.saveDb(DB, db, { expect: db.__fp });
    const after = await core.loadDb(DB);
    check("写了进去", Object.keys(after.nodes).length === 1);
  }

  console.log("\n=== 2. 别人改过 → 报冲突，不覆盖 ===");
  {
    const mine = await core.loadDb(DB);        // 我读到 1 条
    // 另一个进程（比如 python 脚本）插了一条并保存
    const other = await core.loadDb(DB);
    core.addNode(other, "别人写的一条", "事件", 0.5, "2026-10-28");
    await core.saveDb(DB, other, { expect: other.__fp });

    // 我还在用旧指纹写
    core.addNode(mine, "我写的一条", "事件", 0.5, "2026-10-28");
    let err = null;
    try {
      await core.saveDb(DB, mine, { expect: mine.__fp });
    } catch (e) { err = e; }
    check("抛了冲突", err && err.code === "DB_CONFLICT", err && (err.code || err.message));

    const now = await core.loadDb(DB);
    const texts = Object.values(now.nodes).map(n => n.text);
    check("别人的那条还在", texts.includes("别人写的一条"));
    check("我没把它覆盖掉", !texts.includes("我写的一条"));
    check("库里现在 2 条", texts.length === 2, texts.length + " 条");
  }

  console.log("\n=== 3. 重读重放 → 两边的改动都在（这才是要的结果）===");
  {
    for (let attempt = 0; attempt < 3; attempt++) {
      const db = await core.loadDb(DB);
      const expect = db.__fp;
      core.addNode(db, "重试后我这条", "事件", 0.5, "2026-10-28");
      try {
        await core.saveDb(DB, db, { expect });
        break;
      } catch (e) {
        if (e.code !== "DB_CONFLICT") throw e;
        await new Promise(r => setTimeout(r, 60));
      }
    }
    const now = await core.loadDb(DB);
    const texts = Object.values(now.nodes).map(n => n.text);
    check("三边都在", texts.length === 3, texts.length + " 条");
    check("别人的那条没丢", texts.includes("别人写的一条"));
    check("我重试的那条进去了", texts.includes("重试后我这条"));
  }

  console.log("\n=== 4. expect:null 表示'应该是新库' ===");
  {
    const fresh = join(dir, "fresh.json");
    const db = await core.loadDb(fresh);        // 不存在 → 新库
    core.addNode(db, "x", "事件", 0.5, "");
    await core.saveDb(fresh, db, { expect: null });
    check("新库能写", (await core.loadDb(fresh)).nodes && Object.keys((await core.loadDb(fresh)).nodes).length === 1);

    const db2 = await core.loadDb(fresh);       // 现在有内容了
    core.addNode(db2, "y", "事件", 0.5, "");
    let err = null;
    try { await core.saveDb(fresh, db2, { expect: null }); } catch (e) { err = e; }
    check("已存在时 expect:null 报冲突", err && err.code === "DB_CONFLICT");
  }

  console.log("\n=== 5. 不传 expect → 老行为，不校验 ===");
  {
    const db = await core.loadDb(DB);
    core.addNode(db, "不校验的一条", "事件", 0.5, "");
    await core.saveDb(DB, db);                  // 不传第三个参数
    const now = await core.loadDb(DB);
    check("照样能写", Object.values(now.nodes).some(n => n.text === "不校验的一条"));
  }

  console.log("\n=== 6. 库被删掉了再写 → 报冲突（不能假装是空的）===");
  {
    const db = await core.loadDb(DB);
    await rm(DB, { force: true });
    let err = null;
    try { await core.saveDb(DB, db, { expect: db.__fp }); } catch (e) { err = e; }
    check("报冲突", err && err.code === "DB_CONFLICT", err && (err.code || err.message));
  }

  console.log("\n=== 7. 写库不能丢掉节点上的其他字段（source / para 这类）===");
  {
    const P = join(dir, "fields.json");
    const db0 = { nodes: {}, edges: {}, next_id: 1 };
    await core.saveDb(P, db0);
    // 手工塞一条带额外字段的（模拟灌入.py 写的）
    const raw = JSON.parse(await readFile(P, "utf8"));
    raw.nodes.n1 = {
      id: "n1", text: "这条来自某个文件的第一段", type: "故事", importance: 0.6,
      created: 1793000000, lastActivated: 1793000000, activationCount: 1,
      day: "2026-10-21", heading: "那天",
      source: "故事.md", para: 7, my_extra: "随便什么",
    };
    raw.next_id = 2;
    await writeFile(P, JSON.stringify(raw, null, 1), "utf8");

    const db = await core.loadDb(P);
    check("load 之后 source 还在", db.nodes.n1.source === "故事.md", String(db.nodes.n1.source));
    check("load 之后 para 还在", db.nodes.n1.para === 7, String(db.nodes.n1.para));
    check("load 之后自定义字段还在", db.nodes.n1.my_extra === "随便什么");

    core.addNode(db, "新加的一条", "事件", 0.5, "2026-10-28");
    await core.saveDb(P, db, { expect: db.__fp });
    const back = await core.loadDb(P);
    check("写回之后 source 还在", back.nodes.n1.source === "故事.md");
    check("写回之后 para 还在", back.nodes.n1.para === 7);
    check("写回之后自定义字段还在", back.nodes.n1.my_extra === "随便什么");
    check("校验字段仍然被规范", back.nodes.n1.type === "故事" && back.nodes.n1.importance === 0.6);
  }

} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
