# -*- coding: utf-8 -*-
"""神经系统 · 全面测试（A 召回 / B 灌入 / C 新增）

输出一份可读报告。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

PY = sys.executable      # 用当前解释器，不写死别人的路径
BASE = Path(__file__).resolve().parent
MEM = BASE / '类神经记忆.py'

# 测试一律用临时库，绝不碰正式数据（审查报告第 6 条）
import shutil
import tempfile
_TMPDIR = Path(tempfile.mkdtemp(prefix='neural-test-'))
TEMP_DB = _TMPDIR / 'neural-memory.json'

# 拿一份正式库的副本当测试底料，测完删掉
try:
    shutil.copyfile(BASE / 'neural-memory.json', TEMP_DB)
    print('测试库: %s（正式库的副本）' % TEMP_DB)
except Exception:
    TEMP_DB.write_text('{"nodes":{},"edges":{},"next_id":1}', encoding='utf-8')
    print('测试库: %s（空库）' % TEMP_DB)

DB = TEMP_DB


def run(args):
    env = dict(os.environ)
    env['NEURAL_MEMORY_DB'] = str(TEMP_DB)   # 子进程也用临时库
    r = subprocess.run([PY, str(MEM)] + args, capture_output=True, text=True,
                       encoding='utf-8', errors='ignore', env=env)
    return r.stdout + r.stderr


def load():
    return json.loads(DB.read_text(encoding='utf-8'))


print('=' * 60)
print('A. 召回测试')
print('=' * 60)

# 每个查询期望的关键词（命中即算对）
CASES = [
    ('第一次', ['第一次']),
    ('约定', ['约定', '答应']),
    ('那天', ['那天']),
    ('名字', ['名字', '叫我']),
    ('回家', ['回家', '家']),
    ('电影', ['电影']),
]

pass_n = 0
for q, expects in CASES:
    out = run(['recall', q])
    lines = [l for l in out.split('\n') if l.strip().startswith('[')]
    top5 = ' '.join(lines[:5])
    hit = [e for e in expects if e in top5]
    ok = len(hit) > 0
    if ok:
        pass_n += 1
    print('\n查询: %s' % q)
    print('  期望提到: %s' % '/'.join(expects))
    print('  前5条里命中: %s' % ('/'.join(hit) if hit else '（无）'))
    print('  结果: %s' % ('✓ 通过' if ok else '✗ 没召回到'))
    for l in lines[:3]:
        print('    ' + l.strip()[:100])

print('\nA 结论: %d/%d 通过' % (pass_n, len(CASES)))

print()
print('=' * 60)
print('B. 灌入测试（源 vs 库）')
print('=' * 60)

db = load()
nodes = db['nodes']
print('库里节点: %d' % len(nodes))
print('库里连接: %d' % len(db['edges']))

# 检查：有没有空文本、重复文本、缺字段
empty = [n for n in nodes.values() if not n.get('text', '').strip()]
dups = {}
for n in nodes.values():
    t = n.get('text', '').strip()
    dups[t] = dups.get(t, 0) + 1
dup_n = sum(1 for v in dups.values() if v > 1)
no_type = [n for n in nodes.values() if not n.get('type')]
no_day = [n for n in nodes.values() if not n.get('day')]
has_day = [n for n in nodes.values() if n.get('day')]

print('\n质量检查:')
print('  空文本: %d %s' % (len(empty), '✓' if not empty else '✗'))
print('  重复文本: %d 组 %s' % (dup_n, '✓' if dup_n == 0 else '（允许，不同来源可能重复）'))
print('  缺类型: %d %s' % (len(no_type), '✓' if not no_type else '✗'))
print('  有日期的: %d' % len(has_day))
print('  没日期的(常驻): %d' % len(no_day))

# 按天分布
days = {}
for n in nodes.values():
    d = n.get('day') or '(常驻)'
    days[d] = days.get(d, 0) + 1
print('\n按天分布:')
for d in sorted(days):
    print('  %-12s %4d' % (d, days[d]))

print()
print('=' * 60)
print('C. 新增测试（灌一条 → 召回）')
print('=' * 60)

TEST_TEXT = '测试专用：这是一条测试记忆'
out1 = run(['add', TEST_TEXT, '判断', '0.5'])
print('add 输出: ' + out1.strip()[:100])

out2 = run(['recall', '测试专用'])
lines = [l for l in out2.split('\n') if l.strip().startswith('[')]
print('recall 返回 %d 条' % len(lines))
found = any('测试专用' in l for l in lines)
print('新灌的那条召回到了: %s' % ('✓' if found else '✗'))
if lines:
    print('  第一条: ' + lines[0].strip()[:100])

# 清理：把测试节点删掉（直接改库）
db = load()
to_del = [k for k, n in db['nodes'].items() if TEST_TEXT in n.get('text', '')]
if to_del:
    for k in to_del:
        del db['nodes'][k]
    # 删相关边
    db['edges'] = {k: v for k, v in db['edges'].items()
                   if v['a'] not in to_del and v['b'] not in to_del}
    DB.write_text(json.dumps(db, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n清理: 删掉 %d 个测试节点' % len(to_del))

print()
print('=' * 60)
print('测试完')
print('=' * 60)

# 清理临时库
shutil.rmtree(_TMPDIR, ignore_errors=True)
