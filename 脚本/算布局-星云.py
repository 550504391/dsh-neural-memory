# -*- coding: utf-8 -*-
"""星云布局：两条旋臂 + 中心核球 + 外围晕

不是在球里随机撒点，而是沿两条对数螺旋排布：
  核心（半径 < 0.2）密集，亮
  旋臂（对角 θ，r = a·e^(bθ)）跟着走
  晕（10% 随机撒在外围）
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
random.seed(42)
np.random.seed(42)

SRC = _resolve_db()
OUT = Path(__file__).resolve().parent.parent / '数据' / 'brain-data.js'

db = json.loads(SRC.read_text(encoding='utf-8'))
nodes = list(db['nodes'].values())
edges = list(db['edges'].values())
idx = {n['id']: i for i, n in enumerate(nodes)}
N = len(nodes)

TYPE_COLORS = {
    '故事': '#6fa8dc', '身份': '#58c08a', '说话': '#58c08a', '雷点': '#d0a050',
    '在意': '#e08080', '长期': '#58c08a', '错题': '#c07070', '权重': '#ffd24a',
    '判断史': '#9090e0', '弱点': '#c06060', '看人': '#60c0c0', '感想': '#a090d0',
    '总账': '#6fa8dc', '日记': '#80b080', '事件': '#6fa8dc', '情绪': '#e08080',
    '判断': '#9090e0', 'note': '#9a9a9a',
}

# ---- 分配：核心 / 旋臂1 / 旋臂2 / 晕 ----
pos = np.zeros((N, 3))
kind_of = np.zeros(N, dtype=int)  # 0 核 1 臂1 2 臂2 3 晕

for i, n in enumerate(nodes):
    imp = n['importance']
    rnd = random.random()
    # 重要度高的往核心（重要 = 亮 = 中心）
    if rnd < 0.10 + imp * 0.12:
        kind_of[i] = 0
    elif rnd < 0.45:
        kind_of[i] = 1
    elif rnd < 0.80:
        kind_of[i] = 2
    else:
        kind_of[i] = 3

# 旋臂角度起点（两条臂错开 π）
ARM_PHASE = {1: 0.0, 2: math.pi}
ARM_TIGHT = 0.55   # 螺旋紧密度

for i in range(N):
    k = kind_of[i]
    if k == 0:
        # 核心：小半径高斯
        r = abs(random.gauss(0, 0.10))
        theta = random.uniform(0, 2 * math.pi)
        y = random.gauss(0, 0.06)
    elif k in (1, 2):
        # 旋臂
        t = random.random() ** 0.7   # 越靠外越稀
        r = 0.12 + t * 0.82
        theta = ARM_PHASE[k] + math.log(r / 0.12 + 1) / ARM_TIGHT
        theta += random.gauss(0, 0.13)   # 臂的宽度
        y = random.gauss(0, 0.045) * (0.4 + r)
    else:
        # 晕
        r = 0.55 + random.random() * 0.55
        theta = random.uniform(0, 2 * math.pi)
        y = random.gauss(0, 0.11)

    # 螺旋臂在盘面内，压扁一点（3D 里像银河）
    pos[i] = [r * math.cos(theta), y, r * math.sin(theta)]

# ---- 轻微力导向（不动大形状，只让边近一点） ----
E = []
for e in edges:
    a, b = idx.get(e['a']), idx.get(e['b'])
    if a is not None and b is not None:
        E.append((a, b, e['weight']))

print('节点 %d / 边 %d' % (N, len(E)))

for it in range(60):
    disp = np.zeros_like(pos)
    for i in range(N):
        js = np.random.randint(0, N, 20)
        d = pos[i] - pos[js]
        d2 = (d * d).sum(axis=1) + 0.0003
        disp[i] += (d / np.sqrt(d2)[:, None] * (0.000012 / d2)[:, None].sum(axis=0) if False else (d / np.sqrt(d2)[:, None] * (0.000012 / d2)[:, None]).sum(axis=0))
    for a, b, w in E:
        d = pos[a] - pos[b]
        dist = math.sqrt((d * d).sum()) + 0.001
        f = dist * 0.10 * min(w + 0.2, 1.0)
        u = d / dist
        disp[a] -= u * f * 0.015
        disp[b] += u * f * 0.015
    pos += disp * 0.02

# ---- 归一化 ----
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
        'x': round(float(pos[i][0]) * 800, 1),
        'y': round(float(pos[i][1]) * 800, 1),
        'z': round(float(pos[i][2]) * 800, 1),
        'r': int(kind_of[i]),
    })
out_edges = [[e['a'], e['b'], round(e['weight'], 2)] for e in edges
             if e['a'] in idx and e['b'] in idx]

OUT.write_text('window.BRAIN_DATA = ' + json.dumps(
    {'nodes': out_nodes, 'edges': out_edges, 'colors': TYPE_COLORS},
    ensure_ascii=False), encoding='utf-8')
print('导出: %s (%d KB)' % (OUT, OUT.stat().st_size // 1024))
for k, name in [(0, '核心'), (1, '旋臂1'), (2, '旋臂2'), (3, '晕')]:
    print('  %s: %d' % (name, int((kind_of == k).sum())))
