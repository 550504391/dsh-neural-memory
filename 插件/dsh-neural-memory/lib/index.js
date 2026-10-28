/**
 * dsh-neural-memory · 插件（host 半部）
 *
 * 只管三件事：
 *   ① 解析库路径（config → env → 用户配置文件 → home 默认）
 *   ② 注册 HTTP 路由，转调 lib/core.js
 *   ③ 串行化所有"读-改-写"（一个全局队列），避免并发覆盖
 *
 * 所有核心逻辑在 lib/core.js —— 测试直接测那份，不复制。
 *
 * 设计约束（跟 wakeup / wallpaper-engine 一致）：
 *   - 不 import 任何 @deepseek-ai/* 包
 *   - 只用 node 内置模块
 *   - 读不到库、写不进库，都要把错误告诉调用方（不吞）
 *
 * @module dsh-neural-memory
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";

import {
  loadDb, saveDb, addNode, connectNodes, recall, exportMarkdown, exportSnapshot,
  cleanText, cleanKind, cleanImportance, cleanDay, cleanTop, cleanQuery,
  MAX_TEXT,
} from "./core.js";

export const name = "neural-memory";

export const inject = ["webServer"];

/** 测试用：等所有后台注入任务落定（生产代码不用它） */
let __lastBackground = null;
export async function flushInjections(timeoutMs = 8000) {
  const sets = __lastBackground ? [__lastBackground] : [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = sets.flatMap(s => [...s]);
    if (!live.length) return true;
    await Promise.race([
      Promise.allSettled(live),
      new Promise(r => setTimeout(r, 100)),
    ]);
  }
  return false;
}

// 这条消息是谁塞的（跟 wakeup 同一套约定）
const SOURCE = "dsh-neural-memory";
const KIND = `plugin:${SOURCE}`;

/** 每次注入写一行，用来验证它到底跑没跑 */
async function noteInject(text, dbPath) {
  try {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const p = dbPath || (await resolveDbPath(process.env.NEURAL_MEMORY_DB));
    const dir = dirname(p);
    await mkdir(dir, { recursive: true });
    const line = new Date().toISOString() + "  " + text + "\n";
    await appendFile(join(dir, "注入日志.txt"), line, "utf8");
  } catch { /* 日志失败不影响主流程 */ }
}

// ---------- 库路径 ----------

const HOME_DIR = join(homedir(), ".dsh-neural-memory");
const HOME_DB = join(HOME_DIR, "neural-memory.json");
const HOME_CFG = join(HOME_DIR, "config.json");

/**
 * 解析库路径，两边（JS/Python）用同一套规则：
 *   ① 插件 config.dbPath（显式指定，最高优先）
 *   ② 环境变量 NEURAL_MEMORY_DB
 *   ③ ~/.dsh-neural-memory/config.json 里的 dbPath
 *   ④ ~/.dsh-neural-memory/neural-memory.json
 */
export async function resolveDbPath(configured) {
  if (typeof configured === "string" && configured.trim()) {
    const p = configured.trim();
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }
  if (process.env.NEURAL_MEMORY_DB) {
    return resolve(process.env.NEURAL_MEMORY_DB);
  }
  try {
    const raw = await readFile(HOME_CFG, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.dbPath === "string" && j.dbPath.trim()) {
      return resolve(j.dbPath.trim());
    }
  } catch { /* 没有配置文件就继续往下 */ }
  return HOME_DB;
}

// ---------- 串行队列 ----------

/**
 * 所有改变库的操作排成一队（单进程内）。
 * 多进程共写（浏览器会话 + 命令行同时改）仍然需要文件锁或数据库 ——
 * README 里写明了这个边界。
 */
let chain = Promise.resolve();

function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

// ---------- 错误 ----------

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// ---------- 插件 ----------

