/**
 * dsh-neural-memory · 核心
 *
 * 纯函数 + 文件读写，不碰 ctx、不碰 webServer。
 * host 半部（lib/index.js）调它，测试也调它 —— 同一份实现，不复制。
 *
 * 三条硬规矩（2026-10-28 按审查报告定的）：
 *   ① 读库失败绝不返回空库 —— 只有 "文件不存在" 才初始化，其他一律抛错
 *   ② 写库先写临时文件再原子替换，并留一份 .bak
 *   ③ 保存失败必须让调用方知道（抛错，不吞）
 */

import { createHash } from "node:crypto";
import { open as fsOpen, stat as fsStat, readFile, writeFile, rename, mkdir, copyFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// ---------- 常量 ----------

export const MAX_TEXT = 4000;
export const MAX_KIND = 32;
export const MAX_DAY = 20;
export const MAX_QUERY = 500;
export const MAX_TOP = 100;

// ---------- 时间 ----------

export function nowSec() {
  return Date.now() / 1000;
}

// ---------- 校验 ----------

/** 文本：非空字符串，超长截断。返回 null 表示不合法 */
export function cleanText(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
}

/** 类型名：任意短字符串 */
export function cleanKind(v) {
  if (typeof v !== "string") return "note";
  const k = v.trim();
  if (!k) return "note";
  return k.length > MAX_KIND ? k.slice(0, MAX_KIND) : k;
}

/**
 * 重要性：0~1 的有限数。
 * 注意：0 是合法值，不能用 `v || 0.5`。
 */
export function cleanImportance(v) {
  if (v === undefined || v === null || v === "") return 0.5;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * 日期：只接受 YYYY-MM-DD，或短标签（如 "常驻"）。
 * 其他一律返回空串 —— 因为它会被当目录名/文件名用，不能放进任意字符。
 */
export function cleanDay(v) {
  if (typeof v !== "string") return "";
  const d = v.trim();
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^[\p{L}\p{N}_()-]{1,12}$/u.test(d)) return d;
  return "";
}

/** top：有界正整数 */
export function cleanTop(v, def = 20) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(MAX_TOP, Math.floor(n));
}

/** 查询串：限长 */
export function cleanQuery(v) {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, MAX_QUERY);
}

/** 一条节点：不合法返回 null（加载时隔离，写入时拒绝） */
export function validateNode(raw, id) {
  if (!raw || typeof raw !== "object") return null;
  const text = cleanText(raw.text);
  if (!text) return null;
  const created = Number(raw.created);
  const last = Number(raw.lastActivated);
  const act = Number(raw.activationCount);
  const heading = typeof raw.heading === "string" ? raw.heading.slice(0, 120) : "";

  // 先把它原本的字段都带上，再用校验过的值覆盖。
  // 为什么：灌入会写 source / para（来自哪个文件、第几段），
  // 以前这里重建对象、只留白名单字段，插件写一次就把这些全抹掉 ——
  // 整库的"出处"静默丢失（2026-10-28 自检发现，1305 条里 0 条还有 source）。
  const extra = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "id") continue;                 // id 以 key 为准
    if (typeof v === "string" && v.length > 2000) continue;   // 别把超长垃圾带过来
    extra[k] = v;
  }

  return {
    ...extra,
    id,
    text,
    type: cleanKind(raw.type),
    importance: cleanImportance(raw.importance),
    created: Number.isFinite(created) ? created : nowSec(),
    lastActivated: Number.isFinite(last) ? last : nowSec(),
    activationCount: Number.isFinite(act) ? Math.max(0, Math.floor(act)) : 0,
    day: cleanDay(raw.day),
    ...(heading ? { heading } : {}),
  };
}

// ---------- 读写 ----------

/**
 * 读库。
 *   文件不存在 → 新库（这是唯一允许的"空"）
 *   解析失败 / 权限错误 → 抛错（绝不返回空库，避免覆盖）
 *   坏节点 / 坏边 → 隔离丢弃，记在 _dropped 里（不拖垮整库）
 */
