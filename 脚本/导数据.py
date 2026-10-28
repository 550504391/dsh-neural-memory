# -*- coding: utf-8 -*-
"""导出 3D 可视化数据：从 neural-memory.json 抽节点和连接"""
import json

import os as _os


def _resolve_db():
    """env → 用户配置 → 包内 数据/neural-memory.json"""
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


import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

SRC = _resolve_db()
OUT = Path(__file__).resolve().parent.parent / '数据' / 'brain-data.js'

db = json.loads(SRC.read_text(encoding='utf-8'))
nodes = db['nodes']
edges = db['edges']

# 类型 -> 颜色（跟 2D 图一致）
TYPE_COLORS = {
    '故事': '#5b7fa6',
    '身份': '#4a8c6f',
    '说话': '#4a8c6f',
    '雷点': '#8c6f4a',
    '在意': '#a06a6a',
    '长期': '#4a8c6f',
    '错题': '#8c6a6a',
    '权重': '#c9a227',
    '判断史': '#6a6a9c',
    '弱点': '#8c5a5a',
    '看人': '#6a8c8c',
    '感想': '#7a6a8c',
    '总账': '#5b7fa6',
    '日记': '#6a7a6a',
    '事件': '#5b7fa6',
    '情绪': '#a06a6a',
    '判断': '#6a6a9c',
    'note': '#7a7a7a',
}

out_nodes = []
for n in nodes.values():
    out_nodes.append({
        'id': n['id'],
        't': n['text'][:80],
        'k': n['type'],
        'i': round(n['importance'], 2),
        'c': n.get('created', 0),
        'd': n.get('day', ''),          # 日期（原来是 heading，2026-10-28 修）
        'h': n.get('heading', '')[:30],
    })

out_edges = []
for e in edges.values():
    out_edges.append([e['a'], e['b'], round(e['weight'], 2)])

data = {
    'nodes': out_nodes,
    'edges': out_edges,
    'colors': TYPE_COLORS,
}

OUT.write_text('window.BRAIN_DATA = ' + json.dumps(data, ensure_ascii=False) + ';',
               encoding='utf-8')
print('导出: %s' % OUT)
print('节点 %d / 连接 %d / %d KB' % (len(out_nodes), len(out_edges), OUT.stat().st_size // 1024))
