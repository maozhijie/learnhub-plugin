/**
 * 架构门基线与棘轮（#165 / ADR-0047）：一份仓内基线记录每个受控量的实测值，
 * 门要求**实际 == 基线**——涨了失败，降了但未同步下调基线也失败（**过期即失败**）。
 *
 * 为什么是精确匹配而不是单侧棘轮：单侧棘轮（只拦上涨）的基线会沉淀成永久余量、
 * 逐条恒过，与 R3「收集器只收相对说明符致恒过」的教训同构。精确匹配是唯一不会
 * 腐烂的形状，代价只是每次清理顺手改一行。
 *
 * 基线自身也要自检（幽灵条目）：基线里的每一项都必须对应一个受控对象——
 * 删掉对象（子系统／文件）而留下基线条目 = 永不复活的门，一并失败。
 *
 * 受控量三族（形状即 `measureAll()` 的返回值）：`depsFace`（窄面三向／宽度 G3／G4）、
 * `sizes`（文件规模 G5）、`typeErrors`（类型门 G7，逐文件错误数；测量在 `scan-types.mjs`）。
 * **`measure()` 只取前两族（纯文本扫描，零子进程）**，`measureAll()` 再叠加必须跑 tsc 的
 * 类型门——这样 G3／G5 那几条文本门不会因为「同处一个基线模块」而被迫依赖 tsc。
 *
 * 用法：
 *   node scripts/arch-baseline.mjs            对照基线报告（全部受控量；违规即退出 1）
 *   node scripts/arch-baseline.mjs --types    只跑类型门对照（= npm run typecheck；只付一次 tsc）
 *   node scripts/arch-baseline.mjs --json     打印实测（全部受控量，不比较）
 *   node scripts/arch-baseline.mjs --update   用实测重写基线（**只在清理提交里用**；
 *                                             涨了就是不该涨，先想清楚再改）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanDepsFaces, faceSnapshot, faceViolations, FACE_SCALARS, FACE_SLOTS } from './scan-deps-face.mjs'
import { scanSizes } from './scan-budget.mjs'
import { scanTypes } from './scan-types.mjs'

export const BASELINE_FILE = 'scripts/arch-baseline.json'

/** 纯文本受控量（无子进程）。 */
export function measure(root = process.cwd()) {
  const depsFace = {}
  for (const f of scanDepsFaces(root)) depsFace[f.deps] = faceSnapshot(f)
  return { depsFace, sizes: scanSizes(root) }
}

