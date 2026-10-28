# -*- coding: utf-8 -*-
"""r按天拆分记忆：一天一个目录

记忆\2026-10-14\
    day.json        这天的节点和连接
    index.md        这天的目录（人看的）

同时生成 day-index.js（给可视化用：每天一个子图）
"""
import json
import re
import sys
import time
from collections import defaultdict
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

SRC = _resolve_db()
OUT = SRC.parent / '记忆'

db = json.loads(SRC.read_text(encoding='utf-8'))
nodes = db['nodes']
edges = db['edges']
idx = {nid: n for nid, n in nodes.items()}

# 按 created 的日期分组

def safe_dirname(day):
    """日期会被当目录名用 —— 出现 .. / 绝对路径 / 特殊字符一律换成 '未标日期'"""
    if not isinstance(day, str) or not day.strip():
        return '未标日期'
    d = day.strip()
    if d in ('(常驻)', '常驻', '(未标日期)'):
        return '常驻'
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', d):
        return d
    if re.fullmatch(r'[\w\u4e00-\u9fa5()（）-]{1,12}', d):
        return d
    return '未标日期'

def day_of_node(n):
    """优先用灌入时记的真实日期；没有就归"常驻"（总账正文/家/判断史这些没日期的）"""
    d = n.get('day')
    if d:
        return safe_dirname(d)
    return '常驻'

by_day = defaultdict(list)
for nid, n in nodes.items():
    by_day[day_of_node(n)].append(nid)

# 边：两端在同一天才能进那天的子图
day_edges = defaultdict(list)
for key, e in edges.items():
    d1, d2 = day_of_node(nodes[e['a']]), day_of_node(nodes[e['b']])
    if d1 == d2:
        day_edges[d1].append([e['a'], e['b'], e['weight']])

OUT.mkdir(parents=True, exist_ok=True)

index_lines = ['# 记忆 · 按天', '', '| 日期 | 节点 | 连接 |', '|---|---|---|']
day_payload = {}

for day in sorted(by_day):
    nids = by_day[day]
    dd = OUT / day
    dd.mkdir(exist_ok=True)

    payload = {
        'day': day,
        'nodes': [{'id': i, 't': nodes[i]['text'][:400], 'k': nodes[i]['type'],
                   'i': round(nodes[i]['importance'], 2),
                   'h': nodes[i].get('heading', '')} for i in nids],
        'edges': day_edges[day],
    }
    (dd / 'day.json').write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')

    # 人看的目录
    md = '# %s\n\n共 %d 条记忆\n\n' % (day, len(nids))
    for i, nid in enumerate(nids):
        n = nodes[nid]
        md += '- **%s**（%s, %.2f）%s\n' % (
            n.get('heading', '') or '—', n['type'], n['importance'],
            n['text'][:60].replace('\n', ' '))
    (dd / 'index.md').write_text(md, encoding='utf-8')

    index_lines.append('| %s | %d | %d |' % (day, len(nids), len(day_edges[day])))
    day_payload[day] = {'nodes': len(nids), 'edges': len(day_edges[day])}

(OUT / 'README.md').write_text('\n'.join(index_lines), encoding='utf-8')

# 给可视化：每天的子图索引（轻量，只记 id 范围）
(OUT / 'day-index.js').write_text(
    'window.DAY_INDEX = ' + json.dumps({
        'days': sorted(by_day.keys()),
        'count': {d: len(by_day[d]) for d in by_day},
        'edges': {d: len(day_edges[d]) for d in by_day},
    }, ensure_ascii=False) + ';', encoding='utf-8')

print('按天拆分完成：%d 天' % len(by_day))
for day in sorted(by_day):
    print('  %s  %4d 节点 / %4d 连接' % (day, len(by_day[day]), len(day_edges[day])))
print('')
print('目录: %s' % OUT)
