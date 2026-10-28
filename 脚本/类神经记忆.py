# -*- coding: utf-8 -*-
"""类神经记忆 · v0.3

v0.3 改动（按 2026-10-28 审查报告）：
  ① 读库出错不再当空库 —— 只有"文件不存在"才初始化，解析失败直接抛错（避免覆盖）
  ② 写库改成原子替换（先写 .tmp 再 os.replace），并留一份 .bak
  ③ 入参校验：text 非空字符串、importance 是 0~1 有限数（0 合法）、day 做清洗
  ④ 加载时坏节点隔离（记在 _dropped），一条坏数据不拖垮整库
  ⑤ 召回支持 --preview（只读，不强化）
  ⑥ 库路径两边统一：config → 环境变量 → 用户配置文件 → home 默认

用法：
  python 类神经记忆.py init
  python 类神经记忆.py add "文本" 类型 重要性 [--day 2026-10-28]
  python 类神经记忆.py connect n1 n2
  python 类神经记忆.py recall "查询" [--preview] [--top 20]
  python 类神经记忆.py stats
  python 类神经记忆.py show
  python 类神经记忆.py backup            ← 无损快照
"""
import json
import math
import os
import re
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

# ---------- 常量 ----------

MAX_TEXT = 4000
MAX_KIND = 32
MAX_QUERY = 500
MAX_TOP = 100

HOME_DIR = Path.home() / '.dsh-neural-memory'
HOME_DB = HOME_DIR / 'neural-memory.json'
HOME_CFG = HOME_DIR / 'config.json'


# ---------- 库路径（跟 JS 半部同一套规则） ----------

def resolve_db():
    """
    ① 环境变量 NEURAL_MEMORY_DB
    ② ~/.dsh-neural-memory/config.json 里的 dbPath
    ③ ~/.dsh-neural-memory/neural-memory.json
    """
    env = os.environ.get('NEURAL_MEMORY_DB')
    if env and env.strip():
        return Path(env.strip()).expanduser().resolve()
    try:
        cfg = json.loads(HOME_CFG.read_text(encoding='utf-8'))
        p = cfg.get('dbPath')
        if isinstance(p, str) and p.strip():
            return Path(p.strip()).expanduser().resolve()
    except Exception:
        pass
    return Path(__file__).resolve().parent.parent / '数据' / 'neural-memory.json'


DB = resolve_db()


# ---------- 校验 ----------

def clean_text(v):
    if not isinstance(v, str):
        return None
    t = v.strip()
    if not t:
        return None
    return t[:MAX_TEXT]


def clean_kind(v):
    if not isinstance(v, str):
        return 'note'
    k = v.strip() or 'note'
    return k[:MAX_KIND]


def clean_importance(v):
    """0 是合法值，不能用 `v or 0.5`"""
    if v is None or v == '':
        return 0.5
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0.5
    if not math.isfinite(n):
        return 0.5
    return min(1.0, max(0.0, n))


def clean_day(v):
    """日期只用于分组，也会被当目录名，所以必须清洗"""
    if not isinstance(v, str):
        return ''
    d = v.strip()
    if not d:
        return ''
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', d):
        return d
    if re.fullmatch(r'[\w\u4e00-\u9fa5()（）-]{1,12}', d):
        return d
    return ''


def clean_top(v, default=20):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    if n <= 0:
        return default
    return min(MAX_TOP, n)


def clean_query(v):
    if not isinstance(v, str):
        return ''
    return v.strip()[:MAX_QUERY]


