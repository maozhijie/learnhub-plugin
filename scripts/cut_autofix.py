# 刀手术自动修复：领主文件缺导入 / node:fs 导入不全 / 门面模块级 helper 归位
# 用法：python scripts/cut_autofix.py <领主文件> <类声明前缀> [门面文件=src/engine/index.ts]
import io, re, glob, os, sys

lord_path = sys.argv[1]
class_marker = sys.argv[2]
facade_path = sys.argv[3] if len(sys.argv) > 3 else 'src/engine/index.ts'

def load(p): return io.open(p, encoding='utf8').read()
def save(p, s): io.open(p, 'w', encoding='utf8', newline='\n').write(s)

# ---- 引擎导出表：名字 → (模块相对路径, 'type'|'value') ----
exports = {}
for f in sorted(glob.glob('src/engine/*.ts')) + sorted(glob.glob('src/engine/views/*.ts')):
    rel = './' + os.path.basename(f)
    if os.path.dirname(f).replace('\\', '/').endswith('views'):
        rel = './views/' + os.path.basename(f)
    src = load(f)
    for m in re.finditer(r'export (?:async )?(function|const|class|let|interface|type|abstract class) (\w+)', src):
        kind = 'type' if m.group(1) in ('interface', 'type') else 'value'
        exports.setdefault(m.group(2), (rel, kind))
    for m in re.finditer(r'export \{([^}]+)\}', src):
        for n in m.group(1).split(','):
            n = n.strip().replace('type ', '')
            if n:
                exports.setdefault(n, (rel, 'value'))

text = load(lord_path)
assert class_marker in text, class_marker
head, cls = text[:text.index(class_marker)], text[text.index(class_marker):]

def imported_names(h):
    out = set()
    for m in re.finditer(r'import (?:type )?\{([^}]+)\}', h):
        for n in m.group(1).split(','):
            n = n.strip().replace('type ', '')
            if n:
                out.add(n)
    return out

have = imported_names(head)
locals_ = set(re.findall(r'^\s{2}(?:private |protected )?(?:readonly )?(?:async )?\*?(\w+)\s*[(:=]', cls, re.M))
members = set(re.findall(r'this\.\w+\.(\w+)', cls))          # 窄面成员名，不算模块符号
# 展开运算符的省略号会挡住其后的标识符：扫描前先剥掉
used = set(re.findall(r'(?<![\w$])([A-Za-z_]\w{2,})(?![\w$])', cls.replace('...', '')))

missing = {}
alias_fix = []
for n in sorted(used):
    if n in have or n in members or n not in exports:
        continue
    if n in locals_:
        # 类方法与模块函数同名：别名导入并改写裸调用
        mod, kind = exports[n]
        if mod == './' + os.path.basename(lord_path):
            continue
        alias_fix.append((n, '%s$mod' % n, mod))
        continue
    mod, kind = exports[n]
    if mod == './' + os.path.basename(lord_path):
        continue
    missing.setdefault((mod, kind), []).append(n)
for _n, _alias, _mod in alias_fix:
    _def = re.compile(r'^\s*(?:private |public |protected |static )*(?:async )?\*?%s\s*\(' % re.escape(_n))
    _lines = []
    for _l in cls.split('\n'):
        if not _def.match(_l):
            _l = re.sub(r'(?<![\w.$])%s\s*\(' % re.escape(_n), '%s(' % _alias, _l)
        _lines.append(_l)
    cls = '\n'.join(_lines)
    head = head.rstrip('\n') + '\n' + ("import { %s as %s } from '%s'" % (_n, _alias, _mod)) + '\n'
    print('aliased same-name module fn:', _n)

if missing:
    lines = []
    for (mod, kind), ns in sorted(missing.items()):
        lines.append("import %s{ %s } from '%s'" % ('type ' if kind == 'type' else '', ', '.join(sorted(ns)), mod))
    head = head.rstrip('\n') + '\n' + '\n'.join(lines) + '\n'
    print('added imports:')
    for l in lines:
        print('  ' + l)

# ---- 门面模块级 helper（function NAME(...)）被类体引用 → 归位到领主文件 ----
facade = load(facade_path)
moved_helpers = []
for n in sorted(used):
    if n in have or n in locals_ or n in exports:
        continue
    m = re.search(r'^function %s\(' % re.escape(n), facade, re.M)
    if not m:
        continue
    a = m.start()
    # 连带紧邻 doc 注释
    pre = facade.rfind('\n\n', 0, a)
    a2 = pre + 2 if pre != -1 else a
    i = facade.index('{', facade.index(')', a))
    d, k = 0, i
    while True:
        if facade[k] == '{': d += 1
        elif facade[k] == '}':
            d -= 1
            if d == 0: break
        k += 1
    end = facade.index('\n', k) + 1
    moved_helpers.append(facade[a2:end].rstrip('\n'))
    facade = facade[:a2] + facade[end:]
    print('moved facade helper:', n)
if moved_helpers:
    save(facade_path, facade)
    cls = cls.rstrip('\n') + '\n\n// ---- 门面原模块级 helper（#152 随本域方法一并归位）----\n\n' + '\n\n'.join(moved_helpers) + '\n'

# ---- node 内置导入补齐 ----
need_fsp = {f for f in ['mkdir', 'readdir', 'readFile', 'writeFile', 'unlink', 'rename', 'stat', 'appendFile', 'copyFile', 'rm', 'rmdir', 'symlink', 'chmod']
            if re.search(r'(?<![\w.])%s\(' % f, cls)}
need_fs = {f for f in ['existsSync', 'readFileSync', 'writeFileSync', 'readdirSync']
           if re.search(r'(?<![\w.])%s\(' % f, cls)}

m = re.search(r"import \{([^}]+)\} from 'node:fs/promises'", head)
if m:
    have_fsp = {x.strip() for x in m.group(1).split(',')}
    all_fsp = sorted(have_fsp | need_fsp)
    head = head.replace(m.group(0), "import { %s } from 'node:fs/promises'" % ', '.join(all_fsp))
elif need_fsp:
    head = "import { %s } from 'node:fs/promises'\n" % ', '.join(sorted(need_fsp)) + head
m2 = re.search(r"import \{([^}]+)\} from 'node:fs'", head)
if m2:
    have_fs = {x.strip() for x in m2.group(1).split(',')}
    head = head.replace(m2.group(0), "import { %s } from 'node:fs'" % ', '.join(sorted(have_fs | need_fs)))
elif need_fs:
    head = "import { %s } from 'node:fs'\n" % ', '.join(sorted(need_fs)) + head

save(lord_path, head + cls)
print('autofix done:', lord_path)