/**
 * 跨进程互斥：用一个 .lock 文件。
 *
 * 为什么需要：Windows 上 rename 覆盖已有文件不是原子的（会 EPERM/EBUSY），
 * 而"核对指纹 → 写临时文件 → rename"这三步之间，别的进程完全可以插进来，
 * 于是后写的把先写的覆盖掉 —— 实测两进程各写 25 条，只活下来 31 条。
 *
 * 抢锁：open(lock, "wx") 在文件已存在时抛 EEXIST（这一步是原子的）
 * 陈旧锁：超过 staleMs 没释放就抢过来（写完的进程崩了不至于把库永久锁死）
 */
async function withWriteLock(lockPath, fn, opts = {}) {
  const waitMs = opts.waitMs || 15;
  const maxWaitMs = opts.maxWaitMs || 15000;
  const staleMs = opts.staleMs || 10000;
  const deadline = Date.now() + maxWaitMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    let fh = null;
    try {
      fh = await fsOpen(lockPath, "wx");
      try { await fh.writeFile(String(process.pid) + " " + Date.now(), "utf8"); } catch { }
      await fh.close();
      fh = null;
      try {
        return await fn();
      } finally {
        try { await unlink(lockPath); } catch { /* ignore */ }
      }
    } catch (e) {
      if (fh) { try { await fh.close(); } catch { /* ignore */ } }
      // Windows 上抢锁时偶尔抛 EPERM（不是 EEXIST），必须一起当"被占"重试，
      // 否则并发下会间歇性失败（实测三次跑挂两次）。
      const CONTENTION = ["EEXIST", "EPERM", "EBUSY", "EACCES"];
      if (!e || !CONTENTION.includes(e.code)) throw e;
      lastErr = e;
      // 陈旧锁？
      try {
        const st = await fsStat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { await unlink(lockPath); } catch { /* ignore */ }
          continue;
        }
      } catch { /* 锁刚好被释放，下一轮直接抢 */ }
      await new Promise(r => setTimeout(r, waitMs + Math.random() * waitMs));
    }
  }
  throw new Error("拿不到写锁（另一个进程一直在写这个库）: " + ((lastErr && lastErr.message) || ""));
}

/** 内容指纹：用来判断"库在我读完之后有没有被别人改过" */
export function fingerprint(raw) {
  return createHash("sha1").update(raw, "utf8").digest("hex").slice(0, 16);
}

/** 写冲突：库在读取之后被别的进程改过了 */
export function conflictError(msg) {
  const e = new Error(msg || "库在读取之后被别的进程改过（写冲突）");
  e.code = "DB_CONFLICT";
  return e;
}

export async function loadDb(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { nodes: {}, edges: {}, next_id: 1, _new: true, _dropped: 0 };
    }
    throw new Error("读库失败（" + (e.code || "unknown") + "）: " + (e.message || e));
  }

  // 容忍 BOM
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("库文件损坏（JSON 解析失败），拒绝写入以免覆盖原库: " +
                    (e.message || e));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("库文件格式不对：顶层不是对象");
  }

  const nodes = {};
  let dropped = 0;
  for (const [id, n] of Object.entries(parsed.nodes || {})) {
    const v = validateNode(n, id);
    if (v) nodes[id] = v;
    else dropped++;
  }

  const edges = {};
  for (const e of Object.values(parsed.edges || {})) {
    if (!e || typeof e !== "object") continue;
    const a = e.a, b = e.b;
    if (!nodes[a] || !nodes[b] || a === b) continue;
    const w = Number(e.weight);
    if (!Number.isFinite(w)) continue;
    const key = [a, b].sort().join("|");
    edges[key] = {
      a, b,
      weight: Math.min(1, Math.max(0, w)),
      count: Number.isFinite(Number(e.count)) ? Math.max(0, Math.floor(Number(e.count))) : 0,
    };
  }

  let next_id = Number.isFinite(Number(parsed.next_id)) ? Math.max(1, Math.floor(Number(parsed.next_id))) : 1;
  for (const id of Object.keys(nodes)) {
    const m = /^n(\d+)$/.exec(id);
    if (m) next_id = Math.max(next_id, parseInt(m[1], 10) + 1);
  }

  const db = { nodes, edges, next_id, _dropped: dropped };
  // 指纹：这一份内容是谁。写的时候要核对，防止覆盖别人的改动。
  Object.defineProperty(db, "__fp", {
    value: fingerprint(raw),
    enumerable: false,
    writable: true,
  });
  return db;
}

