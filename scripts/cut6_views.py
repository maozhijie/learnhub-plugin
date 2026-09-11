# 刀 6 视图归档：bank 视图类型 → views/bank.ts 叶子；Graph*ProposalResult → views/proposals.ts 叶子
# （领主/窄面只引叶子，不经 views.ts barrel 牵进重模块——R7 环的根）
import io, re, glob, os

def load(p): return io.open(p, encoding='utf8').read()
def save(p, s): io.open(p, 'w', encoding='utf8', newline='\n').write(s)

def defined(text):
    return set(re.findall(r'export (?:interface|type) (\w+)', text))

def block(text, n):
    m = re.search(r'export (?:interface|type) %s\b' % n, text)
    a = m.start()
    pre = text.rfind('/**', 0, a)
    if pre != -1 and text[pre:a].strip().endswith('*/') and text[pre:a].count('\n') <= 12:
        a = pre
    if text[m.start():].startswith('export type'):
        end = text.index('\n', text.index('=', m.start()))
    else:
        i = text.index('{', m.start())
        d, k = 0, i
        while True:
            if text[k] == '{': d += 1
            elif text[k] == '}':
                d -= 1
                if d == 0: break
            k += 1
        end = text.index('\n', k)
    return text[a:end], a, end

def closure(text, seeds):
    want = set(seeds)
    allnames = defined(text)
    changed = True
    while changed:
        changed = False
        body = '\n'.join(block(text, n)[0] for n in sorted(want))
        used = set(re.findall(r'(?<![\w.$])([A-Z]\w{2,})(?![\w$])', body))
        extra = {u for u in used if u in allnames and u not in want}
        if extra:
            want |= extra
            changed = True
    return want

def extract_and_remove(text, want):
    chunks = [(block(text, n)) for n in sorted(want)]
    for b, a, e in sorted(chunks, key=lambda x: -x[1]):
        text = text[:a] + text[e + 1:]
    return text, chunks

def engine_exports():
    ex = {}
    for f in glob.glob('src/engine/*.ts') + glob.glob('src/engine/views/*.ts'):
        src = load(f)
        for m in re.finditer(r'export (?:async )?(?:function|const|class|let|interface|type) (\w+)', src):
            ex.setdefault(m.group(1), []).append('./' + os.path.basename(f))
    return ex

def needed_type_imports(body, self_names, out_path):
    ex = engine_exports()
    used = set(re.findall(r'(?<![\w.$])([A-Z]\w{2,})(?![\w$])', body))
    own = set(self_names)
    bym = {}
    for n in sorted(used):
        if n in own or n in ('Array', 'Record', 'Promise', 'Map', 'Set', 'Date', 'Partial', 'Omit', 'Pick', 'Exclude', 'Readonly'):
            continue
        if n in ex:
            mod = ex[n][0]
            if mod == os.path.basename(out_path):
                continue
            bym.setdefault(mod, []).append(n)
    lines = []
    prefix = '../' if out_path.startswith('views/') else './'
    for mod, ns in sorted(bym.items()):
        if mod == './index.ts':
            raise SystemExit('拒绝自动导入 engine/index.ts（R6）: ' + ', '.join(ns))
        lines.append("import type { %s } from '%s%s'" % (', '.join(sorted(ns)), prefix, mod[2:]))
    return lines

# ---------- 1) views/bank.ts ----------
vp = 'src/engine/views.ts'
v = load(vp)
seeds = {'CleanupGroup', 'CleanupPreviewDoc', 'DifficultyAdviceDoc', 'DisputeApplyResult', 'DisputeReviewResult',
         'ErrorAnswerResult', 'ErrorArchiveResult', 'ErrorCardItem', 'ErrorGenerateResult', 'ErrorMineDoc',
         'ErrorQueueDoc', 'QuestionGetDoc', 'QuestionsAllDoc'}
want = closure(v, seeds)
v2, chunks = extract_and_remove(v, want)
body = '\n\n'.join(b for b, _, _ in chunks)
self_names = defined(body)
imports = needed_type_imports(body, self_names, 'views/bank.ts')
head = ('/**\n * 题库域视图类型（C-3 错误卡 / 题目管理 / B2 回流 / 一键清理 / 勘误冲正；'
        '#152 刀 6 自 views.ts 归档）。\n */\n')
if imports:
    head += '\n'.join(imports) + '\n'
save('src/engine/views/bank.ts', head + '\n' + body + '\n')
v2 = v2.replace('// ---- 共享词汇 ----',
                '// ---- 共享词汇 ----\n\n// 题库域视图类型归档 views/bank.ts（#152 刀 6）：叶子文件——领主 question-bank\n'
                '// 直引它，不经本 barrel 牵进重模块（R7）。\nexport type {\n  %s,\n} from \'./views/bank.ts\'\n'
                % ', '.join(sorted(want)), 1)
save(vp, v2)
print('views/bank.ts:', len(chunks), 'blocks')

# ---------- 2) Graph*ProposalResult → views/proposals.ts ----------
pp = 'src/engine/proposals.ts'
p = load(pp)
g = closure(p, {'GraphEditProposalResult', 'GraphSeedProposalResult', 'GraphEnrichProposalResult', 'GraphProposeResult'})
p2, gchunks = extract_and_remove(p, g)
gbody = '\n\n'.join(b for b, _, _ in gchunks)
g_imports = needed_type_imports(gbody, defined(gbody), 'views/proposals.ts')
ghead = ('/**\n * 图提案受理结果类型（#142/#140 提案通道；#152 刀 6 自 views.ts/proposals.ts\n'
         ' * 归位为叶子视图文件——窄面直引它，不经 views barrel 环回提案域）。\n */\n')
if g_imports:
    ghead += '\n'.join(g_imports) + '\n'
save('src/engine/views/proposals.ts', ghead + '\n' + gbody + '\n')
save(pp, p2)
vp2 = load(vp)
if "from './proposals.ts'" in vp2:
    vp2 = vp2.replace("} from './proposals.ts'", "} from './views/proposals.ts'")
    save(vp, vp2)
    print('views re-export repointed')

# projects.ts 窄面改引叶子
pr = 'src/engine/projects.ts'
s = load(pr)
s = s.replace("import type { GraphProposeResult } from './proposals.ts'",
              "import type { GraphProposeResult } from './views/proposals.ts'")
save(pr, s)

# question-bank.ts 视图类型改引叶子
qb = 'src/engine/question-bank.ts'
s = load(qb)
s = s.replace("} from './views.ts'", "} from './views/bank.ts'")
save(qb, s)
print('views archive done')
