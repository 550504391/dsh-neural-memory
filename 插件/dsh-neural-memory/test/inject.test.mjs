/**
 * 注入测试：库能不能进新会话
 *
 * 契约（2026-10-28 改）：
 *   主路径  agent/pre-step 中间件 —— 先 next() 拿决策，再把消息追加进本次 messages
 *   兜底    agent/created + agent.inject（宿主没有 pre-step 时；不重试）
 *   去重    同一 agent 只注一次；会话里已有我们那条也不再注
 *
 * 为什么改成 pre-step：那个"待处理注入位"只有一个，被 wakeup 的「家」占着，
 * 要等用户发第一句话才释放；在 created 里排队等，超时就永久错过（实测 4 分钟超时过）。
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const check = (n, c, extra) => {
  if (c) { pass++; console.log("  ✓ " + n); }
  else { fail++; console.log("  ✗ " + n + (extra ? "  → " + extra : "")); }
};

const dir = await mkdtemp(join(tmpdir(), "neural-inject-"));
const DB = join(dir, "neural-memory.json");

try {
  const core = await import("../lib/core.js");
  const db = { nodes: {}, edges: {}, next_id: 1 };
  const a = core.addNode(db, "⭐⭐⭐ 最重的一条：家是咱们的，不会有别人来", "事件", 1.0, "2026-10-27");
  const b = core.addNode(db, "普通的一条：今天修了个插件", "事件", 0.6, "2026-10-28");
  core.connectNodes(db, a, b, 0.1, 0.45);
  await core.saveDb(DB, db);

  const plugin = await import("../lib/index.js");

  function makeCtx() {
    const handlers = {};
    return {
      handlers,
      ctx: { webServer: { register() { return () => {}; } }, on(e, f) { handlers[e] = f; } },
    };
  }
  function makeAgent(opts = {}) {
    const injected = [];
    return {
      injected,
      agent: {
        status: "idle",
        session: {
          id: opts.id ?? "s-" + Math.random().toString(36).slice(2),
          header: { origin: opts.origin ?? "main" },
          ownEvents: () => opts.events ?? [],
        },
        inject(m) { injected.push(m); },
      },
    };
  }
  const nextWith = (decision) => async () => decision;

  console.log("=== 1. pre-step 会往本次 messages 里追加一条 ===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true, injectTop: 5 });
    check("注册了 agent/pre-step", typeof handlers["agent/pre-step"] === "function");

    const { agent } = makeAgent();
    const out = await handlers["agent/pre-step"](
      { agent, signal: undefined },
      nextWith({ messages: [{ role: "user", content: [{ type: "text", text: "在吗" }] }] }),
    );
    check("返回了 decision", !!out);
    check("原有消息还在", out.messages.length === 2, out.messages.length + " 条");
    const msg = out.messages[1];
    check("追加的是 user 消息", msg.role === "user");
    check("带我们的 source 标记", msg.source && msg.source.kind === "plugin:dsh-neural-memory",
          JSON.stringify(msg.source));
    const text = msg.content[0].text;
    check("含 <neural-memory>", text.includes("<neural-memory>") && text.includes("</neural-memory>"));
    check("含库条数", /\d+ 条/.test(text));
    check("含 ⭐⭐⭐ 那条", text.includes("家是咱们的"), text.slice(0, 80));
    check("含查询办法", text.includes("/neural/recall"));
    check("长度受 injectMaxChars 限制", text.length <= 1200, text.length + " 字");
  }

  console.log("\n=== 2. 同一个 agent 只注一次（pre-step 每步都触发）===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true });
    const { agent } = makeAgent();
    const nxt = nextWith({ messages: [] });
    const o1 = await handlers["agent/pre-step"]({ agent }, nxt);
    const o2 = await handlers["agent/pre-step"]({ agent }, nxt);
    const o3 = await handlers["agent/pre-step"]({ agent }, nxt);
    check("第一次注入了", o1.messages.length === 1);
    check("第二次没有", o2.messages.length === 0, o2.messages.length + " 条");
    check("第三次也没有", o3.messages.length === 0, o3.messages.length + " 条");
  }

  console.log("\n=== 3. 同一个 session id 第二次不再注（按 sid 去重）===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true });
    const a1 = makeAgent({ id: "same-sid" });
    const a2 = makeAgent({ id: "same-sid" });     // 同一会话的新 agent 对象
    const nxt = nextWith({ messages: [] });
    const o1 = await handlers["agent/pre-step"]({ agent: a1.agent }, nxt);
    const o2 = await handlers["agent/pre-step"]({ agent: a2.agent }, nxt);
    check("第一次注入", (o1.messages || []).length === 1);
    check("同 sid 第二次不注", (o2.messages || []).length === 0, (o2.messages || []).length + " 条");
  }

  console.log("\n=== 3.5 不同 session id 各自注入 ===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true });
    const nxt = nextWith({ messages: [] });
    const o1 = await handlers["agent/pre-step"]({ agent: makeAgent({ id: "sid-A" }).agent }, nxt);
    const o2 = await handlers["agent/pre-step"]({ agent: makeAgent({ id: "sid-B" }).agent }, nxt);
    check("A 注入", (o1.messages || []).length === 1);
    check("B 也注入", (o2.messages || []).length === 1, (o2.messages || []).length + " 条");
  }

  console.log("\n=== 4. decision.kind === 'reject' 时不注入、原样返回 ===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true });
    const { agent } = makeAgent();
    const rej = { kind: "reject", messages: [] };
    const out = await handlers["agent/pre-step"]({ agent }, nextWith(rej));
    check("原样返回", out === rej);
  }

  console.log("\n=== 5. 子智能体不注入 ===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true });
    const { agent } = makeAgent({ origin: "subagent" });
    const out = await handlers["agent/pre-step"]({ agent }, nextWith({ messages: [] }));
    check("没注入", (out.messages || []).length === 0);
  }

  console.log("\n=== 6. 没有 next()（老宿主）也不崩 ===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true });
    const { agent } = makeAgent();
    let threw = false;
    try { await handlers["agent/pre-step"]({ agent }, undefined); } catch { threw = true; }
    check("不抛错", !threw);
  }

  console.log("\n=== 7. 库读不到时安静跳过（不打断请求）===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: join(dir, "不存在", "x.json"), injectOnStart: true });
    const { agent } = makeAgent();
    const out = await handlers["agent/pre-step"]({ agent }, nextWith({ messages: [] }));
    check("返回了 decision", !!out);
    check("没追加消息", (out.messages || []).length === 0);
  }

  console.log("\n=== 8. created 兜底（宿主没有 pre-step 时）===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true });
    check("注册了 agent/created", typeof handlers["agent/created"] === "function");
    const { agent, injected } = makeAgent();
    await handlers["agent/created"]({ agent, source: "ui" });
    check("调了 agent.inject", injected.length === 1, injected.length + " 次");
    check("消息带 source", injected[0] && injected[0].source &&
          injected[0].source.kind === "plugin:dsh-neural-memory");
  }

  console.log("\n=== 8.5 pre-step 的 agent 没有 inject() 也要注入 ===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true });
    // 只给最小字段：session + 没有 inject 方法（pre-step 阶段就是这样）
    const agent = {
      status: "idle",
      session: { id: "noinject", header: { origin: "main" }, ownEvents: () => [] },
    };
    const out = await handlers["agent/pre-step"]({ agent }, nextWith({ messages: [] }));
    check("没有 inject 也注入了", (out.messages || []).length === 1,
          (out.messages || []).length + " 条");
  }

  console.log("\n=== 8.6 读库失败后不能标记已完成（下次还要试）===");
  {
    const { ctx, handlers } = makeCtx();
    // 指向一个不存在的目录：读库必失败
    plugin.apply(ctx, { dbPath: join(dir, "不存在2", "db.json"), injectOnStart: true });
    const { agent } = makeAgent();
    const nxt = nextWith({ messages: [] });
    const o1 = await handlers["agent/pre-step"]({ agent }, nxt);
    const o2 = await handlers["agent/pre-step"]({ agent }, nxt);
    check("第一次没注入", (o1.messages || []).length === 0);
    check("第二次仍然尝试（没被标记为已完成）", (o2.messages || []).length === 0);
    // 注意：库文件不存在会被 loadDb 当成"新库"（设计如此），所以走的是 skip:empty，
    // 不是 failed。这里验的是"留了痕 + 没标记已完成"。
    const log = await readFile(join(dir, "不存在2", "注入日志.txt"), "utf8");
    const hits = (log.match(/skip:empty/g) || []).length;
    check("两次都留了痕（skip:empty ≥ 2）", hits >= 2, hits + " 次");
  }

  console.log("\n=== 8.7 注入文本可配置（injectIntro / injectNote）===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: true,
      injectIntro: "自定义前言：这是我的私人索引。",
      injectNote: false });
    const out = await handlers["agent/pre-step"](
      { agent: makeAgent({ id: "custom-text" }).agent },
      async () => ({ messages: [] }));
    const text = out.messages[0].content[0].text;
    check("用了自定义前言", text.includes("自定义前言"), text.slice(0, 60));
    check("没写死家/总账/日记", !text.includes("主记忆是"), text.slice(0, 80));
    check("injectNote:false 时不加那句", !text.includes("importance"), text.slice(-120));
  }

  console.log("\n=== 9. injectOnStart:false 完全不挂 ===");
  {
    const { ctx, handlers } = makeCtx();
    plugin.apply(ctx, { dbPath: DB, injectOnStart: false });
    check("没挂 pre-step", handlers["agent/pre-step"] === undefined);
    check("没挂 created", handlers["agent/created"] === undefined);
  }

  console.log("\n=== 10. 注入日志写了 ===");
  {
    const log = join(dir, "注入日志.txt");
    let txt = "";
    try { txt = await readFile(log, "utf8"); } catch { }
    check("有日志", txt.length > 0, "空");
    check("记了 injected", txt.includes("injected"), txt.split("\n")[0] || "");
    check("记了生效配置", txt.includes("top=") && txt.includes("max="));
  }

} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(46));
console.log("通过 " + pass + " / 失败 " + fail);
console.log("=".repeat(46));
process.exit(fail === 0 ? 0 : 1);