/**
 * 写库：写临时文件 → 保留 .bak → 原子替换。
 * 任何一步失败都抛错（不吞），让调用方把失败告诉 agent。
 */
export async function saveDb(path, db, opts = {}) {
  // 先确保目录存在 —— 否则锁文件建不出来，报错会变成难懂的 ENOENT
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (e) {
    throw new Error("库所在目录建不出来，无法写入: " + ((e && e.message) || e));
  }
  // 整个"核对 + 写临时文件 + 替换"都要在锁里，
  // 否则校验通过之后仍然会被别的进程插队覆盖。
  return withWriteLock(path + ".lock", () => saveDbLocked(path, db, opts));
}

async function saveDbLocked(path, db, opts = {}) {
  const body = JSON.stringify({
    nodes: db.nodes,
    edges: db.edges,
    next_id: db.next_id,
  }, null, 1);

  // 乐观锁：如果调用方给了 expect（读的时候的指纹），
  // 写之前再核一次 —— 库被别的进程改过就抛冲突，别覆盖别人的改动。
  if ("expect" in opts) {
    let current = null;
    try {
      const raw = await readFile(path, "utf8");
      current = fingerprint(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch (e) {
      if (!e || e.code !== "ENOENT") {
        throw new Error("核对库指纹失败（" + (e.code || "unknown") + "）: " + (e.message || e));
      }
      current = null;      // 文件不存在
    }

    const expect = opts.expect;
    if (expect === null) {
      if (current !== null) throw conflictError("库里已经有内容了（本以为是新库）");
    } else if (current !== expect) {
      throw conflictError(
        "库在读取之后被改过（期望 " + String(expect).slice(0, 8) +
        "，实际 " + (current ? String(current).slice(0, 8) : "文件不见了") + "）",
      );
    }
  }

  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, body, "utf8");
  } catch (e) {
    try { await unlink(tmp); } catch { /* ignore */ }
    throw new Error("写临时文件失败: " + (e.message || e));
  }

  // 留一份上一版（失败不影响主流程）
  try { await copyFile(path, path + ".bak"); } catch { /* 首次写入时没有原文件 */ }

  // Windows 上 rename 覆盖已有文件时，如果目标正被别的进程占用，
  // 会抛 EPERM/EBUSY（POSIX 的 rename 是原子的，没这问题）。
  // 两个进程同时写同一个库就必然会撞上 —— 退避重试，别直接失败。
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rename(tmp, path);
      return true;
    } catch (e) {
      lastErr = e;
      const code = e && e.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      await new Promise(r => setTimeout(r, 30 + attempt * 12));
    }
  }
  try { await unlink(tmp); } catch { /* ignore */ }
  throw new Error("替换库文件失败（原库未动）: " + ((lastErr && lastErr.message) || lastErr));
}

// ---------- 写操作 ----------

/** 入参错误：带 status=400，路由层据此回 400 而不是 500 */
function invalid(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}


export function addNode(db, text, kind = "note", importance = 0.5, day = "") {
  const clean = cleanText(text);
  if (!clean) throw invalid("text 必须是非空字符串");
  const id = "n" + db.next_id++;
  const ts = nowSec();
  db.nodes[id] = {
    id,
    text: clean,
    type: cleanKind(kind),
    importance: cleanImportance(importance),
    created: ts,
    lastActivated: ts,
    activationCount: 1,
    day: cleanDay(day),
  };
  return id;
}

export function connectNodes(db, a, b, delta = 0.1, absoluteWeight = null) {
  if (typeof a !== "string" || typeof b !== "string") throw invalid("a/b 必须是节点 id");
  if (a === b) throw invalid("不能连接自己");
  if (!db.nodes[a]) throw invalid("节点不存在: " + a);
  if (!db.nodes[b]) throw invalid("节点不存在: " + b);
  const key = [a, b].sort().join("|");
  const e = db.edges[key] || { a, b, weight: 0, count: 0 };
  if (absoluteWeight != null) {
    // 手动建的桥：直接给权重（重复连接取较大的那个，不叠加）
    const w = Number(absoluteWeight);
    const val = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5;
    e.weight = Math.max(e.weight, val);
  } else {
    e.weight = Math.min(1, Math.max(0, e.weight + delta));
  }
  e.count += 1;
  db.edges[key] = e;
  return e.weight;
}

