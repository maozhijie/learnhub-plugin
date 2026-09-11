# 通用视图归档：把 views.ts 中某域的视图类型搬进 views/<name>.ts 叶子文件
# 用法：python scripts/cut_views.py <域标识> <种子类型逗号串> [重指向文件:旧import片段]
#   例：python scripts/cut_views.py graph "GraphDoc,GraphNodeDoc" "src/engine/graph-subsystem.ts:} from './views.ts'"
import io, re, glob, os, sys

slug = sys.argv[1]
seeds = {s.strip() for s in sys.argv[2].split(',') if s.strip()}
repoints = []
for a in sys.argv[3:]:
    f, _, frag = a.partition(':')
    repoints.append((f, frag))

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

vp = 'src/engine/views.ts'
v = load(vp)
allnames = defined(v)
want = set(seeds)
changed = True
while changed:
    changed = False
    body = '\n'.join(block(v, n)[0] for n in sorted(want))
    used = set(re.findall(r'(?<![\w.$])([A-Z]\w{2,})(?![\w$])', body))
    extra = {u for u in used if u in allnames and u not in want}
    if extra:
        want |= extra
        changed = True

chunks = [block(v, n) for n in sorted(want)]
for b, a, e in sorted(chunks, key=lambda x: -x[1]):
    v = v[:a] + v[e + 1:]
reexp = ('// %s 域视图类型归档 views/%s.ts（#152）：叶子文件——领主直引它，'
         '不经本 barrel 牵进重模块（R7）。\nexport type {\n  %s,\n} from \'./views/%s.ts\'\n'
         % (slug, slug, ', '.join(sorted(want)), slug))
marker = '// ---- 共享词汇 ----'
if marker in v:
    v = v.replace(marker, marker + '\n\n' + reexp, 1)
else:
    v = reexp + '\n' + v
save(vp, v)

# 叶子文件：类型导入按需补（相对路径 ../）
exports = {}
for f in sorted(glob.glob('src/engine/*.ts')):
    src = load(f)
    for m in re.finditer(r'export (?:async )?(?:function|const|class|let|interface|type) (\w+)', src):
        exports.setdefault(m.group(1), './' + os.path.basename(f))
body = '\n\n'.join(b for b, _, _ in chunks)
self_names = defined(body)
used = set(re.findall(r'(?<![\w.$])([A-Z]\w{2,})(?![\w$])', body))
bym = {}
for n in sorted(used):
    if n in self_names or n in exports:
        if n in self_names or exports.get(n) == './views.ts':
            continue
        bym.setdefault(exports[n], []).append(n)
head = '/**\n * %s 域视图类型（#152 刀归档；叶子文件，只引类型层）。\n */\n' % slug
for mod, ns in sorted(bym.items()):
    head += "import type { %s } from '../%s'\n" % (', '.join(sorted(ns)), mod[2:])
save('src/engine/views/%s.ts' % slug, head + '\n' + body + '\n')

# 领主/窄面重指向
for f, frag in repoints:
    s = load(f)
    if frag and frag in s:
        s = s.replace(frag, "} from './views/%s.ts'" % slug)
        save(f, s)
        print('repointed:', f)
print('views/%s.ts: %d blocks: %s' % (slug, len(chunks), ', '.join(sorted(want))))