def validate_node(raw, nid):
    """不合法返回 None（加载时隔离，写入时拒绝）"""
    if not isinstance(raw, dict):
        return None
    text = clean_text(raw.get('text'))
    if not text:
        return None
    try:
        created = float(raw.get('created') or 0)
    except (TypeError, ValueError):
        created = 0.0
    try:
        last = float(raw.get('lastActivated') or 0)
    except (TypeError, ValueError):
        last = 0.0
    try:
        act = int(raw.get('activationCount') or 0)
    except (TypeError, ValueError):
        act = 0
    # 先保留不认识的字段（source / para / 以后加的），再覆盖成校验过的值。
    # 不这样做的话，Python 任何一次写入都会把全库的 source/para 抹掉
    # —— JS 那边已经修过同一个问题（core.js 的 extra）。
    KNOWN = ('id', 'text', 'type', 'importance', 'created',
             'lastActivated', 'activationCount', 'day', 'heading')
    out = {k: v for k, v in raw.items() if k not in KNOWN}
    out.update({
        'id': nid,
        'text': text,
        'type': clean_kind(raw.get('type')),
        'importance': clean_importance(raw.get('importance')),
        'created': created if created > 0 else time.time(),
        'lastActivated': last if last > 0 else time.time(),
        'activationCount': max(0, act),
        'day': clean_day(raw.get('day')),
    })
    h = raw.get('heading')
    if isinstance(h, str) and h.strip():
        out['heading'] = h.strip()[:120]
    return out


# ---------- 读写 ----------

def load():
    """
    文件不存在 → 新库
    解析失败 / 权限错误 → 抛错（绝不返回空库，避免覆盖）
    坏节点 / 坏边 → 隔离丢弃
    """
    if not DB.exists():
        return {'nodes': {}, 'edges': {}, 'next_id': 1, '_new': True, '_dropped': 0}
    try:
        raw = DB.read_text(encoding='utf-8-sig')   # 容忍 BOM
    except OSError as e:
        raise RuntimeError('读库失败（%s）: %s' % (type(e).__name__, e))
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError('库文件损坏（JSON 解析失败），拒绝写入以免覆盖原库: %s' % e)
    if not isinstance(parsed, dict):
        raise RuntimeError('库文件格式不对：顶层不是对象')

    nodes = {}
    dropped = 0
    for nid, n in (parsed.get('nodes') or {}).items():
        v = validate_node(n, nid)
        if v:
            nodes[nid] = v
        else:
            dropped += 1

    edges = {}
    for key, e in (parsed.get('edges') or {}).items():
        if not isinstance(e, dict):
            continue
        a, b = e.get('a'), e.get('b')
        if a not in nodes or b not in nodes or a == b:
            continue
        try:
            w = float(e.get('weight'))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(w):
            continue
        try:
            cnt = int(e.get('count') or 0)
        except (TypeError, ValueError):
            cnt = 0
        k = '|'.join(sorted([a, b]))
        edges[k] = {'a': a, 'b': b, 'weight': min(1.0, max(0.0, w)), 'count': max(0, cnt)}

    try:
        next_id = int(parsed.get('next_id') or 1)
    except (TypeError, ValueError):
        next_id = 1
    next_id = max(1, next_id)
    for nid in nodes:
        m = re.fullmatch(r'n(\d+)', nid)
        if m:
            next_id = max(next_id, int(m.group(1)) + 1)

    return {'nodes': nodes, 'edges': edges, 'next_id': next_id, '_dropped': dropped}


def save(db):
    """原子写：先写 .tmp → 保留 .bak → os.replace"""
    body = json.dumps({
        'nodes': db['nodes'],
        'edges': db['edges'],
        'next_id': db['next_id'],
    }, ensure_ascii=False, indent=1)

    DB.parent.mkdir(parents=True, exist_ok=True)
    tmp = DB.with_suffix('.json.tmp-%d-%d' % (os.getpid(), int(time.time() * 1000)))
    try:
        tmp.write_text(body, encoding='utf-8')
    except OSError as e:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise RuntimeError('写临时文件失败: %s' % e)

    if DB.exists():
        try:
            bak = DB.with_suffix('.json.bak')
            bak.write_text(DB.read_text(encoding='utf-8'), encoding='utf-8')
        except OSError:
            pass  # 备份失败不影响主流程

    try:
        os.replace(tmp, DB)
    except OSError as e:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise RuntimeError('替换库文件失败（原库未动）: %s' % e)


# ---------- 时间 ----------

def now_ts():
    return time.time()


# ---------- 写操作 ----------