// ---------- 打分 ----------

export function decayFactor(node, halfLifeDays = 30) {
  const age = (nowSec() - (node.lastActivated || 0)) / 86400;
  return Math.pow(0.5, age / halfLifeDays);
}

export function baseScore(node) {
  const imp = node.importance ?? 0.5;        // 0 是合法值，不能用 ||
  return (0.4 + 0.6 * imp) * decayFactor(node);
}

export function matchScore(query, node) {
  const q = (query || "").trim();
  if (!q) return 0;
  const text = node.text || "";
  if (text.includes(q)) {
    const density = Math.min(1, q.length / Math.max(20, text.length));
    return 0.6 + 0.4 * density;
  }
  let hit = 0, total = 0;
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= q.length; i++) {
      total++;
      if (text.includes(q.slice(i, i + n))) hit++;
    }
  }
  if (!hit || !total) return 0;
  const cover = hit / total;
  const density = Math.min(1, (hit * 2) / Math.max(20, text.length));
  return cover * (0.3 + 0.7 * density);
}

/**
 * 召回。
 * @param strengthen  true = 被返回的节点刷新激活时间、重要性 +0.01
 *                    false = 只读预览，不强化（调试、统计、面板预取都用这个）
 */
export function recall(db, query, top = 20, spread = 1, spreadFactor = 0.5, strengthen = true) {
  const nodes = db.nodes;
  const act = {};

  for (const [id, n] of Object.entries(nodes)) {
    const s = matchScore(query, n);
    if (s > 0) act[id] = s * baseScore(n);
  }

  if (spread > 0 && Object.keys(act).length) {
    for (let round = 0; round < spread; round++) {
      const nxt = {};
      for (const e of Object.values(db.edges)) {
        for (const [src, dst] of [[e.a, e.b], [e.b, e.a]]) {
          if ((act[src] || 0) > 0.15 && nodes[dst]) {
            const v = act[src] * e.weight * spreadFactor * baseScore(nodes[dst]);
            nxt[dst] = Math.max(nxt[dst] || 0, v);
          }
        }
      }
      for (const [k, v] of Object.entries(nxt)) {
        act[k] = Math.max(act[k] || 0, v);
      }
    }
  }

  const ranked = Object.entries(act)
    .sort((x, y) => y[1] - x[1])
    .slice(0, top);

  if (strengthen) {
    for (const [id] of ranked) {
      const n = nodes[id];
      if (!n) continue;
      n.lastActivated = nowSec();
      n.activationCount = (n.activationCount || 0) + 1;
      n.importance = Math.min(1, (n.importance ?? 0.5) + 0.01);
    }
  }

  return ranked.map(([id, score]) => ({
    id,
    score: Math.round(score * 1000) / 1000,
    text: nodes[id].text,
    type: nodes[id].type,
    importance: nodes[id].importance,
    day: nodes[id].day || "",
  }));
}

// ---------- 导出 ----------

/**
 * 人读的导出（按天分组）。注意：不含边和激活历史 —— 它不是无损备份。
 */
export function exportMarkdown(db) {
  const byDay = {};
  for (const n of Object.values(db.nodes)) {
    const d = n.day || "(未标日期)";
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(n);
  }
  let out = "# 神经记忆导出\n\n";
  out += "共 " + Object.keys(db.nodes).length + " 条 / " +
         Object.keys(db.edges).length + " 条连接\n\n";
  out += "> 这是**人读**的导出，不含连接和激活历史。\n";
  out += "> 要做无损备份，直接复制 neural-memory.json。\n\n";
  for (const d of Object.keys(byDay).sort()) {
    out += "## " + d + "\n\n";
    for (const n of byDay[d]) {
      out += "- `" + n.id + "` **[" + n.type + "]** " +
             String(n.text).replace(/\n/g, " ") +
             "  （重要性 " + n.importance + "）\n";
    }
    out += "\n";
  }
  return out;
}

/**
 * 无损备份体（含边、id、时间、激活历史）—— 可以直接当库文件用。
 */
export function exportSnapshot(db) {
  return JSON.stringify({
    nodes: db.nodes,
    edges: db.edges,
    next_id: db.next_id,
    _exported_at: new Date().toISOString(),
  }, null, 1);
}
