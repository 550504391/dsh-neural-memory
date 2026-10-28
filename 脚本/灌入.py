# -*- coding: utf-8 -*-
"""批量灌入：从 md 文件里抽段落当节点，建相邻连接

规则：
  ① 一个段落 = 一个节点（太短的跳过，太长截断）
  ② 同一文件内相邻段落连一条边（"时间上的邻居"）
  ③ 重要性默认 0.5，后面人工调
  ④ 自动去重：文本完全相同的跳过

用法：
  python 灌入.py                  # 灌全部
  python 灌入.py --dry            # 只看会灌多少
"""
import json
import re
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

import os as _os

def _resolve_db():
    """跟 JS 半部同一套规则：env → 用户配置 → home 默认"""
    env = _os.environ.get('NEURAL_MEMORY_DB')
    if env and env.strip():
        return Path(env.strip()).expanduser().resolve()
    cfg_path = Path.home() / '.dsh-neural-memory' / 'config.json'
    try:
        _cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
        p = _cfg.get('dbPath')
        if isinstance(p, str) and p.strip():
            return Path(p.strip()).expanduser().resolve()
    except Exception:
        pass
    return Path(__file__).resolve().parent.parent / '数据' / 'neural-memory.json'

DB = _resolve_db()

SOURCES = [
    # 把你的文件放这里。格式：(路径, 类型名, 重要性)
    # 路径用绝对路径，或者相对包根目录
    # 类型名随你定（故事/情绪/判断/身份...），它会显示在图和面板里
    (Path(__file__).resolve().parent.parent / '示例' / '故事.md', '故事', 0.6),
    (Path(__file__).resolve().parent.parent / '示例' / '笔记.md', '笔记', 0.7),
]

MIN_LEN = 12      # 少于这个字数不要
MAX_LEN = 400     # 超过就截断

# ---------- 跨进程锁与原子写（跟 core.js 同一套协议）----------
#
# 为什么要有这个：JS 那边写库要抢 .lock + 核对指纹，
# 但 Python 以前直接整库覆盖 —— JS 刚写进去的一条会被这里抹掉。
# 现在两边用同一个 .lock（同名同格式），并且写之前核对"我读到的版本还是不是当前版本"。

LOCK_STALE_SEC = 10.0     # 超过这么久没动的锁算陈旧，可以抢占
LOCK_TRIES = 240          # 240 × 0.05 秒 = 最多等 12 秒
LOCK_WAIT = 0.05

_raw_fp = None            # load_db 时记下文件的指纹，save_db 时核对


def _fingerprint(raw):
    import hashlib
    return hashlib.sha1(raw).hexdigest()[:16]


class DbLock:
    """.lock 文件互斥。跟 core.js 的 withWriteLock 同一协议。"""

    def __init__(self, db_path):
        self.lock = Path(str(db_path) + '.lock')
        self.held = False

    def __enter__(self):
        import errno
        self.lock.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(LOCK_TRIES):
            try:
                fd = _os.open(str(self.lock), _os.O_CREAT | _os.O_EXCL | _os.O_WRONLY)
                try:
                    _os.write(fd, ('%d' % _os.getpid()).encode())
                finally:
                    _os.close(fd)
                self.held = True
                return self
            except OSError as e:
                # Windows 上抢失败不一定是 EEXIST，也可能是 EPERM/EBUSY/EACCES
                if e.errno not in (errno.EEXIST, errno.EPERM, errno.EBUSY, errno.EACCES):
                    raise
                try:
                    if time.time() - self.lock.stat().st_mtime > LOCK_STALE_SEC:
                        self.lock.unlink()
                        continue
                except OSError:
                    pass
                time.sleep(LOCK_WAIT)
        raise RuntimeError('等库锁超时（%s）—— 可能有另一个进程正在写，过几秒重跑' % self.lock)

    def __exit__(self, *exc):
        if self.held:
            try:
                self.lock.unlink()
            except OSError:
                pass
            self.held = False
        return False


def load_db():
    global _raw_fp
    if DB.exists():
        raw = DB.read_bytes()
        _raw_fp = _fingerprint(raw)
        return json.loads(raw.decode('utf-8'))
    _raw_fp = None
    return {'nodes': {}, 'edges': {}, 'next_id': 1}


def save_db(db):
    """持锁 → 核对指纹 → 写临时文件 → 替换。顺序跟 core.js 的 saveDb 一致。"""
    global _raw_fp
    DB.parent.mkdir(parents=True, exist_ok=True)
    with DbLock(DB):
        if DB.exists():
            now_fp = _fingerprint(DB.read_bytes())
            if _raw_fp is not None and now_fp != _raw_fp:
                raise RuntimeError(
                    '库在本次读取后被别的进程改过（%s → %s）。'
                    '为避免覆盖别人的写入，这次没写。重跑一次灌入即可（去重是幂等的）。'
                    % (_raw_fp, now_fp))
        _tmp = DB.with_suffix('.json.tmp-%d-%d' % (_os.getpid(), int(time.time() * 1000)))
        _tmp.write_text(json.dumps(db, ensure_ascii=False, indent=1), encoding='utf-8')
        _os.replace(_tmp, DB)
        _raw_fp = _fingerprint(DB.read_bytes())

