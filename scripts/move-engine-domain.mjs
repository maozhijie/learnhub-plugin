/**
 * engine 按域归组施工器（#305 / ADR-0093 T1 刀①–④；可复用到刀⑤–⑧）。
 *
 * 一刀 = 把一域文件 `git mv` 进 `src/engine/<域>/` + 全仓机械改写指向它们的相对
 * import specifier。**纯搬移、零逻辑改动**：不动文件名、不动导出面、不动门面
 * `engine/index.ts` 的唯一汇点地位。
 *
 * 改写口径（两向，缺一不可）：
 *   ① 未搬移的文件 → 指向被搬文件的 specifier 改路径；
 *   ② 被搬移的文件 → **全部**相对 specifier 重算（基准目录变了），
 *      既包括指向同域兄弟的（结果不变，如 `./registry.ts`），也包括指向留在
 *      顶层的（变 `../paths.ts`）。
 * 只按「被搬目标」改会漏掉 ② 里指向未搬文件的那一半——那是搬移后运行期
 * ERR_MODULE_NOT_FOUND 的直接来源。
 *
 * 扩展名形态**照抄原样**（`.ts` 保 `.ts`、无扩展名保无扩展名）：仓内两种写法并存
 * （src/tests/scripts 用 `.ts`，ui/ 走 bundler 解析用无扩展名），保留原形态是零
 * 意外的最小 diff。
 *
 * 覆盖的 specifier 形态与 `tests/import-rules.test.ts::allSpecs` 同源（静态 /
 * `export … from` / 侧效 / 动态 `import()`），因为 R1–R7 就是按那套形态执法的。
 *
 * 用法：
 *   node scripts/move-engine-domain.mjs <域> <文件1,文件2,…> [--dry-run]
 *   node scripts/move-engine-domain.mjs vault note-source,notes,vault-links,vault-prior,anki,registry
 *
 * 文件清单以 ADR-0093 映射表为唯一权威，本脚本不内嵌表（避免与 ADR 漂移）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** 改写面：全部可能持有 engine 相对 specifier 的源码根。 */
const SOURCE_ROOTS = ['src', 'tests', 'scripts', 'ui/src']
const SOURCE_EXT = /\.(ts|tsx|mts|mjs)$/
const SKIP_DIRS = new Set(['node_modules', 'lib', 'web', 'dist', '.git'])
const FILE_EXT = /\.(ts|tsx|js|jsx|mts|mjs)$/
const toPosix = p => p.split('\\').join('/')

