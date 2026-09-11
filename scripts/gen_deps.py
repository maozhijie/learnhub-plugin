# 从门面方法签名自动生成子系统的窄面成员与构造接线块
# 用法：python scripts/gen_deps.py <门面文件> <方法名逗号串> [字段名,字段名...]
#   - 方法名 → 生成 `NAME(args): Ret` 成员 + `NAME: (args) => this.NAME(args)` 接线
#   - 字段名 → 生成 `NAME: Type` 成员 + `NAME: this.NAME` 接线（类型从门面声明抄）
import io, re, sys

facade_path = sys.argv[1]
names = [n.strip() for n in sys.argv[2].split(',') if n.strip()]
fields = [n.strip() for n in sys.argv[3].split(',') if n.strip()] if len(sys.argv) > 3 else []
spec_path = sys.argv[4] if len(sys.argv) > 4 else None
deps_name = sys.argv[5] if len(sys.argv) > 5 else 'XDeps'
field_name = sys.argv[6] if len(sys.argv) > 6 else 'x'

text = io.open(facade_path, encoding='utf8').read()
lines = text.split('\n')

def parse_decl(name):
    """返回 (params_text, ret_text) —— 从门面类方法声明抄。"""
    pat = re.compile(r'^  (?:private |public |protected |static )*(?:async )?\*?%s\s*\(' % re.escape(name))
    for i, l in enumerate(lines):
        if not pat.match(l):
            continue
        # 参数括号配对
        start = text.index('(', text.index(l[:0] or '', 0))  # noop
        col = l.index('(')
        depth, j, k = 0, i, col
        while j < len(lines):
            line = lines[j]
            start_col = k if j == i else 0
            for c in range(start_col, len(line)):
                ch = line[c]
                if ch == '(':
                    depth += 1
                elif ch == ')':
                    depth -= 1
                    if depth == 0:
                        # 参数文本
                        if j == i:
                            params = line[col + 1:c]
                        else:
                            params = '\n'.join([lines[i][col + 1:]] + lines[i + 1:j] + [line[:c]])
                        # 返回类型
                        rest = line[c + 1:]
                        m = re.match(r'\s*:\s*(.*?)\s*\{\s*$', rest)
                        if m:
                            ret = m.group(1)
                        else:
                            # 跨行返回类型
                            ret = ''
                            for t in range(j, min(j + 12, len(lines))):
                                seg = lines[t] if t > j else rest
                                mm = re.search(r'\s*:\s*(.*?)\s*\{\s*$', seg)
                                if mm:
                                    ret = '\n'.join([lines[x] for x in range(j, x)] ) if False else mm.group(1)
                                    # 多行返回类型：拼中间行
                                    if t > j:
                                        ret = '\n'.join(lines[j + 1:t] + [mm.group(1)]).strip()
                                    break
                        return params, ret
            j += 1
        break
    return None, None

def arg_names(params):
    out, cur, d, instr = [], [], 0, None
    for i, ch in enumerate(params):
        if instr:
            cur.append(ch)
            if ch == instr:
                instr = None
            continue
        prev = params[i - 1] if i else ''
        if ch in '\'"`':
            instr = ch
            cur.append(ch)
        elif ch in '([{':
            d += 1
        elif ch in ')]}':
            d -= 1
        elif ch == '<' and (prev.isalnum() or prev == '_'):
            d += 1
        elif ch == '>' and prev != '=' and d > 0:
            d -= 1
        elif ch == ',' and d == 0:
            out.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        out.append(''.join(cur))
    names_, rest = [], []
    for p in out:
        p = p.strip()
        if not p:
            continue
        nm = p.split('=')[0].split(':')[0].strip().lstrip('_').rstrip('?')
        if nm.startswith('{'):
            raise SystemExit('解构参数需手改: ' + p[:60])
        names_.append(nm)
        if '=' in p:
            rest.append(p.split('=', 1)[1].strip())
    return names_

deps_lines, wire_lines = [], []
for n in names:
    params, ret = parse_decl(n)
    if params is None:
        print('// 未找到门面声明（跳过）：%s' % n)
        continue
    args = arg_names(params)
    deps_lines.append('  %s(%s): %s' % (n, params.strip(), ret))
    wire_lines.append('      %s: (%s) => this.%s(%s),' % (n, ', '.join(args), n, ', '.join(args)))

for f in fields:
    m = re.search(r'^  (?:readonly )?%s\s*:\s*(.+)$' % re.escape(f), text, re.M)
    ty = m.group(1).strip() if m else 'unknown'
    deps_lines.append('  %s: %s' % (f, ty))
    wire_lines.append('      %s: this.%s,' % (f, f))

out = 'export interface %s {\n%s\n}\n\n// ---- 构造接线 ----\n%s\n' % (
    deps_name, '\n'.join(deps_lines), '\n'.join(['    this.%s = new XSubsystem({' % field_name] + wire_lines + ['    })']))
print(out)
if spec_path:
    io.open(spec_path, 'w', encoding='utf8', newline='\n').write(out)
    print('written:', spec_path)