export function apply(ctx, config) {
  const cfg = config || {};
  let dbPathPromise = null;

  function getDbPath() {
    if (!dbPathPromise) dbPathPromise = resolveDbPath(cfg.dbPath);
    return dbPathPromise;
  }

  const webServer = ctx && ctx.webServer;
  if (!webServer || typeof webServer.register !== "function") {
    return () => {};
  }

  const disposers = [];

  function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
  }

  function registerJson(path, handler) {
    disposers.push(webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const out = await handler(body);
          sendJson(res, 200, out);
        } catch (e) {
          const status = (e && e.status) || 500;
          sendJson(res, status, {
            ok: false,
            error: String((e && e.message) || e),
          });
        }
      },
    }));
  }

  function registerGet(path, handler) {
    disposers.push(webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        try {
          const out = await handler(req);
          if (out && out.__raw) {
            res.statusCode = 200;
            res.setHeader("Content-Type", out.type);
            res.setHeader("Cache-Control", "no-store");
            res.end(out.body);
            return;
          }
          sendJson(res, 200, out);
        } catch (e) {
          sendJson(res, (e && e.status) || 500, {
            ok: false,
            error: String((e && e.message) || e),
          });
        }
      },
    }));
  }

  /**
   * 带乐观锁的读-改-写。
   *
   * fn(db) 里改 db 并返回结果；外面负责核对指纹、冲突就重读重来。
   * 为什么要重读重来：别的进程（比如我手动跑的 python 脚本）可能在
   * 我们读完之后改了库。直接写下去就是覆盖别人的改动 —— 那是真丢记忆。
   */
  const mutate = (fn, tries = 3) => withLock(async () => {
    const dbPath = await getDbPath();
    let lastErr = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      const db = await loadDb(dbPath);
      const expect = db.__fp === undefined ? null : db.__fp;
      const result = await fn(db, dbPath);
      try {
        await saveDb(dbPath, db, { expect });
        return result;
      } catch (e) {
        if (e && e.code === "DB_CONFLICT") {
          lastErr = e;
          await new Promise(r => setTimeout(r, 40 + attempt * 60));
          continue;
        }
        throw e;
      }
    }
    throw new Error("写冲突：库一直被别的进程改，重试 " + tries + " 次没成功（" +
                    ((lastErr && lastErr.message) || "") + "）");
  });

  // ---------- 桥：候选 / 黑名单 / 拆除 ----------
  //
  // 设计：
  //   灌入时自动产出"候选桥"（跨来源、词面相近），但不直接连；
  //   人审 → 接受才连（0.45）；放着不管超过 N 天 → 自动连（0.25）；
  //   拆掉的进黑名单，以后候选不再生成、自动沉淀也不再连。

  const sideFile = async (dbPath, name) => {
    const { dirname, join } = await import("node:path");
    return join(dirname(dbPath), name);
  };

  // 读辅助文件（候选 / 黑名单）。
  //   文件不存在 → 用 fallback
  //   文件存在但坏了 → strict 时抛错。黑名单被当空的后果是
  //   把用户拒绝过的关系重新建议、甚至自动连上，所以这一处不能吞。
  const readSide = async (file, fallback, opts = {}) => {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch (e) {
      const code = e && e.code;
      if (code === "ENOENT" || code === "ENOTDIR") return fallback;
      if (opts.strict) {
        throw new Error("辅助文件损坏，拒绝继续（否则会把你拒绝过的关联重新捡回来）: " +
          String(file).split(/[\\/]/).pop() + " → " + ((e && e.message) || e));
      }
      return fallback;
    }
  };

  // 原子写：先写 .tmp 再改名。直接 writeFile 可能留下半截文件。
  const writeSide = async (file, obj) => {
    const { writeFile, mkdir, rename } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
    await writeFile(tmp, JSON.stringify(obj, null, 1), "utf8");
    await rename(tmp, file);
  };

  const bridgeKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);

  const loadBlacklist = async (dbPath) => {
    const j = await readSide(await sideFile(dbPath, "桥黑名单.json"), { pairs: {} }, { strict: true });
    return (j && j.pairs) || {};
  };

  const [/* 下面用到的常量 */ ] = [];

  // 过期候选自动连：每次新会话开头跑一次（有节流）
  let lastSweepAt = 0;
  const sweepCandidates = async () => {
    const now = Date.now();
    if (now - lastSweepAt < 10 * 60 * 1000) return 0;   // 10 分钟内只跑一次
    lastSweepAt = now;
    const days = Number(cfg.bridgeAutoConnectDays);
    const limitDays = Number.isFinite(days) && days >= 0 ? days : 7;
    const dbPath = await getDbPath();
    const candFile = await sideFile(dbPath, "桥候选.json");
    const store = await readSide(candFile, { items: [] });
    const items = Array.isArray(store.items) ? store.items : [];
    if (!items.length) return 0;

    const black = await loadBlacklist(dbPath);
    const cutoff = now - limitDays * 24 * 3600 * 1000;
    const expired = items.filter(it => (it.createdAt || 0) <= cutoff);
    if (!expired.length) return 0;

    let done = 0;
    try {
      await mutate(async (db, p2) => {
        for (const it of expired) {
          const k = bridgeKey(it.a, it.b);
          if (black[k]) continue;
          if (!db.nodes[it.a] || !db.nodes[it.b]) continue;
          if (db.edges[k]) continue;
          connectNodes(db, it.a, it.b, 0.1, 0.25);
          done++;
        }
        return done;
      });
    } catch { return 0; }

    if (done) {
      const keep = items.filter(it => !expired.some(e => bridgeKey(e.a, e.b) === bridgeKey(it.a, it.b)));
      await writeSide(candFile, { generatedAt: store.generatedAt || 0, items: keep });
      try {
        const { appendFile } = await import("node:fs/promises");
        const { join, dirname } = await import("node:path");
        await appendFile(join(dirname(dbPath), "桥日志.txt"),
          new Date().toISOString() + "  过期自动连 " + done + " 条（放了超过 " + limitDays + " 天）\n",
          "utf8");
      } catch { /* 日志失败不影响 */ }
    }
    return done;
  };

  // ---------- 写 ----------

  registerJson("/neural/remember", (body) => {
    const text = cleanText(body.text);
    if (!text) throw bad("text 必须是非空字符串（长度 1~" + MAX_TEXT + "）");
    // cleanText 会截断，但截断是静默丢内容 —— 这里明确拒绝，别让人以为存进去了
    if (typeof body.text === "string" && body.text.trim().length > MAX_TEXT) {
      throw bad("text 太长（" + body.text.trim().length + " 字，上限 " + MAX_TEXT + "），请拆成几条");
    }
    const kind = cleanKind(body.kind);
    const importance = cleanImportance(body.importance);
    const day = cleanDay(body.day);

    return mutate(async (db, dbPath) => {
      const id = addNode(db, text, kind, importance, day);
      return { ok: true, id, dropped: db._dropped || 0, dbPath };
    });
  });

  registerJson("/neural/connect", async (body) => {
    if (typeof body.a !== "string" || typeof body.b !== "string") {
      throw bad("a / b 必须是节点 id 字符串");
    }
    const dbPath = await getDbPath();
    const black = await loadBlacklist(dbPath);
    if (black[bridgeKey(body.a, body.b)]) {
      throw bad("这条关系被你拆过（在黑名单里），不再自动连。要恢复请用 /neural/bridge 的 restore");
    }
    return mutate(async (db) => {
      // weight 可选：手动建的桥给一个明确的强度（不给就还是增量 0.1）
      const w = connectNodes(db, body.a, body.b, 0.1, body.weight);
      return { ok: true, weight: Math.round(w * 100) / 100 };
    });
  });

  // ---------- 桥的三个路由 ----------

  const sweepLimitDays = () => {
    const d = Number(cfg.bridgeAutoConnectDays);
    return Number.isFinite(d) && d >= 0 ? d : 7;
  };

  /** 列：跨来源桥 + 待审候选 */
  registerGet("/neural/bridges", async () => {
    const dbPath = await getDbPath();
    const db = await loadDb(dbPath);
    const kindOf = (id) => (db.nodes[id] && db.nodes[id].type) || "?";
    const textOf = (id) => ((db.nodes[id] && db.nodes[id].text) || "").slice(0, 60);

    const bridges = [];
    for (const [k, e] of Object.entries(db.edges)) {
      const ka = kindOf(e.a), kb = kindOf(e.b);
      if (ka === kb) continue;              // 只列跨来源的（同来源的是灌入时自动连的）
      bridges.push({
        key: k, a: e.a, b: e.b,
        weight: Math.round(e.weight * 100) / 100,
        count: e.count || 0,
        ka, kb, ta: textOf(e.a), tb: textOf(e.b),
      });
    }
    bridges.sort((x, y) => y.weight - x.weight);

    const black = await loadBlacklist(dbPath);
    const candFile = await sideFile(dbPath, "桥候选.json");
    const store = await readSide(candFile, { items: [] });
    const now = Date.now();
    const limitDays = sweepLimitDays();
    const candidates = (store.items || [])
      .filter(it => !black[bridgeKey(it.a, it.b)] && db.nodes[it.a] && db.nodes[it.b])
      .map(it => {
        const ageDays = (now - (it.createdAt || 0)) / 86400000;
        return {
          ...it,
          ageDays: Math.round(ageDays * 10) / 10,
          autoInDays: Math.max(0, Math.round((limitDays - ageDays) * 10) / 10),
        };
      });

    return {
      ok: true,
      totalEdges: Object.keys(db.edges).length,
      bridges: bridges.slice(0, 300),
      candidates,
      limitDays,
      blacklisted: Object.keys(black).length,
    };
  });

  /** 拆一条桥（进黑名单，以后不再自动连）
   *
   *  顺序很重要：先落"拒绝记录"，再删边。
   *  原来是先删边再写黑名单 —— 黑名单写失败时边已经没了，
   *  用户重试会得到"没有连接"，那条拒绝决定就永久丢了。
   */
  registerJson("/neural/disconnect", async (body) => {
    if (typeof body.a !== "string" || typeof body.b !== "string") {
      throw bad("a / b 必须是节点 id 字符串");
    }
    const dbPath = await getDbPath();
    const key = bridgeKey(body.a, body.b);

    // ① 先写黑名单（失败就抛，主库完全没动）
    const blFile = await sideFile(dbPath, "桥黑名单.json");
    const bl = await readSide(blFile, { pairs: {} }, { strict: true });
    bl.pairs = bl.pairs || {};
    bl.pairs[key] = {
      a: body.a, b: body.b,
      at: Date.now(),
      reason: String(body.reason || "").slice(0, 200),
    };
    await writeSide(blFile, bl);

    // ② 再删边；删失败就把黑名单回滚，别留下"以后不再连"的记录
    try {
      await mutate(async (db) => {
        if (!db.edges[key]) throw bad("这两个节点之间没有连接");
        delete db.edges[key];
        return true;
      });
    } catch (e) {
      try {
        delete bl.pairs[key];
        await writeSide(blFile, bl);
      } catch { /* 回滚也失败：至少把原始错误抛出去 */ }
      throw e;
    }

    // ③ 候选里也去掉
    const candFile = await sideFile(dbPath, "桥候选.json");
    const store = await readSide(candFile, { items: [] });
    const keep = (store.items || []).filter(it => bridgeKey(it.a, it.b) !== key);
    if (keep.length !== (store.items || []).length) {
      await writeSide(candFile, { generatedAt: store.generatedAt || 0, items: keep });
    }

    return { ok: true, removed: key };
  });

  /** 对待审候选：accept（接受，0.45）/ reject（忽略并拉黑）/ restore（解除拉黑） */
  registerJson("/neural/bridge", async (body) => {
    const action = String(body.action || "");
    if (!["accept", "reject", "restore"].includes(action)) {
      throw bad("action 只能是 accept / reject / restore");
    }
    if (typeof body.a !== "string" || typeof body.b !== "string") {
      throw bad("a / b 必须是节点 id 字符串");
    }
    const dbPath = await getDbPath();
    const key = bridgeKey(body.a, body.b);
    const candFile = await sideFile(dbPath, "桥候选.json");
    const store = await readSide(candFile, { items: [] });
    const items = store.items || [];

    if (action === "accept") {
      const black = await loadBlacklist(dbPath);
      if (black[key]) throw bad("这条在黑名单里，先 restore");
      const w = await mutate(async (db) => {
        if (!db.nodes[body.a] || !db.nodes[body.b]) throw bad("节点不存在");
        return connectNodes(db, body.a, body.b, 0.1, 0.45);
      });
      await writeSide(candFile, {
        generatedAt: store.generatedAt || 0,
        items: items.filter(it => bridgeKey(it.a, it.b) !== key),
      });
      return { ok: true, weight: Math.round(w * 100) / 100 };
    }

    if (action === "reject") {
      await writeSide(candFile, {
        generatedAt: store.generatedAt || 0,
        items: items.filter(it => bridgeKey(it.a, it.b) !== key),
      });
      const blFile = await sideFile(dbPath, "桥黑名单.json");
      const bl = await readSide(blFile, { pairs: {} });
      bl.pairs = bl.pairs || {};
      bl.pairs[key] = { a: body.a, b: body.b, at: Date.now(), reason: "rejected" };
      await writeSide(blFile, bl);
      return { ok: true, rejected: key };
    }

    // restore
    const blFile = await sideFile(dbPath, "桥黑名单.json");
    const bl = await readSide(blFile, { pairs: {} });
    bl.pairs = bl.pairs || {};
    if (bl.pairs[key]) {
      delete bl.pairs[key];
      await writeSide(blFile, bl);
    }
    return { ok: true, restored: key };
  });

  // ---------- 读（默认强化，可 preview 关掉） ----------

  registerJson("/neural/recall", (body) => {
    const query = cleanQuery(body.query);
    if (!query) throw bad("query 必须是非空字符串（长度 1~500）");
    const top = cleanTop(body.top);
    const strengthen = !(body.preview === true || body.strengthen === false);
    // 生效的 top 带回去（传大了会被夹到 100，调用方该知道）
    const topNote = body.top === undefined ? {} : { top };

    if (!strengthen) {
      return withLock(async () => {
        const dbPath = await getDbPath();
        const db = await loadDb(dbPath);
        const items = recall(db, query, top, 1, 0.5, false);
        return { ok: true, items, strengthened: false, ...topNote };
      });
    }
    // 强化也是写：走 mutate，撞冲突就重读再算
    return mutate(async (db) => {
      const items = recall(db, query, top, 1, 0.5, true);
      return { ok: true, items, strengthened: items.length > 0, ...topNote };
    });
  });

  // ---------- 只读 ----------

  registerGet("/neural/stats", async () => {
    const dbPath = await getDbPath();
    const db = await loadDb(dbPath);
    const all = Object.values(db.nodes);
    const days = {};
    for (const n of all) {
      const d = n.day || "(未标日期)";
      days[d] = (days[d] || 0) + 1;
    }
    const top = all.slice()
      .sort((a, b) => (b.activationCount || 0) - (a.activationCount || 0))
      .slice(0, 10)
      .map(n => ({
        id: n.id, text: n.text.slice(0, 80), type: n.type,
        activationCount: n.activationCount || 0, importance: n.importance,
      }));
    return {
      ok: true,
      nodes: all.length,
      edges: Object.keys(db.edges).length,
      days: Object.keys(days).length,
      byDay: Object.entries(days).sort().map(([day, count]) => ({ day, count })),
      top,
      dbPath,
      dropped: db._dropped || 0,
    };
  });

  registerGet("/neural/export", async () => {
    const dbPath = await getDbPath();
    const db = await loadDb(dbPath);
    return {
      __raw: true,
      type: "text/markdown; charset=utf-8",
      body: exportMarkdown(db),
    };
  });

  // 无损快照（含边、id、时间、激活历史）—— 备份用这个，别用 export
  registerGet("/neural/snapshot", async () => {
    const dbPath = await getDbPath();
    const db = await loadDb(dbPath);
    return {
      __raw: true,
      type: "application/json; charset=utf-8",
      body: exportSnapshot(db),
    };
  });

  // 图数据：不写库，坐标每次现算
  registerGet("/neural/graph-data", async () => {
    const dbPath = await getDbPath();
    const db = await loadDb(dbPath);
    const all = Object.values(db.nodes);
    const idIdx = {};
    all.forEach((n, i) => { idIdx[n.id] = i; });

    const region = (i, k) => {
      if (k === "权重" || k === "note") return 3;
      if (["情绪", "在意", "看人", "感想", "身份", "长期"].includes(k)) return 1;
      if (i % 10 === 0) return 2;
      return i % 2 === 0 ? 0 : 1;
    };
    const gauss = (mu, sigma) => {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    const nodesOut = all.map((n, i) => {
      const reg = region(i, n.type);
      const r = 0.65 + Math.random() * 0.35;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      let x, y, z;
      if (reg === 0 || reg === 1) {
        const cx = reg === 0 ? -0.46 : 0.46;
        x = cx + r * 0.34 * Math.sin(phi) * Math.cos(theta);
        y = r * 0.29 * Math.cos(phi) + 0.06;
        z = r * 0.30 * Math.sin(phi) * Math.sin(theta);
        x = reg === 0 ? Math.min(x, -0.02) : Math.max(x, 0.02);
      } else if (reg === 2) {
        const side = Math.random() < 0.5 ? -1 : 1;
        x = side * 0.20 + r * 0.16 * Math.sin(phi) * Math.cos(theta);
        y = -0.36 + r * 0.12 * Math.cos(phi);
        z = r * 0.14 * Math.sin(phi) * Math.sin(theta);
      } else {
        x = gauss(0, 0.04);
        y = -0.56 - Math.random() * 0.18;
        z = gauss(0, 0.04);
      }
      return {
        id: n.id,
        t: n.text.slice(0, 90),
        k: n.type,
        i: Math.round((n.importance ?? 0.5) * 100) / 100,
        d: n.day || "",
        x: Math.round(x * 8200) / 10,
        y: Math.round(y * 8200) / 10,
        z: Math.round(z * 8200) / 10,
        r: reg,
      };
    });

    const edgesOut = [];
    for (const e of Object.values(db.edges)) {
      if (idIdx[e.a] === undefined || idIdx[e.b] === undefined) continue;
      edgesOut.push([e.a, e.b, Math.round(e.weight * 100) / 100]);
    }

    const COLORS = {
      "故事": "#4a7fbf", "身份": "#3f9b78", "说话": "#3f9b78", "雷点": "#a87838",
      "在意": "#b85858", "长期": "#3f9b78", "错题": "#965454", "权重": "#c9a227",
      "判断史": "#6a6aae", "弱点": "#924848", "看人": "#4a9494", "感想": "#7a6a9e",
      "总账": "#4a7fbf", "日记": "#5f8a5f", "事件": "#4a7fbf", "情绪": "#b85858",
      "判断": "#6a6aae", "note": "#7a7a7a",
    };

    return {
      __raw: true,
      type: "application/javascript; charset=utf-8",
      body: "window.BRAIN_DATA = " + JSON.stringify({
        nodes: nodesOut, edges: edgesOut, colors: COLORS,
      }) + ";",
    };
  });

  // ---------- 静态页 ----------

  async function serveFile(res, nameOnDisk) {
    const { fileURLToPath } = await import("node:url");
    const { dirname, join: joinPath } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const html = await readFile(joinPath(here, "..", nameOnDisk), "utf8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  }

  disposers.push(webServer.register({
    kind: "exact",
    path: "/neural-panel",
    handler: async (req, res) => {
      try { await serveFile(res, "panel.html"); }
      catch (e) { res.statusCode = 500; res.end("panel not found: " + e.message); }
    },
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/neural-ripple",
    handler: async (req, res) => {
      try { await serveFile(res, "ripple.html"); }
      catch (e) { res.statusCode = 500; res.end("ripple not found: " + e.message); }
    },
  }));

  disposers.push(webServer.register({
    kind: "exact",
    path: "/neural-graph",
    handler: async (req, res) => {
      try { await serveFile(res, "graph.html"); }
      catch (e) { res.statusCode = 500; res.end("graph not found: " + e.message); }
    },
  }));

  // ---------- 换窗口也能用：把库注进新会话 ----------
  //
  // 走 agent/pre-step 而不是 agent/created：
  //   created 时那个"待处理注入位"只有一个，被 wakeup 的「家」占着，
  //   要等用户发第一句话才释放。等着试就是拼运气（实测 4 分钟超时过）。
  //   pre-step 在每次模型调用前触发，那时「家」已经消费掉了，
  //   我们的消息直接拼进本次请求的 messages —— 不排队、不超时、不丢。
  //
  // pre-step 每个模型步都会触发，所以按 agent 去重，一个会话只注一次。

  if (cfg.injectOnStart !== false && typeof ctx.on === "function") {
    const injectedSessions = new Set();   // 注过的 session id
    const entered = new Set();            // 见过 pre-step 的 session id（只用于日志）
    let seq = 0;                          // 没有 session id 时的兜底序号

    // 读库带重试：别的进程可能正在 rename 库文件，
    // 那一瞬间 readFile 会 ENOENT / EBUSY，重试一次就好。
    const loadWithRetry = async (dbPath, tries = 3) => {
      let last = null;
      for (let i = 0; i < tries; i++) {
        try {
          return await loadDb(dbPath);
        } catch (e) {
          last = e;
          await new Promise(r => setTimeout(r, 30 + i * 30));
        }
      }
      throw last;
    };

    const buildBlock = async () => {
      const dbPath = await getDbPath();
      const db = await loadWithRetry(dbPath);
      const all = Object.values(db.nodes);
      if (!all.length) return null;

      let budget = cfg.injectMaxChars || 1100;
      const out = [];
      const add = (s) => {
        if (s.length > budget) return false;
        budget -= s.length + 1;
        out.push(s);
        return true;
      };
      const clip = (s, n) => {
        const one = String(s || "").replace(/\s+/g, " ").trim();
        return one.length > n ? one.slice(0, n) + "…" : one;
      };

      const isMeta = (n) => {
        const ty = n.type || "";
        if (ty === "权重") return true;
        const len = (n.text || "").length;
        return len < 10 || len > 600;
      };
      const ok = all.filter(n => !isMeta(n));

      const byType = new Map();
      const notable = [];
      for (const n of ok.slice().sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))) {
        if ((n.importance ?? 0) < 0.8) continue;
        const ty = n.type || "?";
        const used = byType.get(ty) || 0;
        if (used >= 2) continue;
        byType.set(ty, used + 1);
        notable.push(n);
        if (notable.length >= 4) break;
      }

      const notableIds = new Set(notable.map(n => n.id));
      const dayKey = (n) => (/^\d{4}-\d{2}-\d{2}$/.test(n.day || "") ? n.day : "");
      const TYPE_RANK = { "日记": 0, "故事": 1, "判断史": 2, "看人": 3, "感想": 4, "总账": 5 };
      const rank = (n) => (TYPE_RANK[n.type] ?? 6);
      const want = Math.max(1, Math.min(12, cfg.injectTop || 5));
      const recent = [];
      const perType = new Map();
      for (const n of ok
        .filter(x => !notableIds.has(x.id) && dayKey(x))
        .sort((a, b) => {
          const d = dayKey(b).localeCompare(dayKey(a));
          if (d !== 0) return d;
          const r = rank(a) - rank(b);
          if (r !== 0) return r;
          const ca = a.created || 0, cb = b.created || 0;
          if (cb !== ca) return cb - ca;
          return (b.lastActivated || 0) - (a.lastActivated || 0);
        })) {
        const ty = n.type || "?";
        const used = perType.get(ty) || 0;
        if (used >= 2) continue;
        perType.set(ty, used + 1);
        recent.push(n);
        if (recent.length >= want) break;
      }

      add("<neural-memory>");
      // 这两句是可配的：默认说"备用索引"，因为这个库对多数人是索引不是主记忆。
      // 原来写死了「主记忆是家 + 总账 + 日记」—— 那是我们自己那套的实情，别人装上就是错的。
      add(typeof cfg.injectIntro === "string" && cfg.injectIntro.trim()
        ? cfg.injectIntro.trim()
        : "这是本机的记忆索引（备用，不是唯一来源；原始资料在库记录的来源文件里）。");
      add("库：" + all.length + " 条 / " + Object.keys(db.edges).length +
          " 条连接 · 文件 " + dbPath);
      if (notable.length) {
        add("底线与在意（重要性高的）：");
        for (const n of notable) {
          if (!add("- [" + n.type + "] " + clip(n.text, 70))) break;
        }
      }
      add("最近发生的（按日期）：");
      for (const n of recent) {
        if (!add("- [" + n.type + "] " + clip(n.text, 70))) break;
      }
      add("要查更多：POST /neural/recall {\"query\":\"词\"}，或面板 /neural-panel，或球 /neural-graph。");
      if (cfg.injectNote !== false) {
        add(typeof cfg.injectNote === "string" && cfg.injectNote.trim()
          ? cfg.injectNote.trim()
          : "（库里的 importance 可能是批量导入时按来源分级的，不一定是逐条判断的结果。）");
      }
      add("</neural-memory>");

      return out.length > 2 ? out.join("\n") : null;
    };

    // 返回细节，便于诊断：{ hit, own, users }
    const scanSession = (agent) => {
      const session = agent && agent.session;
      let own = [];
      try {
        own = typeof session?.ownEvents === "function"
          ? session.ownEvents()
          : (session?.events || []).slice(session?.header?.seedLength ?? 0);
      } catch { own = []; }
      let users = 0, hit = false;
      for (const e of (own || [])) {
        if (!e || e.type !== "user/message") continue;
        users++;
        const src = e.data && e.data.source;
        if (src && (src.kind === KIND || src.plugin === SOURCE)) { hit = true; break; }
      }
      return { hit, own: (own || []).length, users };
    };
    const alreadyInSession = (agent) => scanSession(agent).hit;

    const sidOf = (agent) => {
      const s = agent && agent.session && agent.session.id;
      if (s) return String(s);
      return "nosid-" + (++seq);
    };
    const sidTail = (sid) => String(sid).slice(-8);

    const noteIt = async (what, via) => {
      try { await noteInject(what + "  [" + via + "]", await getDbPath()); } catch { }
    };

    // middleware 形态：先 next() 拿决策，再往本次 messages 里追加一条
    ctx.on("agent/pre-step", async ({ agent, signal } = {}, next) => {
      const decision = typeof next === "function" ? await next() : undefined;

      // 首次见到这个会话就打一行，方便判断 pre-step 到底有没有送到（每条会话只打一次）
      try {
        if (agent && agent.session && typeof entered === "object") {
          const s0 = String(agent.session.id || "?");
          if (!entered.has(s0)) {
            entered.add(s0);
            await noteIt("enter sid…" + s0.slice(-8) +
                         " origin=" + String(agent?.session?.header?.origin || "?"), "pre-step");
          }
        }
      } catch { }

      try {
        if (decision && decision.kind === "reject") return decision;
        // 注意：pre-step 的 agent 上没有 inject()（那是 created 阶段才有的），
        // 这里绝不能要求它 —— 我们只是往 decision.messages 里追加。
        if (!agent) { await noteIt("skip:no-agent", "pre-step"); return decision; }
        if (signal?.aborted) { await noteIt("skip:aborted", "pre-step"); return decision; }
        if (agent?.session?.header?.origin === "subagent") {
          await noteIt("skip:subagent", "pre-step");
          return decision;
        }
        const sid = sidOf(agent);
        if (injectedSessions.has(sid)) return decision;      // 本会话已注，安静跳过

        // 只用来记日志，不再拿它做判断
        const scan = scanSession(agent);

        // 顺手扫一遍过期候选桥（内部有 10 分钟节流）
        sweepCandidates().catch(() => {});
        const block = await buildBlock();
        if (!block) { await noteIt("skip:empty", "pre-step"); return decision; }

        const msg = {
          role: "user",
          content: [{ type: "text", text: block }],
          source: { kind: KIND, plugin: SOURCE, form: "instructions" },
        };
        await noteIt("injected " + block.length + " 字  sid…" + sidTail(sid) +
                     " own=" + scan.own + " users=" + scan.users +
                     "  [top=" + cfg.injectTop + " max=" + cfg.injectMaxChars + "]", "pre-step");

        const messages = Array.isArray(decision && decision.messages) ? decision.messages : [];
        // 只有真的拼进去了才记"已处理"，否则下次还要再试
        injectedSessions.add(sid);
        return { ...(decision || {}), messages: [...messages, msg] };
      } catch (e) {
        // 注入失败绝不能打断这一次请求，但必须留痕
        try { await noteIt("failed: " + String((e && e.message) || e), "pre-step"); } catch { }
        return decision;
      }
    });

    // 兼容：老版本宿主没有 pre-step 时，退回 created + inject（尽力而为，不重试）
    ctx.on("agent/created", async ({ agent } = {}) => {
      // 注意：不要用 source 做守卫 —— 恢复会话和 qqbot 创建 agent 时它都是 undefined
      try {
        if (!agent) return undefined;
        if (injectedSessions.has(sidOf(agent))) return undefined;
        if (agent?.session?.header?.origin === "subagent") return undefined;
        if (typeof agent.inject !== "function") return undefined;
        const block = await buildBlock();
        if (!block) return undefined;
        injectedSessions.add(sidOf(agent));
        agent.inject({
          role: "user",
          content: [{ type: "text", text: block }],
          source: { kind: KIND, plugin: SOURCE, form: "instructions" },
        });
        await noteIt("injected " + block.length + " 字（created 兜底）", "created");
      } catch { /* 有位被占就交给 pre-step */ }
      return undefined;
    });
  }

  return () => {
    for (const d of disposers) {
      try { if (typeof d === "function") d(); } catch { /* ignore */ }
    }
  };
}

// ---------- body ----------

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error("body 太大（>1MB）"));
    });
    req.on("end", () => {
      if (!data) return resolvePromise({});
      try {
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new Error("body 必须是 JSON 对象"));
        }
        resolvePromise(parsed);
      } catch {
        reject(new Error("body 不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}
