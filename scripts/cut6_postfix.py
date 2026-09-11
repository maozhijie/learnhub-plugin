# 刀 6 后置修正：门面模块级 helper 归位 + 缺失导入补齐（在 cut.py 之后运行）
import io

def load(p): return io.open(p, encoding='utf8').read()
def save(p, s): io.open(p, 'w', encoding='utf8', newline='\n').write(s)

def find_block(text, sig):
    """签名所在行到配对闭括号行（含）的完整块文本。"""
    a = text.index(sig)
    line_start = text.rfind('\n', 0, a) + 1
    i = text.index('{', text.index(')', a))
    d, k = 0, i
    while True:
        if text[k] == '{': d += 1
        elif text[k] == '}':
            d -= 1
            if d == 0: break
        k += 1
    end = text.index('\n', k) + 1
    return text[line_start:end], line_start, end

# ---------- 1) 门面两个模块级 helper → question-bank.ts ----------
idx = 'src/engine/index.ts'
s = load(idx)
f1, a1, b1 = find_block(s, 'function sectionMdOf(')
f2, a2, b2 = find_block(s, 'function misconceptionPromptBlock(')
# 各自连带前置 doc 注释（若紧邻）
def with_doc(text, a):
    head = text.rfind('\n\n', 0, a)
    return a if head == -1 else head + 2
a1d = with_doc(s, a1)
a2d = with_doc(s, a2)
p1 = s[a1d:b1]
p2 = s[a2d:b2]
for a, b in sorted([(a1d, b1), (a2d, b2)], key=lambda x: -x[0]):
    s = s[:a] + s[b:]
save(idx, s)

qb = 'src/engine/question-bank.ts'
t = load(qb)
t = t.rstrip('\n') + '\n\n// ---- 门面原模块级 helper（#152 刀 6 随 bank 域方法一并归位）----\n\n' + p1.rstrip('\n') + '\n\n' + p2.rstrip('\n') + '\n'
# rename 补入 fs/promises 导入
t = t.replace("from 'node:fs/promises'", "from 'node:fs/promises'", 1)
save(qb, t)

# ---------- 2) srs.ts 补 STAGES ----------
sp = 'src/engine/srs.ts'
ss = load(sp)
if "import { STAGES }" not in ss:
    ss = ss.replace("import type { FsrsBlock, Fm } from './types.ts'",
                    "import type { FsrsBlock, Fm } from './types.ts'\nimport { STAGES } from './types.ts'", 1)
save(sp, ss)

# ---------- 2b) effectiveStage: audit.ts → srs.ts ----------
ap = 'src/engine/audit.ts'
as_ = load(ap)
fn, fa, fb = find_block(as_, 'export function effectiveStage(')
as_ = as_[:fa] + "export { effectiveStage } from './srs.ts'\n" + as_[fb:]
save(ap, as_)
ss = load(sp).rstrip('\n')
ss += ('\n\n// 节点阶段判定（#152 刀 6 自 audit.ts 归位：题库域消费它，经 audit 会绕进\n'
       '// vault-links→note-source 的低层链成环）。\n') + fn.rstrip('\n') + '\n'
save(sp, ss)

# ---------- 3) question-bank.ts 的 node:fs 导入按类体实际用到的函数补齐 ----------
t = load(qb)
import re as _re2
_cls = t[t.index('export class BankSubsystem'):]
_need_fsp = {f for f in ['mkdir', 'readdir', 'readFile', 'writeFile', 'unlink', 'rename', 'stat', 'appendFile', 'copyFile', 'rm']
             if _re2.search(r'(?<![\w.])%s\(' % f, _cls)}
_need_fs = {f for f in ['existsSync'] if _re2.search(r'(?<![\w.])%s\(' % f, _cls)}
_m = _re2.search(r"import \{([^}]+)\} from 'node:fs/promises'", t)
if _m:
    _have = {n.strip() for n in _m.group(1).split(',')}
    _all = sorted(_have | _need_fsp)
    t = t.replace(_m.group(0), "import { %s } from 'node:fs/promises'" % ', '.join(_all))
elif _need_fsp:
    t = ("import { %s } from 'node:fs/promises'\n" % ', '.join(sorted(_need_fsp))) + t
_m2 = _re2.search(r"import \{([^}]+)\} from 'node:fs'", t)
if _need_fs and not _m2:
    t = ("import { %s } from 'node:fs'\n" % ', '.join(sorted(_need_fs))) + t
save(qb, t)
print('fs imports:', ', '.join(sorted(_need_fsp)))
print('postfix6 done')

# ---------- 5) 断回边：NOTE_SOURCE_COURSE → types.ts；sessions.effectiveStage ← srs ----------
tp = 'src/engine/types.ts'
t = load(tp)
if 'NOTE_SOURCE_COURSE' not in t:
    t = t.rstrip('\n') + """

/** 笔记源伪课程名（C1 #59；#152 刀 6 自 note-source.ts 归位中立层——题库域消费它，
 * 经 note-source 会与该域的低层消费者合拢成环）。 */
export const NOTE_SOURCE_COURSE = '笔记源'
"""
    save(tp, t)

nsp = 'src/engine/note-source.ts'
ns = load(nsp)
old = "export const NOTE_SOURCE_COURSE = '笔记源'"
if ns.count(old) == 1:
    ns = ns.replace(old, "// NOTE_SOURCE_COURSE 住 types.ts（中立层，#152 刀 6）；原路径 re-export。\nexport { NOTE_SOURCE_COURSE } from './types.ts'\nimport { NOTE_SOURCE_COURSE } from './types.ts'")
    save(nsp, ns)

qbp = 'src/engine/question-bank.ts'
qb = load(qbp)
qb = qb.replace("import { NOTE_SOURCE_COURSE } from './note-source.ts'\n", '')
if 'NOTE_SOURCE_COURSE' in qb and "import { NOTE_SOURCE_COURSE }" not in qb:
    qb = qb.replace("import type { EncEdge", "import { NOTE_SOURCE_COURSE } from './types.ts'\nimport type { EncEdge", 1)
    save(qbp, qb)

ssp = 'src/engine/sessions.ts'
ss = load(ssp)
if "import { effectiveStage } from './audit.ts'" in ss:
    ss = ss.replace("import { effectiveStage } from './audit.ts'", "import { effectiveStage } from './srs.ts'")
    save(ssp, ss)
print('edge cuts done')