def add(db, text, kind='note', importance=0.5, day=''):
    clean = clean_text(text)
    if not clean:
        raise ValueError('text 必须是非空字符串')
    nid = 'n%d' % db['next_id']
    db['next_id'] += 1
    ts = now_ts()
    db['nodes'][nid] = {
        'id': nid,
        'text': clean,
        'type': clean_kind(kind),
        'importance': clean_importance(importance),
        'created': ts,
        'lastActivated': ts,
        'activationCount': 1,
        'day': clean_day(day),
    }
    return nid


def connect(db, a, b, delta=0.1):
    if not isinstance(a, str) or not isinstance(b, str):
        raise ValueError('a/b 必须是节点 id')
    if a == b:
        raise ValueError('不能连接自己')
    if a not in db['nodes']:
        raise ValueError('节点不存在: %s' % a)
    if b not in db['nodes']:
        raise ValueError('节点不存在: %s' % b)
    key = '|'.join(sorted([a, b]))
    e = db['edges'].get(key) or {'a': a, 'b': b, 'weight': 0.0, 'count': 0}
    e['weight'] = min(1.0, max(0.0, e['weight'] + delta))
    e['count'] += 1
    db['edges'][key] = e
    return e['weight']


# ---------- 打分 ----------

def decay_factor(node, half_life_days=30.0):
    age = (now_ts() - float(node.get('lastActivated') or 0)) / 86400.0
    return math.pow(0.5, age / half_life_days)


def base_score(node):
    imp = node.get('importance')
    if imp is None:
        imp = 0.5          # 0 是合法值，不能用 `or`
    return (0.4 + 0.6 * float(imp)) * decay_factor(node)


def match_score(query, node):
    q = (query or '').strip()
    if not q:
        return 0.0
    text = node.get('text') or ''
    if q in text:
        density = min(1.0, len(q) / max(20, len(text)))
        return 0.6 + 0.4 * density
    grams = set()
    for n in range(2, 5):
        for i in range(len(q) - n + 1):
            grams.add(q[i:i + n])
    if not grams:
        return 0.0
    hit = sum(1 for g in grams if g in text)
    if hit == 0:
        return 0.0
    cover = hit / len(grams)
    density = min(1.0, (hit * 2.0) / max(20, len(text)))
    return cover * (0.3 + 0.7 * density)


def recall(db, query, top=20, spread=1, spread_factor=0.5, strengthen=True):
    nodes = db['nodes']
    act = {}
    for nid, n in nodes.items():
        s = match_score(query, n)
        if s > 0:
            act[nid] = s * base_score(n)

    if spread > 0 and act:
        for _ in range(spread):
            nxt = {}
            for e in db['edges'].values():
                for src, dst in ((e['a'], e['b']), (e['b'], e['a'])):
                    if act.get(src, 0) > 0.15 and dst in nodes:
                        v = act[src] * e['weight'] * spread_factor * base_score(nodes[dst])
                        nxt[dst] = max(nxt.get(dst, 0.0), v)
            for k, v in nxt.items():
                act[k] = max(act.get(k, 0.0), v)

    ranked = sorted(act.items(), key=lambda kv: -kv[1])[:top]

    if strengthen:
        for nid, _ in ranked:
            n = nodes.get(nid)
            if not n:
                continue
            n['lastActivated'] = now_ts()
            n['activationCount'] = int(n.get('activationCount') or 0) + 1
            imp = n.get('importance')
            if imp is None:
                imp = 0.5
            n['importance'] = min(1.0, float(imp) + 0.01)

    return [(nid, act[nid], nodes[nid]) for nid, _ in ranked if nid in nodes]


# ---------- 命令 ----------

def cmd_init():
    db = load()
    save(db)
    print('初始化: %s' % DB)
    print('节点 %d / 连接 %d' % (len(db['nodes']), len(db['edges'])))


def cmd_add(args):
    if not args:
        print('用法: add "文本" [类型] [重要性] [--day 2026-10-28]')
        return
    day = ''
    rest = []
    i = 0
    while i < len(args):
        if args[i] == '--day' and i + 1 < len(args):
            day = args[i + 1]
            i += 2
        else:
            rest.append(args[i])
            i += 1
    text = rest[0]
    kind = rest[1] if len(rest) > 1 else 'note'
    imp = rest[2] if len(rest) > 2 else 0.5
    db = load()
    nid = add(db, text, kind, imp, day)
    save(db)
    print('已添加 %s: %s' % (nid, text[:60]))


