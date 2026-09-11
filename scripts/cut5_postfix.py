# 刀 5 后置修正：三符号归位断环 + jolRng 访问器（在 cut.py 之后运行一次）
import io

def load(p): return io.open(p, encoding='utf8').read()
def save(p, s): io.open(p, 'w', encoding='utf8', newline='\n').write(s)

def find_block(text, sig, kind='fn'):
    """从 sig 所在行起做字符级扫描，返回完整块文本（含签名行到配对闭括号行）。"""
    a = text.index(sig)
    line_start = text.rfind('\n', 0, a) + 1
    # 1) 参数闭括号
    depth, ci, close = 0, a, None
    in_str = None
    while ci < len(text):
        ch = text[ci]
        if in_str:
            if ch == in_str: in_str = None
        elif ch in '\'"`': in_str = ch
        elif ch == '(': depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0: close = ci; break
        ci += 1
    assert close is not None, sig
    # 2) 类型感知找体 '{'（零深度 '{' 后若紧跟另一个 '{'，前者是对象字面量返回类型）
    ang = par = brace = 0
    in_str = None
    body_ci = None
    cj = close + 1
    while cj < len(text):
        ch = text[cj]
        if in_str:
            if ch == in_str: in_str = None
        elif ch in '\'"`': in_str = ch
        elif ch == '<': ang += 1
        elif ch == '>':
            if ang > 0: ang -= 1
        elif ch == '(': par += 1
        elif ch == ')': par -= 1
        elif ch == '{':
            if ang == 0 and par == 0 and brace == 0:
                # 找配对 '}'，其后第一个非空白若是 '{' → 刚才是类型字面量
                d2, k2 = 1, cj + 1
                while True:
                    ch2 = text[k2]
                    if ch2 == '{': d2 += 1
                    elif ch2 == '}':
                        d2 -= 1
                        if d2 == 0: break
                    k2 += 1
                n = k2 + 1
                while n < len(text) and text[n] in ' \t\r\n':
                    n += 1
                if n < len(text) and text[n] == '{':
                    cj = k2
                else:
                    body_ci = cj
                    break
            else:
                brace += 1
        elif ch == '}': brace -= 1
        cj += 1
    assert body_ci is not None, sig
    # 3) 配对
    d, k = 1, body_ci + 1
    while True:
        ch = text[k]
        if ch == '{': d += 1
        elif ch == '}':
            d -= 1
            if d == 0: break
        k += 1
    end = text.index('\n', k) + 1
    return text[line_start:end], line_start, end

def find_interface(text, name):
    a = text.index('export interface %s {' % name)
    d, k = 1, text.index('{', a) + 1
    while True:
        ch = text[k]
        if ch == '{': d += 1
        elif ch == '}':
            d -= 1
            if d == 0: break
        k += 1
    return text[a:text.index('\n', k) + 1]

# ---------- projects.ts ----------
p = 'src/engine/projects.ts'
s = load(p)

f1, a1, b1 = find_block(s, 'export function validatePlanItems(')
f2, a2, b2 = find_block(s, 'export function validatePlanArtifact(')
planitem = find_interface(s, 'PlanItem')
fading = """export type FadingTier = '骨架' | '补全' | '独立'
export const FADING_TIERS: FadingTier[] = ['骨架', '补全', '独立']"""
assert s.count(fading) == 1

for txt, a, b in sorted([(f1, a1, b1), (f2, a2, b2), (fading + '\n', *find_simple(s, fading)) ] if False else []):
    pass

# 先删大偏移
def remove_at(s, a, b):
    return s[:a] + s[b:]
for a, b in sorted([(a1, b1), (a2, b2)], key=lambda x: -x[0]):
    s = remove_at(s, a, b)
fa = s.index(fading)
s = s[:fa] + s[fa + len(fading) + 1:]