/** 与 import-rules.test.ts::allSpecs 同源的三种形态；`d` 取捕获组偏移，好原地替换。 */
const SPEC_PATTERNS = [
  /from\s*(['"])([^'"]+)\1/dg,
  /^\s*import\s*(['"])([^'"]+)\1/dgm,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/dg,
]

/**
 * 相对 specifier 解析（带 `.ts` 直用 → 补扩展名 → 目录 index 的兜底，与
 * import-rules.test.ts::resolveSpec 同款）。非相对项返回 null。
 */
function resolveSpec(importerAbs, spec) {
  if (!spec.startsWith('.')) return null
  const abs = resolve(dirname(importerAbs), spec)
  for (const cand of [abs, `${abs}.ts`, `${abs}.tsx`, join(abs, 'index.ts'), join(abs, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

/** 收集全部相对 specifier 及其在原文中的 [start, end) 偏移（按出现顺序）。 */
function collectSpecs(code) {
  const found = []
  for (const re of SPEC_PATTERNS) {
    for (const m of code.matchAll(re)) {
      const [start, end] = m.indices[2]
      found.push({ start, end, spec: m[2] })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * 一个文件里应改的 specifier：`oldAbs`/`newAbs` 是该文件搬移前后的绝对路径（未搬则相等）。
 * `movedTarget` 把「搬移前的绝对路径」映射到「搬移后的绝对路径」，未搬文件返回原值。
 * 返回 [{start, end, from, to}]，按偏移降序（好从尾部往前原地替换）。
 */
function planRewrite(code, oldAbs, newAbs, movedTarget) {
  const edits = []
  for (const { start, end, spec } of collectSpecs(code)) {
    const resolved = resolveSpec(oldAbs, spec)
    if (!resolved) continue
    const targetNow = movedTarget(resolved)
    if (targetNow === resolved && oldAbs === newAbs) continue
    const rel = toPosix(relative(dirname(newAbs), targetNow))
    const dotRel = rel.startsWith('.') ? rel : `./${rel}`
    const oldExt = spec.match(FILE_EXT)
    // 目标恒为 .ts（本仓被搬文件全是 .ts），按原 spec 的扩展名形态还原。
    const next = oldExt ? dotRel.replace(/\.ts$/, oldExt[0]) : dotRel.replace(FILE_EXT, '')
    if (next !== spec) edits.push({ start, end, from: spec, to: next })
  }
  return edits.sort((a, b) => b.start - a.start)
}

function walkSources(root) {
  const out = []
  if (!existsSync(root)) return out // 缺根不是错误：改写面按仓现状取，缺席的根贡献空集
  const walk = abs => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(abs, e.name))
      } else if (SOURCE_EXT.test(e.name)) out.push(join(abs, e.name))
    }
  }
  walk(root)
  return out
}

function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const positional = argv.filter(a => a !== '--dry-run')
  const [domain, fileList] = positional
  if (!domain || !fileList) {
    console.error('用法：node scripts/move-engine-domain.mjs <域> <文件1,文件2,…> [--dry-run]')
    process.exitCode = 2
    return
  }
  const names = fileList.split(',').map(s => s.trim()).filter(Boolean)
  const engineDir = resolve('src/engine')
  const targetDir = join(engineDir, domain)
  const root = process.cwd()

  const moves = names.map(name => ({
    name,
    from: join(engineDir, `${name}.ts`),
    to: join(targetDir, `${name}.ts`),
  }))
  const problems = []
  for (const m of moves) {
    if (!existsSync(m.from)) problems.push(`源不存在：src/engine/${m.name}.ts`)
    if (existsSync(m.to)) problems.push(`目标已存在（拒绝覆盖）：src/engine/${domain}/${m.name}.ts`)
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`)
    process.exitCode = 1
    return
  }

  const moveMap = new Map(moves.map(m => [m.from, m.to]))
  const movedTarget = abs => moveMap.get(abs) ?? abs

  // 全部待检查的 importer（搬移前的路径是权威：解析基准取它）。
  const importers = SOURCE_ROOTS.flatMap(r => walkSources(join(root, r))).map(abs => ({
    oldAbs: abs,
    newAbs: moveMap.get(abs) ?? abs,
  }))

  const planned = []
  for (const imp of importers) {
    const readAbs = existsSync(imp.newAbs) ? imp.newAbs : imp.oldAbs
    const code = readFileSync(readAbs, 'utf8')
    const edits = planRewrite(code, imp.oldAbs, imp.newAbs, movedTarget)
    if (edits.length) planned.push({ ...imp, readAbs, edits })
  }

  const fileCount = planned.length
  const editCount = planned.reduce((n, p) => n + p.edits.length, 0)
  console.log(`域 ${domain}：搬 ${moves.length} 件，改写 ${fileCount} 个文件 / ${editCount} 条 specifier`)
  for (const p of planned) {
    for (const e of p.edits) console.log(`  ${toPosix(relative(root, p.newAbs))}  ${e.from} → ${e.to}`)
  }
  if (dryRun) {
    console.log('（--dry-run：未落盘）')
    return
  }

  for (const m of moves) {
    mkdirSync(targetDir, { recursive: true }) // git mv 不建中间目录
    execFileSync('git', ['mv', toPosix(relative(root, m.from)), toPosix(relative(root, m.to))],
      { stdio: 'inherit' })
  }
  for (const p of planned) {
    // 搬移已发生：被搬文件的正文现在只在 newAbs，读它、写回它。
    let code = readFileSync(p.newAbs, 'utf8')
    for (const e of p.edits) code = code.slice(0, e.start) + e.to + code.slice(e.end)
    writeFileSync(p.newAbs, code, 'utf8')
  }
  console.log(`✓ 搬移与改写完成（${moves.length} 件 / ${editCount} 条）；接着跑全量门`)
  // 收尾只断言「搬移落地」，**不断言「改写正确」**——后者由 `npm test` 全量门执法
  // （R1–R7 的说明符解析 + tsc）。脚本自己给不出这份证据：路径键控的登记面
  //（`REPAIR_MECHANISMS[].file`／`引擎:` 出处／`scan-*.mjs` 常量／`arch-baseline.json`
  // 的 sizes 键）看不见 specifier，specifier 正确也不代表它们对。
  const missing = moves.filter(m => !existsSync(m.to)).map(m => toPosix(relative(root, m.to)))
  if (missing.length) {
    for (const f of missing) console.error(`✗ 搬移后目标缺失：${f}`)
    process.exitCode = 1
    return
  }
  console.log(`✓ ${moves.length} 件目标全部在位（改写正确性请以全量门为准）`)
}

if (process.argv[1] && process.argv[1].includes('move-engine-domain')) main()
