# 刀手术通用引擎：从门面按节抽方法 → 子系统类住领主文件 → 门面同签名转发。
# 用法：python scripts/cut.py scripts/cutN_spec.py
import io, re, sys, importlib.util

spec_path = sys.argv[1]
spec_mod = importlib.util.spec_from_file_location('cutspec', spec_path)
spec = importlib.util.module_from_spec(spec_mod)
spec_mod.loader.exec_module(spec)

IDX = 'src/engine/index.ts'
lines = io.open(IDX, encoding='utf8').read().split('\n')

def find(s, start=0):
    for i in range(start, len(lines)):
        if s in lines[i]:
            return i
    raise SystemExit('NOT FOUND: ' + s)

# ---- 1. 节区定位 ----
sections = []  # (tag, a, b)  a=节注释行, b=下节注释行
for tag, a_s, b_s in spec.sections:
    a, b = find(a_s), find(b_s)
    assert a < b, (tag, a, b)
    sections.append((tag, a, b))

# ---- 2. 方法块解析（字符级：参数闭括号 → 类型感知找方法体 '{' → 计数找配对 '}'）----
method_re = re.compile(r'^  (private )?(async )?\*?([A-Za-z_]\w*)\(')
blocks = []
for tag, a, b in sections:
    join = ''
    lineno = []
    for li in range(a, b):
        join += lines[li]
        lineno.extend([li] * len(lines[li]))
    join += '\n'
    lineno.append(b)
    li = 0
    while li < len(join):
        # 行首对齐 method_re：仅在各行的第 0 列尝试
        if lineno[li] != lineno[li - 1] if li else True:
            pass
        m = None
        if li == 0 or lineno[li] != lineno[li - 1]:
            line_text = join[li:join.find('\n', li)] if '\n' in join[li:] else join[li:]
            line_text = lines[lineno[li]]
            m = method_re.match(line_text)
        if not m:
            li += 1
            continue
        start_line = lineno[li]
        start_col = li
        # 1) 参数闭括号
        depth = 0
        ci = li
        close_ci = None
        in_str = None
        while ci < len(join):
            ch = join[ci]
            if in_str:
                if ch == in_str:
                    in_str = None
            elif ch in '\'"`':
                in_str = ch
            elif ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    close_ci = ci
                    break
            ci += 1
        assert close_ci is not None, lines[start_line]
        # 2) 返回类型区找方法体 '{'（尖/圆/花括号深度全 0 的 '{'）
        ang = par = brace = 0
        in_str = None
        body_ci = None
        cj = close_ci + 1  # 从闭括号之后起步，否则 ')' 被重复消费致 par=-1
        while cj < len(join):
            ch = join[cj]
            if in_str:
                if ch == in_str:
                    in_str = None
            elif ch in '\'"`':
                in_str = ch
            elif ch == '<':
                ang += 1
            elif ch == '>':
                if ang > 0:
                    ang -= 1
            elif ch == '(':
                par += 1
            elif ch == ')':
                par -= 1
            elif ch == '{':
                if ang == 0 and par == 0 and brace == 0:
                    body_ci = cj
                    break
                brace += 1
            elif ch == '}':
                brace -= 1
            cj += 1
        assert body_ci is not None, lines[start_line]
        # 3) 花括号计数找方法体 '}'
        d = 1
        ck = body_ci + 1
        end_ci = None
        while ck < len(join):
            ch = join[ck]
            if ch == '{':
                d += 1
            elif ch == '}':
                d -= 1
                if d == 0:
                    end_ci = ck
                    break
            ck += 1
        assert end_ci is not None, lines[start_line]
        body_open_line = lineno[body_ci]
        end_line = lineno[end_ci]
        assert lines[end_line].strip() == '}', (start_line, lines[end_line])
        sig = '\n'.join(lines[start_line:body_open_line + 1])
        body = lines[body_open_line + 1:end_line]
        blocks.append(dict(tag=tag, start=start_line, end=end_line, sig=sig,
                           private=bool(m.group(1)), is_async=bool(m.group(2)),
                           is_gen='*' in sig[:sig.index('(')],
                           name=m.group(3), body=body))
        li = ck + 1
        while li < len(join) and lineno[li] <= end_line:
            li += 1

names = [b['name'] for b in blocks]
assert len(names) == len(set(names)), '方法重名?'
print('moved methods:', len(names))
print('  ', ', '.join(names))

# ---- 3. 生成转发 ----
def split_top(s):
    out, cur, d, in_str = [], [], 0, None
    for i, ch in enumerate(s):
        if in_str:
            cur.append(ch)
            if ch == in_str:
                in_str = None
            continue
        prev = s[i-1] if i > 0 else ''
        if ch in '\'"`':
            in_str = ch
            cur.append(ch)
        elif ch in '([{':
            d += 1
            cur.append(ch)
        elif ch in ')]}':
            d -= 1
            cur.append(ch)
        elif ch == '<' and (prev.isalnum() or prev == '_'):
            d += 1  # 泛型开（Record<、Array<）
            cur.append(ch)
        elif ch == '>' and prev == '=':
            cur.append(ch)  # 箭头函数 => 的 '>'，不入泛型深度
        elif ch == '>' and d > 0:
            d -= 1  # 泛型闭（允许 '} >' 这类带空格的书写）
            cur.append(ch)
        elif ch == ',' and d == 0:
            out.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        out.append(''.join(cur))
    return out