def clean(s):
    s = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', s)   # 链接
    s = re.sub(r'[*`#|>-]', '', s)                     # 标记
    s = re.sub(r'\s+', ' ', s)
    return s.strip()

FINGER_LEN = 200       # 去重键长度：远小于 MAX_LEN，截断位置变了也认得出


def fp(text):
    """去重指纹：规范化后取前 FINGER_LEN 字。

    为什么不用全文：文本会被 MAX_LEN 截断，
    同一段落截到 399 和截到 400 就是两个不同字符串，
    按全文去重会造重复（2026-10-28 实测：重灌一次多出 6 个）。
    """
    return re.sub(r'\s+', ' ', text or '').strip()[:FINGER_LEN]


def day_from_heading(heading, fname):
    """从标题或文件名里找 2026-10-14 这种日期"""
    import re
    m = re.search(r'(20\d{2})[-/年]?(\d{1,2})[-/月]?(\d{1,2})', heading or '')
    if m:
        return '%s-%02d-%02d' % (m.group(1), int(m.group(2)), int(m.group(3)))
    m = re.search(r'(20\d{2})[-/年]?(\d{1,2})[-/月]?(\d{1,2})', fname or '')
    if m:
        return '%s-%02d-%02d' % (m.group(1), int(m.group(2)), int(m.group(3)))
    return ''


def extract_colored(path, default_day):
    """返回 [(heading, text, day, para)]；day 为空表示源文件没有日期"""
    if not path.exists():
        return []
    raw = path.read_text(encoding='utf-8')
    out = []
    heading = ''
    cur_day = default_day
    for block in raw.split('\n\n'):
        b = block.strip()
        if not b:
            continue
        if b.startswith('#'):
            heading = clean(b)
            # 标题里有日期 → 更新"当前日期"；没有 → 继承上一个
            found = day_from_heading(heading, '')
            if found:
                cur_day = found
            continue
        t = clean(b)
        if len(t) < MIN_LEN:
            continue
        d = cur_day or day_from_heading(heading, path.name) or default_day
        out.append((heading, t[:MAX_LEN], d, len(out)))
    return out