def cmd_connect(args):
    if len(args) < 2:
        print('用法: connect n1 n2')
        return
    db = load()
    try:
        w = connect(db, args[0], args[1])
        save(db)
        print('已连接 %s <-> %s  (强度 %.2f)' % (args[0], args[1], w))
    except ValueError as e:
        print('错误: %s' % e)


def cmd_recall(args):
    preview = '--preview' in args
    top = 20
    skip = {'--preview'}
    if '--top' in args:
        i = args.index('--top')
        skip.add('--top')
        if i + 1 < len(args):
            top = clean_top(args[i + 1])
            skip.add(args[i + 1])       # 只吃掉 --top 的那个值
    # 剩下的都算查询词。注意：不能把所有纯数字都删掉 ——
    # 查 "2026" 或 "10-28" 这类词会被吃空。只排除显式参数及其值。
    query = ' '.join(a for a in args if a not in skip)
    db = load()
    res = recall(db, clean_query(query), top, 1, 0.5, strengthen=not preview)
    if not preview and res:
        save(db)
    print('查询: %s%s' % (query, '（预览，不强化）' if preview else ''))
    print('召回 %d 条:' % len(res))
    for i, (nid, s, n) in enumerate(res, 1):
        print('  [%d] %.3f  %s  (%s, 激活 %d 次)' % (
            i, s, (n.get('text') or '')[:60], n.get('type'), int(n.get('activationCount') or 0)))


def cmd_show():
    db = load()
    print('共 %d 个节点：' % len(db['nodes']))
    for nid, n in db['nodes'].items():
        print('  %-6s %-6s %.2f  %s' % (
            nid, n.get('type'), float(n.get('importance') or 0),
            (n.get('text') or '')[:56]))


def cmd_stats():
    db = load()
    print('节点 %d / 连接 %d' % (len(db['nodes']), len(db['edges'])))
    print('库: %s' % DB)
    if db.get('_dropped'):
        print('⚠ 加载时丢弃了 %d 条坏数据' % db['_dropped'])
    if not db['nodes']:
        return
    print('\n激活最多的 10 个:')
    for n in sorted(db['nodes'].values(),
                    key=lambda x: -int(x.get('activationCount') or 0))[:10]:
        print('  %3d 次  %.2f  %s' % (
            int(n.get('activationCount') or 0),
            float(n.get('importance') or 0),
            (n.get('text') or '')[:50]))
    print('\n连接最强的 10 条:')
    for e in sorted(db['edges'].values(), key=lambda x: -x['weight'])[:10]:
        a = (db['nodes'].get(e['a']) or {}).get('text', '?')[:20]
        b = (db['nodes'].get(e['b']) or {}).get('text', '?')[:20]
        print('  %.2f  %s <-> %s' % (e['weight'], a, b))


def cmd_backup():
    db = load()
    out = DB.with_suffix('.snapshot-%s.json' % time.strftime('%Y%m%d_%H%M%S'))
    out.write_text(json.dumps({
        'nodes': db['nodes'],
        'edges': db['edges'],
        'next_id': db['next_id'],
        '_exported_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
    }, ensure_ascii=False, indent=1), encoding='utf-8')
    print('无损快照: %s' % out)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    args = sys.argv[2:]
    try:
        if cmd == 'init':
            cmd_init()
        elif cmd == 'add':
            cmd_add(args)
        elif cmd == 'connect':
            cmd_connect(args)
        elif cmd == 'recall':
            cmd_recall(args)
        elif cmd == 'show':
            cmd_show()
        elif cmd == 'stats':
            cmd_stats()
        elif cmd == 'backup':
            cmd_backup()
        else:
            print('未知命令: %s' % cmd)
    except (RuntimeError, ValueError) as e:
        print('错误: %s' % e)
        sys.exit(1)


if __name__ == '__main__':
    main()
