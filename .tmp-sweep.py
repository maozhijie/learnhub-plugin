import io, re, glob

# 全局机械转换：调用形态 → 端口形态（裸 fs. 前缀）；node:fs 导入删除；补 VaultFs 类型导入。
# 作用域前缀（this.fs / this.e.fs / 参数 fs）随后按 tsc 报错逐文件落。

FILES = [f for f in glob.glob('src/engine/**/*.ts', recursive=True) if not f.endswith('io.ts')]

IMPORT_FS_RE = re.compile(r"^import \{[^}]*\} from 'node:fs(?:/promises)?'\n", re.M)
IMPORT_NODEFS_TYPE = re.compile(r"^import type \{[^}]*\} from 'node:fs(?:/promises)?'\n", re.M)

for p in FILES:
    s = io.open(p, encoding='utf8').read()
    orig = s
    had_fs_import = bool(IMPORT_FS_RE.search(s))
    s = IMPORT_FS_RE.sub('', s)
    s = IMPORT_NODEFS_TYPE.sub('', s)

    # 带 withFileTypes 的 readdir 先转 readdirTypes（在通名替换前）
    s = re.sub(r"await readdir\(([^,()]+), \{ withFileTypes: true \}\)", r"await fs.readdirTypes(\1)", s)
    s = re.sub(r"readdir\(([^,()]+), \{ withFileTypes: true \}\)", r"fs.readdirTypes(\1)", s)

    # 选项/编码剥离（在加前缀之前，对裸形态生效）
    s = re.sub(r"\bexistsSync\(", 'fs.exists(', s)
    s = re.sub(r"\breadFileSync\(([^,()]+(?:\([^()]*\))?), 'utf8'\)", r"fs.readFileSync(\1)", s)
    s = re.sub(r"\breadFileSync\(", 'fs.readFileSync(', s)
    s = re.sub(r"await mkdir\(([^,()]+(?:\([^()]*\))?), \{ recursive: true \}\)", r"await fs.mkdir(\1)", s)
    s = re.sub(r"(?<![\w.])mkdir\(([^,()]+(?:\([^()]*\))?), \{ recursive: true \}\)", r"fs.mkdir(\1)", s)
    s = re.sub(r"await mkdir\(", 'await fs.mkdir(', s)
    s = re.sub(r"(?<![\w.])mkdir\(", 'fs.mkdir(', s)
    s = re.sub(r"await appendFile\(([^,]+), (.+?), 'utf8'\)", r"await fs.appendFile(\1, \2)", s)
    s = re.sub(r"await appendFile\(", 'await fs.appendFile(', s)
    s = re.sub(r"await writeFile\(([^,]+), (.+?), 'utf8'\)", r"await fs.writeFile(\1, \2)", s)
    s = re.sub(r"await writeFile\(", 'await fs.writeFile(', s)
    s = re.sub(r"await rename\(", 'await fs.rename(', s)
    s = re.sub(r"await unlink\(", 'await fs.unlink(', s)
    s = re.sub(r"await stat\(", 'await fs.statIsFile(', s)
    s = re.sub(r"await readFile\(([^,()]+(?:\([^()]*\))?), 'utf8'\)", r"await fs.readFile(\1)", s)
    s = re.sub(r"await readFile\(", 'await fs.readFile(', s)
    s = re.sub(r"(?<![\w.])readdir\(", 'fs.readdir(', s)
    s = re.sub(r"(?<![\w.])stat\(absPath\)", 'fs.statIsFile(absPath)', s)

    if had_fs_import and "from './io.ts'" in s is False:
        pass
    if ('fs.' in s) and ("import type { VaultFs }" not in s):
        # 在第一条相对导入前插 VaultFs 类型导入（views/ 子目录深度不同）
        depth = '../io.ts' if '/views/' in p.replace('\\\\', '/') else './io.ts'
        imp = f"import type {{ VaultFs }} from '{depth}'\n"
        m = re.search(r"^import ", s, re.M)
        s = s[:m.start()] + imp + s[m.start():]
    if s != orig:
        io.open(p, 'w', encoding='utf8', newline='\n').write(s)
        print('swept', p)