def main():
    dry = '--dry' in sys.argv
    db = load_db()
    # 指纹 → 已存在的 id（重复段落也要能接上上文）
    seen = {}
    for _n in db['nodes'].values():
        seen[fp(_n.get('text'))] = _n['id']
    added = 0
    per_source = {}

    all_new = []          # 所有来源的新节点 id（候选桥要跨来源汇总）
    for path, kind, imp in SOURCES:
        segs = extract_colored(path, '')
        if not segs:
            print('  跳过（不存在或空）: %s' % path.name)
            continue
        cat = []
        last_id = None
        for heading, text, day, para in segs:
            key = fp(text)
            if key in seen:
                old_id = seen[key]
                # 源文件变长时更新原文（保留 id / 重要性 / 边 / 激活历史）
                old = db['nodes'].get(old_id)
                if old and len(text) > len(old.get('text') or ''):
                    old['text'] = text
                # 顺带修复历史数据：插件写库时曾把这两项抹掉
                if old is not None:
                    if old.get('source') != path.name:
                        old['source'] = path.name
                    if old.get('para') != para:
                        old['para'] = para
                last_id = old_id          # 让下文接得上
                continue
            if not dry:
                nid = 'n%d' % db['next_id']
                db['next_id'] += 1
                # 有真实日期就用它（转成当天中午的时间戳），没有就用灌入时间
                if day:
                    import datetime
                    ts = datetime.datetime.strptime(day, '%Y-%m-%d').timestamp() + 43200
                else:
                    ts = time.time()
                db['nodes'][nid] = {
                    # created = 真正入库的时刻（用来排"最近新加的"）
                    # lastActivated = 这一天中午（衰减从"那件事发生"算起）
                    'id': nid, 'text': text, 'type': kind,
                    'importance': imp, 'created': time.time(),
                    'lastActivated': ts, 'activationCount': 1,
                    'heading': heading, 'day': day or '',
                    'source': path.name, 'para': para,
                }
                seen[key] = nid
                # 相邻连接（同一文件的上下文邻居）
                if last_id:
                    key = '%s|%s' % tuple(sorted([last_id, nid]))
                    db['edges'][key] = {'a': last_id, 'b': nid, 'weight': 0.1, 'count': 1}
                last_id = nid
                cat.append(nid)
                added += 1
            else:
                added += 1
        per_source[path.name] = len(segs)
        all_new.extend(cat)     # 不能只在最后一个来源里找候选

    if not dry:
        save_db(db)

    print('')
    print('灌入结果:')
    for k, v in per_source.items():
        print('  %-28s %3d 段' % (k, v))
    print('')
    print('新增节点: %d' % added)
    if not dry and added:
        try:
            n_cand, total = make_candidates(db, all_new)
            print('候选桥: 新增 %d 条（清单共 %d 条，等人审或放 7 天自动连）' % (n_cand, total))
        except Exception as e:
            print('候选桥生成失败（不影响灌入）: %s' % e)
    if not dry:
        print('总节点: %d / 总连接: %d' % (len(db['nodes']), len(db['edges'])))
        print('库: %s (%d KB)' % (DB, DB.stat().st_size // 1024))



# ---------- 候选桥 ----------

CAND_FILE = DB.parent / '桥候选.json'
BLACK_FILE = DB.parent / '桥黑名单.json'

# 太像"表"的段落不参与候选（它们是索引，不是记忆）
META_TYPES = {'权重'}
MIN_SHARED = 6          # 至少共享 6 个 4 字片段
MIN_SCORE = 0.12        # 片段重合率
MAX_PER_NODE = 2        # 每个新节点最多几个候选
MAX_TOTAL = 300         # 候选清单总量上限
# 候选的文本长度阈值 —— 跟入库的 MIN_LEN/MAX_LEN 是两回事。
# 原来这里写 MIN_LEN, MAX_LEN = 24, 600，把入库阈值（12/400）整体覆盖了。
CAND_MIN_LEN, CAND_MAX_LEN = 24, 600


def _grams(text):
    """4 字片段集合（去标点空白）"""
    import re
    s = re.sub(r'\s+', '', text or '')
    s = re.sub(r'[^\u4e00-\u9fffA-Za-z0-9]', '', s)
    return {s[i:i + 4] for i in range(max(0, len(s) - 3))}


def _read_json_strict(path, default):
    """读辅助 JSON（候选/黑名单）。

    文件不存在 → default。
    文件存在但坏了 → 抛错，不能当成空 —— 黑名单坏掉被当空，
    等于把用户拒绝过的关系重新捡回来。
    """
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        raise RuntimeError(
            '辅助文件损坏，不敢继续（否则会重新建议你拒绝过的关联）: %s → %s'
            % (path.name, e))


def _write_json_atomic(path, data):
    """先写临时文件再替换 —— 直接覆盖会留下半截文件"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp-%d-%d' % (_os.getpid(), int(time.time() * 1000)))
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    _os.replace(tmp, path)


def make_candidates(db, new_ids):
    """给新灌进来的节点找跨来源候选，写进 桥候选.json（不写边）"""

    if not new_ids:
        return 0, 0

    # 黑名单（坏了就停，不能当空）
    black = set()
    bl = _read_json_strict(BLACK_FILE, {'pairs': {}})
    black = set((bl.get('pairs') or {}).keys())

    def bkey(a, b):
        return '%s|%s' % tuple(sorted([a, b]))

    nodes = db['nodes']
    # 参不参与候选
    def usable(n):
        txt = n.get('text') or ''
        return (n.get('type') not in META_TYPES
                and CAND_MIN_LEN <= len(txt) <= CAND_MAX_LEN)

    pool = [(nid, n) for nid, n in nodes.items() if usable(n)]
    grams = {nid: _grams(n['text']) for nid, n in pool}

    existing = set()
    for k in db['edges']:
        existing.add(k)

    # 旧候选（坏了也停 —— 否则会把已有候选重算一遍，清单翻倍）
    store = _read_json_strict(CAND_FILE, {'items': []})
    items = store.get('items') or []
    have = {bkey(it['a'], it['b']) for it in items if 'a' in it and 'b' in it}

    added = 0
    for nid in new_ids:
        n = nodes.get(nid)
        if not n or not usable(n):
            continue
        ga = grams.get(nid) or set()
        if len(ga) < MIN_SHARED:
            continue
        mine = n.get('type')
        scored = []
        for oid, o in pool:
            if oid == nid or o.get('type') == mine:
                continue
            k = bkey(nid, oid)
            if k in existing or k in black or k in have:
                continue
            gb = grams.get(oid) or set()
            if len(gb) < MIN_SHARED:
                continue
            inter = len(ga & gb)
            if inter < MIN_SHARED:
                continue
            score = inter / min(len(ga), len(gb))
            if score < MIN_SCORE:
                continue
            scored.append((score, oid, inter))
        scored.sort(reverse=True)
        for score, oid, inter in scored[:MAX_PER_NODE]:
            items.append({
                'a': nid, 'b': oid,
                'score': round(score, 3),
                'shared': inter,
                'createdAt': time.time() * 1000,
                'ta': (n.get('text') or '')[:60],
                'tb': (nodes[oid].get('text') or '')[:60],
                'ka': n.get('type'), 'kb': nodes[oid].get('type'),
            })
            have.add(bkey(nid, oid))
            added += 1
            if len(items) >= MAX_TOTAL:
                break
        if len(items) >= MAX_TOTAL:
            break

    if added:
        _write_json_atomic(CAND_FILE, {'generatedAt': time.time() * 1000, 'items': items})
    return added, len(items)


if __name__ == '__main__':
    main()
