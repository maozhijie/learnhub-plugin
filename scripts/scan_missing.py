import io, re, glob, os

t = io.open('src/engine/question-bank.ts', encoding='utf8').read()
cls = t[t.index('export class BankSubsystem'):]
head = t[:t.index('export class BankSubsystem')]
have = set()
for m in re.finditer(r"import (?:type )?\{([^}]+)\}", head):
    for n in m.group(1).split(','):
        n = n.strip().replace('type ', '')
        if n:
            have.add(n)
local = set(re.findall(r'^\s{2}(?:private |protected )?(?:async )?\*?(\w+)\(', cls, re.M))
used = set(re.findall(r'(?<![\w.$])([A-Za-z_]\w{2,})(?![\w$])', cls))

exports = {}
for f in glob.glob('src/engine/*.ts'):
    src = io.open(f, encoding='utf8').read()
    for m in re.finditer(r'export (?:async )?(?:function|const|class|let|interface|type) (\w+)', src):
        exports.setdefault(m.group(1), []).append(os.path.basename(f))

bym = {}
for n in sorted(used):
    if n in have or n in local or n not in exports:
        continue
    bym.setdefault(exports[n][0], []).append(n)
print('未导入的引擎符号：')
for m, ns in sorted(bym.items()):
    print('  %s: %s' % (m, ', '.join(ns)))