/** 全部受控量（含类型门；要跑一次 tsc）。 */
export function measureAll(root = process.cwd()) {
  return { ...measure(root), typeErrors: scanTypes(root).counts }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 窄面三向／宽度（G3／G4）：精确匹配比较 depsFace 段（纯函数，自检可喂假样本）。
 * 四个「装配」方向（dead／missing／unwired／surplus）不进基线：它们必须是 0，由门直接卡。
 * 受控量清单从 `scan-deps-face.mjs` 派生（单一出处）：加一个受控量只改那里。
 */
export function depsFaceViolations(measuredFaces, baselineFaces) {
  const bad = []
  for (const name of Object.keys(baselineFaces)) {
    if (!(name in measuredFaces)) bad.push(`[幽灵条目] 基线的 ${name} 在仓库里已不存在（子系统改名/合并/删除后要同步删基线条目）`)
  }
  for (const name of Object.keys(measuredFaces)) {
    if (!(name in baselineFaces)) {
      bad.push(`[新受控对象] ${name} 不在基线里（新子系统要显式登记基线与宽度）`)
      continue
    }
    const now = measuredFaces[name]
    const was = baselineFaces[name]
    for (const key of FACE_SCALARS) {
      if (now[key] !== was[key]) bad.push(`[棘轮] ${name}.${key}: 基线 ${was[key]} → 实测 ${now[key]}`)
    }
    for (const slot of FACE_SLOTS) {
      if (now.slots?.[slot] !== was.slots?.[slot]) {
        bad.push(`[宽度棘轮] ${name}.${slot}: 基线 ${was.slots?.[slot]} → 实测 ${now.slots?.[slot]}`)
      }
    }
  }
  return bad
}

/** 文件规模（G5）：逐文件行数精确匹配（受控文件集合本身也受控）。纯函数。 */
export function sizeViolations(measuredSizes, baselineSizes) {
  const bad = []
  for (const file of Object.keys(baselineSizes)) {
    if (!(file in measuredSizes)) {
      bad.push(`[幽灵条目] 基线里的 ${file} 已不在受控面里（删了、改名了或被白名单收编）——受控面变了要同步删基线条目`)
    }
  }
  for (const file of Object.keys(measuredSizes)) {
    if (!(file in baselineSizes)) {
      bad.push(`[新受控文件] ${file}：${measuredSizes[file]} 行不在基线里（新文件要显式登记）`)
      continue
    }
    if (measuredSizes[file] !== baselineSizes[file]) {
      const d = measuredSizes[file] - baselineSizes[file]
      bad.push(`[规模棘轮] ${file}: 基线 ${baselineSizes[file]} → 实测 ${measuredSizes[file]}（${d > 0 ? '+' : ''}${d} 行）`
        + `\n    ${d > 0 ? '长了：先看这行长在哪、能不能不长；确实该长则同步基线' : '缩了：好——同一提交里把基线一并下调（过期即失败）'}`)
    }
  }
  return bad
}

/**
 * 四个「装配」方向（dead／missing／unwired／surplus）是**装配断裂**，不是可棘轮化的债：
 * 它们必须恒为 0，不进基线。判定与文案在 `scan-deps-face.mjs`（受控量的家）——门与那里的
 * CLI 共用同一处，免得两套清单各自漂；本模块只负责把它接进「全部受控量」的入口。
 * `surplus` 在 #171 把 30 条多余接线清到 0 后由棘轮转本档（ADR-0047「清理后转硬门 0」）。
 */
export { faceViolations } from './scan-deps-face.mjs'

/**
 * 类型门（G7）：逐文件错误数精确匹配（#170）。基线只记**有错的文件**——未列出的文件即 0 错，
 * 于是「某文件修好了却没同步下调基线条目」与幽灵条目同款失败（过期即失败）。纯函数。
 */
export function typeViolations(measuredCounts, baselineCounts) {
  const bad = []
  for (const file of Object.keys(baselineCounts)) {
    if (!(file in measuredCounts)) {
      bad.push(`[类型棘轮] ${file}: 基线 ${baselineCounts[file]} 处 → 实测 0 处`
        + '\n    修好了：同一提交里把这条基线条目删掉（过期即失败——留着就成永久余量）')
    }
  }
  for (const file of Object.keys(measuredCounts)) {
    if (!(file in baselineCounts)) {
      bad.push(`[类型门] ${file}: 实测 ${measuredCounts[file]} 处不在基线里（新错误必须当场修，或说明理由后同步基线）`)
      continue
    }
    if (measuredCounts[file] !== baselineCounts[file]) {
      const d = measuredCounts[file] - baselineCounts[file]
      bad.push(`[类型棘轮] ${file}: 基线 ${baselineCounts[file]} → 实测 ${measuredCounts[file]}（${d > 0 ? '+' : ''}${d} 处）`
        + `\n    ${d > 0 ? '多了：先看这处错误是不是这次改动引入的（类型门是唯一能一次性看见的地方）' : '少了：好——同一提交里把基线一并下调（过期即失败）'}`)
    }
  }
  return bad
}

/** 全部棘轮项（G3／G4／G5／G7 的并集）。 */
export function ratchetViolations(measured, baseline) {
  return [...depsFaceViolations(measured.depsFace ?? {}, baseline.depsFace ?? {}),
    ...sizeViolations(measured.sizes ?? {}, baseline.sizes ?? {}),
    ...typeViolations(measured.typeErrors ?? {}, baseline.typeErrors ?? {})]
}

/** 按受控量的形状渲染基线文本（排序稳定，diff 干净）。 */
export function renderBaseline(measured) {
  const depsFace = {}
  for (const name of Object.keys(measured.depsFace).sort()) depsFace[name] = measured.depsFace[name]
  const sizes = {}
  for (const file of Object.keys(measured.sizes).sort()) sizes[file] = measured.sizes[file]
  const typeErrors = {}
  for (const file of Object.keys(measured.typeErrors ?? {}).sort()) typeErrors[file] = measured.typeErrors[file]
  const body = {
    $comment: [
      '架构门基线（ADR-0047 棘轮：实际 == 基线；涨了失败、降了未同步下调也失败）。',
      '只在清理提交里改这一份；改的理由写在同一个提交里。重写：node scripts/arch-baseline.mjs --update',
      '四个装配方向（dead 声明未用 / missing 用而未声明 / unwired 声明未接线 / surplus 接线未声明）不进基线——它们必须是 0，由 tests/arch-guards.test.ts 直接卡。',
      'typeErrors 只记有错的文件（未列出即 0 处）；tsc 版本换档（typescript/@types/node 均精确锁版本）会整体重排，故换档必须与基线同提交。',
    ],
    depsFace,
    sizes,
    typeErrors,
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

export function readBaseline(path = BASELINE_FILE) {
  return readJson(path)
}

/** 完整检查：实测 vs 基线（含门自己的「四个装配方向必须为 0」）。 */
export function checkBaseline(root = process.cwd(), baseline = readBaseline(join(root, BASELINE_FILE))) {
  const faces = scanDepsFaces(root)
  const depsFace = {}
  for (const f of faces) depsFace[f.deps] = faceSnapshot(f)
  return [
    ...faceViolations(faces),
    ...depsFaceViolations(depsFace, baseline.depsFace ?? {}),
    ...sizeViolations(scanSizes(root), baseline.sizes ?? {}),
    ...typeViolations(scanTypes(root).counts, baseline.typeErrors ?? {}),
  ]
}

if (process.argv[1] && process.argv[1].includes('arch-baseline')) {
  const root = process.cwd()
  const baseline = readBaseline(join(root, BASELINE_FILE))
  if (process.argv.includes('--types')) {
    // 只跑类型门：不付 depsFace／sizes 的扫描（= npm run typecheck）
    const counts = scanTypes(root).counts
    const typeShape = `（${Object.values(counts).reduce((s, n) => s + n, 0)} 处 / ${Object.keys(counts).length} 个涉错文件）`
    const bad = typeViolations(counts, baseline.typeErrors ?? {})
    if (bad.length) {
      console.error(`✗ 类型门不符基线${typeShape}：\n${bad.map(b => `  · ${b}`).join('\n')}`)
      process.exitCode = 1
    } else {
      console.log(`✓ 类型门一致${typeShape}`)
    }
  } else {
    const measured = measureAll(root)
    const shape = `${Object.keys(measured.depsFace).length} 个子系统 / ${Object.keys(measured.sizes).length} 个受控文件 / ${Object.values(measured.typeErrors).reduce((s, n) => s + n, 0)} 处类型错（${Object.keys(measured.typeErrors).length} 个涉错文件）`
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(measured, null, 2))
    } else if (process.argv.includes('--update')) {
      writeFileSync(join(root, BASELINE_FILE), renderBaseline(measured))
      console.log(`✓ 已按实测重写 ${BASELINE_FILE}（${shape}）`)
    } else {
      const bad = checkBaseline(root, baseline)
      if (bad.length) {
        console.error(`✗ 架构门基线不符（${bad.length} 条）：\n${bad.map(b => `  · ${b}`).join('\n')}`)
        process.exitCode = 1
      } else {
        console.log(`✓ 架构门基线一致（${shape}）`)
      }
    }
  }
}