shim = """// FadingTier/FADING_TIERS 住 types.ts、PlanItem 与计划产物校验住 project-decompile.ts
// （#152 刀 5 归位：project-exec/project-decompile 反向引用，留原地即成环）；
// 原路径 re-export，门面与 tests 的既有导入路径不晃。
export type { FadingTier } from './types.ts'
export { FADING_TIERS } from './types.ts'
import { FADING_TIERS } from './types.ts'
import type { FadingTier } from './types.ts'
export type { PlanItem } from './project-decompile.ts'
export { validatePlanItems, validatePlanArtifact } from './project-decompile.ts'
import type { PlanItem } from './project-decompile.ts'
import { validatePlanItems, validatePlanArtifact } from './project-decompile.ts'"""
s = s.replace("import { todayStr } from './dates.ts'",
              shim + "\nimport { todayStr } from './dates.ts'", 1)

# views→proposals + jolRng
old = "import type { GraphProposeResult } from './views.ts'"
assert s.count(old) == 1
s = s.replace(old, "import type { GraphProposeResult } from './proposals.ts'")
old = "  jolRng: () => number"
assert s.count(old) == 1
s = s.replace(old, "  /** 取当前 JOL 随机源（可注入播种；经访问器惰性取，测试注入后构造期不锁定）。 */\n  jolRng(): () => number")
old = 'opts.limit ?? 5, this.e.jolRng)'
assert s.count(old) == 1
s = s.replace(old, 'opts.limit ?? 5, this.e.jolRng())')
save(p, s)

# ---------- types.ts ----------
p = 'src/engine/types.ts'
s = load(p).rstrip('\n')
s += """

/** 项目渐退档（P 区 / ADR-0015；#152 刀 5 自 projects.ts 归位中立层——project-exec
 * 反向值导入该常量，留原地会锁死 projects→project-exec 的正向导入）。 */
export type FadingTier = '骨架' | '补全' | '独立'
export const FADING_TIERS: FadingTier[] = ['骨架', '补全', '独立']
"""
save(p, s)

# ---------- project-exec.ts ----------
p = 'src/engine/project-exec.ts'
s = load(p)
s = s.replace("import { FADING_TIERS } from './projects.ts'", "import { FADING_TIERS } from './types.ts'")
s = s.replace("import type { FadingTier } from './projects.ts'", "import type { FadingTier } from './types.ts'")
save(p, s)

# ---------- project-decompile.ts ----------
p = 'src/engine/project-decompile.ts'
s = load(p)
s = s.replace("import { validatePlanArtifact } from './projects.ts'\n", '')
s = s.replace("import type { PlanItem } from './projects.ts'\n", '')
s = s.rstrip('\n') + '\n\n' + planitem + '\n\n' + f1 + '\n' + f2
save(p, s)

# ---------- views.ts：提案结果四型 → proposals ----------
p = 'src/engine/views.ts'
s = load(p)
g1 = find_interface(s, 'GraphEditProposalResult')
g2 = find_interface(s, 'GraphSeedProposalResult')
g3 = find_interface(s, 'GraphEnrichProposalResult')
union = 'export type GraphProposeResult = GraphEditProposalResult | GraphSeedProposalResult | GraphEnrichProposalResult'
block = g1 + '\n' + g2 + '\n' + g3 + '\n' + union + '\n'
assert union in s
for t in (g1, g2, g3):
    assert s.count(t) == 1
for t in (g1, g2, g3):
    s = s.replace(t + '\n', '', 1)
s = s.replace(union + '\n', '')
s = s.replace('// ---- 提案门禁（graphPropose / graphApply / graphEncBackfill；proposals.GraphProposals）----',
              """// ---- 提案门禁（graphPropose / graphApply / graphEncBackfill；proposals.GraphProposals）----
// Graph*ProposalResult 四型住 proposals.ts（提案域词汇，#152 刀 5 归位——projects 的
// 窄面引用它们，经 views barrel 会绕出类型环）。
export type {
  GraphEditProposalResult, GraphSeedProposalResult, GraphEnrichProposalResult, GraphProposeResult,
} from './proposals.ts'""", 1)
save(p, s)

# ---------- proposals.ts：追加四型 ----------
p = 'src/engine/proposals.ts'
s = load(p).rstrip('\n')
s += '\n\n// ---- 图提案受理结果（#152 刀 5 自 views.ts 归位）----\n\n' + g1 + '\n\n' + g2 + '\n\n' + g3 + '\n\n' + union + '\n'
save(p, s)
print('postfix done')