def params_of(sig):
    d0 = sig.index('(')
    depth = 0
    inner = ''
    ret = ''
    for i, ch in enumerate(sig):
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                inner = sig[d0+1:i]
                ret_m = re.search(r'\)\s*:\s*(.+?)\s*\{\s*$', sig[i:], re.S)
                ret = ret_m.group(1).strip() if ret_m else ''
                break
    args = []
    for p in split_top(inner):
        p = p.strip()
        if not p:
            continue
        if p.startswith('{'):
            raise SystemExit('解构参数需手改: ' + p[:60])
        name_part = p.split('=')[0].split(':')[0].strip().lstrip('_').rstrip('?')
        if name_part.startswith('...'):
            name_part = '...' + name_part[3:].split(':')[0].strip()
        args.append(name_part)
    return args, ret

sec_ranges = [(a, b) for _, a, b in sections]
def used_outside(nm):
    pat = 'this.' + nm + '('
    cnt = 0
    for i, l in enumerate(lines):
        if any(a <= i < b for a, b in sec_ranges):
            continue
        if pat in l:
            cnt += 1
    return cnt

forwards = {}
for tag, a, b in sections:
    stubs = []
    for blk in blocks:
        if blk['tag'] != tag:
            continue
        args, ret = params_of(blk['sig'])
        if blk['private'] and used_outside(blk['name']) == 0:
            continue
        call = 'this.%s.%s(%s)' % (spec.field_name, blk['name'], ', '.join(a.strip() for a in args))
        if blk.get('is_gen'):
            body = '    yield* %s' % call
        elif ret == 'void':
            body = '    %s' % call
        elif ret == '' and blk['is_async']:
            # 原方法未标注返回类型（TS 推断）：return 兼容 void 与有值两种
            body = '    return %s' % call
        elif ret == '' or ret == 'Promise<void>':
            body = ('    await %s' % call) if blk['is_async'] else ('    %s' % call)
        else:
            body = '    return %s' % call
        one = blk['sig']
        stubs.append(one)
        stubs.append(body)
        stubs.append('  }')
        stubs.append('')
    forwards[tag] = '\n'.join(stubs).rstrip('\n')

# ---- 4. 类体：this.→this.e.（节内方法名保护：占位符不带 this. 前缀，长名优先）----
def transform(body_text):
    t = body_text
    for nm in sorted(names, key=len, reverse=True):
        t = t.replace('this.' + nm, '\x00' + nm)
    t = re.sub(r'\bthis\.', 'this.e.', t)
    return t.replace('\x00', 'this.')

class_chunks = []
blk_by_start = {blk['start']: blk for blk in blocks}
for tag, a, b in sections:
    chunk_lines = []
    i = a + 1
    while i < b:
        if i in blk_by_start:
            blk = blk_by_start[i]
            chunk_lines.append(blk['sig'])
            chunk_lines.extend(transform('\n'.join(blk['body'])).split('\n'))
            chunk_lines.append('  }')
            chunk_lines.append('')
            i = blk['end'] + 1
        else:
            chunk_lines.append(lines[i])
            i += 1
    class_chunks.append('\n'.join(chunk_lines).rstrip('\n'))

# ---- 5. 拼装领主文件 ----
lord = io.open(spec.lord_file, encoding='utf8').read().rstrip('\n')
lord += '\n' + spec.lord_header + '\n\n' + spec.deps_text + '\n\nexport class %s {\n  constructor(private e: %s) {}\n\n' % (spec.class_name, spec.deps_name)
lord += '\n'.join('// ---- 门面原分节：%s ----' % t for t, _, _ in sections) + '\n\n'
lord += '\n'.join(class_chunks) + '\n}\n'
for old, new in spec.lord_replaces:
    assert lord.count(old) >= 1, old[:60]
    lord = lord.replace(old, new, 1)
io.open(spec.lord_file, 'w', encoding='utf8', newline='\n').write(lord)

# ---- 6. 门面：节区替换为转发 ----
for tag, a, b in sorted(sections, key=lambda x: -x[1]):
    note = spec.fwd_notes.get(tag, '')
    head = lines[a].rstrip() + (('\n\n  // ' + note) if note else '')
    lines[a:b] = (head + '\n\n' + forwards[tag]).split('\n')
out = '\n'.join(lines)

for old, new in spec.facade_replaces:
    assert out.count(old) == 1, old[:80]
    out = out.replace(old, new)
io.open(IDX, 'w', encoding='utf8', newline='\n').write(out)
print('index.ts lines:', out.count('\n') + 1)
print('lord lines:', lord.count('\n') + 1)
