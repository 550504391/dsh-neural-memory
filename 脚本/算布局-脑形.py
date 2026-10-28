# -*- coding: utf-8 -*-
"""回到脑形布局，但把间距拉开（减少重叠）

在"脑轮廓"的基础上：
  ① 半球/小脑/脑干的分布保持
  ② 但每个区域内部再拉开（半径系数 +0.15）
  ③ 运行更多轮轻力导向（让挨太近的分开）
"""
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


import math
import random
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding='utf-8')
random.seed(7)
np.random.seed(7)

SRC = _resolve_db()
OUT = Path(__file__).resolve().parent.parent / '数据' / 'brain-data.js'

db = json.loads(SRC.read_text(encoding='utf-8'))
nodes = list(db['nodes'].values())
edges = list(db['edges'].values())
idx = {n['id']: i for i, n in enumerate(nodes)}
N = len(nodes)

TYPE_COLORS = {
    '故事': '#4a7fbf', '身份': '#3f9b78', '说话': '#3f9b78', '雷点': '#a87838',
    '在意': '#b85858', '长期': '#3f9b78', '错题': '#965454', '权重': '#c9a227',
    '判断史': '#6a6aae', '弱点': '#924848', '看人': '#4a9494', '感想': '#7a6a9e',
    '总账': '#4a7fbf', '日记': '#5f8a5f', '事件': '#4a7fbf', '情绪': '#b85858',
    '判断': '#6a6aae', 'note': '#7a7a7a',
}

REGION_L, REGION_R, REGION_CB, REGION_STEM = 0, 1, 2, 3

def pick_region(i, k):
    if k in ('权重', 'note'):
        return REGION_STEM
    if k in ('情绪', '在意', '看人', '感想', '身份', '长期'):
        return REGION_R
    if i % 10 == 0:
        return REGION_CB
    return REGION_L if (i % 2 == 0) else REGION_R

pos = np.zeros((N, 3))
region_of = np.zeros(N, dtype=int)

for i, n in enumerate(nodes):
    reg = pick_region(i, n['type'])
    region_of[i] = reg
    if reg in (REGION_L, REGION_R):
        cx = -0.46 if reg == REGION_L else 0.46
        # 壳层分布：多数在外层（离表面近），内层少
        r = 0.62 + random.random() * 0.38
        theta = random.uniform(0, math.pi * 2)
        phi = math.acos(random.uniform(-1, 1))
        x = cx + r * 0.34 * math.sin(phi) * math.cos(theta)
        y = r * 0.29 * math.cos(phi) + 0.06
        z = r * 0.30 * math.sin(phi) * math.sin(theta)
        x = min(x, -0.02) if reg == REGION_L else max(x, 0.02)
    elif reg == REGION_CB:
        side = -1 if random.random() < 0.5 else 1
        r = 0.7 + random.random() * 0.3
        theta = random.uniform(0, math.pi * 2)
        phi = math.acos(random.uniform(-1, 1))
        x = side * 0.20 + r * 0.16 * math.sin(phi) * math.cos(theta)
        y = -0.36 + r * 0.12 * math.cos(phi)
        z = r * 0.14 * math.sin(phi) * math.sin(theta)
    else:
        x = random.gauss(0, 0.04)
        y = -0.56 - random.random() * 0.18
        z = random.gauss(0, 0.04)
    pos[i] = [x, y, z]

E = []
for e in edges:
    a, b = idx.get(e['a']), idx.get(e['b'])
    if a is not None and b is not None:
        E.append((a, b, e['weight']))

print('节点 %d / 边 %d' % (N, len(E)))

# 强斥力 + 弱引力 + 区域约束 → 拉开但不散形
for it in range(140):
    disp = np.zeros_like(pos)
    for i in range(N):
        js = np.random.randint(0, N, 30)
        d = pos[i] - pos[js]
        d2 = (d * d).sum(axis=1) + 0.0002
        f = 0.00016 / d2
        disp[i] += (d / np.sqrt(d2)[:, None] * f[:, None]).sum(axis=0)
    for a, b, w in E:
        d = pos[a] - pos[b]
        dist = math.sqrt((d * d).sum()) + 0.001
        f = dist * 0.05 * min(w + 0.2, 1.0)
        u = d / dist
        disp[a] -= u * f * 0.01
        disp[b] += u * f * 0.01
    # 区域"家"约束（保持脑形）
    for i in range(N):
        reg = region_of[i]
        if reg in (REGION_L, REGION_R):
            home = np.array([(-0.46 if reg == REGION_L else 0.46), 0.06, 0.0])
        elif reg == REGION_CB:
            home = np.array([0.0, -0.36, 0.0])
        else:
            home = np.array([0.0, -0.62, 0.0])
        disp[i] += (home - pos[i]) * 0.0004
    pos += disp * 0.03

pos -= pos.mean(axis=0)
mx = np.abs(pos).max() + 1e-6
pos = pos / mx

out_nodes = []
for i, n in enumerate(nodes):
    out_nodes.append({
        'id': n['id'],
        't': n['text'][:90],
        'k': n['type'],
        'i': round(n['importance'], 2),
        'd': n.get('day', ''),
        'x': round(float(pos[i][0]) * 820, 1),
        'y': round(float(pos[i][1]) * 820, 1),
        'z': round(float(pos[i][2]) * 820, 1),
        'r': int(region_of[i]),
    })
out_edges = [[e['a'], e['b'], round(e['weight'], 2)] for e in edges
             if e['a'] in idx and e['b'] in idx]

OUT.write_text('window.BRAIN_DATA = ' + json.dumps(
    {'nodes': out_nodes, 'edges': out_edges, 'colors': TYPE_COLORS},
    ensure_ascii=False), encoding='utf-8')
print('导出: %s (%d KB)' % (OUT, OUT.stat().st_size // 1024))
for reg, name in [(0, '左半球'), (1, '右半球'), (2, '小脑'), (3, '脑干')]:
    print('  %s: %d' % (name, int((region_of == reg).sum())))
