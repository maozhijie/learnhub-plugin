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
 * 用法：
 *   node scripts/arch-baseline.mjs            对照基线报告（违规即退出 1）
 *   node scripts/arch-baseline.mjs --json     打印实测（不比较）
 *   node scripts/arch-baseline.mjs --update   用实测重写基线（**只在清理提交里用**；
 *                                             涨了就是不该涨，先想清楚再改）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanDepsFaces, faceSnapshot, FACE_SCALARS, FACE_SLOTS, FACE_LISTS } from './scan-deps-face.mjs'
import { scanSizes } from './scan-budget.mjs'

export const BASELINE_FILE = 'scripts/arch-baseline.json'

/** 实测的受控量（基线的形状就是它的形状）。 */
export function measure(root = process.cwd()) {
  const depsFace = {}
  for (const f of scanDepsFaces(root)) depsFace[f.deps] = faceSnapshot(f)
  return { depsFace, sizes: scanSizes(root) }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * 窄面三向／宽度（G3／G4）：精确匹配比较 depsFace 段（纯函数，自检可喂假样本）。
 * 三个「缺件」方向（dead／missing／unwired）不进基线：它们必须是 0，由门直接卡。
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
    for (const key of FACE_LISTS) {
      if (sameList(now[key] ?? [], was[key] ?? [])) continue
      const gone = (was[key] ?? []).filter(x => !(now[key] ?? []).includes(x))
      const added = (now[key] ?? []).filter(x => !(was[key] ?? []).includes(x))
      const delta = [
        gone.length ? `已清 ${gone.length} 条（${gone.join(', ')}）` : '',
        added.length ? `新增 ${added.length} 条（${added.join(', ')}）` : '',
      ].filter(Boolean).join('；')
      const hint = key === 'surplus'
        ? '\n    清掉多余接线是好事——同一提交里把基线一并下调（过期即失败）'
        : '\n    phantom＝门面上不存在的接线（真缺陷，清理优先）'
      bad.push(`[棘轮] ${name}.${key}: 基线 ${(was[key] ?? []).length} 条 → 实测 ${(now[key] ?? []).length} 条${delta ? `（${delta}）` : ''}${hint}`)
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
 * 三个「缺件」方向（dead／missing／unwired）是**装配断裂**，不是可棘轮化的债：
 * 它们必须恒为 0，不进基线。门与 CLI 共用这一处判定。
 */
export function missingDirectionViolations(faces) {
  const bad = []
  for (const f of faces) {
    if (f.dead.length) bad.push(`[硬门] ${f.deps} dead（声明未用）: ${f.dead.join(', ')}`)
    if (f.missing.length) bad.push(`[硬门] ${f.deps} missing（用而未声明）: ${f.missing.join(', ')}`)
    if (f.unwired.length) bad.push(`[硬门] ${f.deps} unwired（声明未接线）: ${f.unwired.join(', ')}`)
  }
  return bad
}

/** 全部棘轮项（G3／G4／G5 的并集）。 */
export function ratchetViolations(measured, baseline) {
  return [...depsFaceViolations(measured.depsFace ?? {}, baseline.depsFace ?? {}),
    ...sizeViolations(measured.sizes ?? {}, baseline.sizes ?? {})]
}

/** 按受控量的形状渲染基线文本（排序稳定，diff 干净）。 */
export function renderBaseline(measured) {
  const depsFace = {}
  for (const name of Object.keys(measured.depsFace).sort()) depsFace[name] = measured.depsFace[name]
  const sizes = {}
  for (const file of Object.keys(measured.sizes).sort()) sizes[file] = measured.sizes[file]
  const body = {
    $comment: [
      '架构门基线（ADR-0047 棘轮：实际 == 基线；涨了失败、降了未同步下调也失败）。',
      '只在清理提交里改这一份；改的理由写在同一个提交里。重写：node scripts/arch-baseline.mjs --update',
      '三个缺件方向（dead 声明未用 / missing 用而未声明 / unwired 声明未接线）不进基线——它们必须是 0，由 tests/arch-guards.test.ts 直接卡。',
    ],
    depsFace,
    sizes,
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

export function readBaseline(path = BASELINE_FILE) {
  return readJson(path)
}

/** 完整检查：实测 vs 基线（含门自己的「缺件方向必须为 0」）。 */
export function checkBaseline(root = process.cwd(), baseline = readBaseline(join(root, BASELINE_FILE))) {
  const faces = scanDepsFaces(root)
  const depsFace = {}
  for (const f of faces) depsFace[f.deps] = faceSnapshot(f)
  return [
    ...missingDirectionViolations(faces),
    ...depsFaceViolations(depsFace, baseline.depsFace ?? {}),
    ...sizeViolations(scanSizes(root), baseline.sizes ?? {}),
  ]
}

if (process.argv[1] && process.argv[1].includes('arch-baseline')) {
  const root = process.cwd()
  const measured = measure(root)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(measured, null, 2))
  } else if (process.argv.includes('--update')) {
    writeFileSync(join(root, BASELINE_FILE), renderBaseline(measured))
    console.log(`✓ 已按实测重写 ${BASELINE_FILE}（${Object.keys(measured.depsFace).length} 个子系统 / ${Object.keys(measured.sizes).length} 个受控文件）`)
  } else {
    const bad = checkBaseline(root)
    if (bad.length) {
      console.error(`✗ 架构门基线不符（${bad.length} 条）：\n${bad.map(b => `  · ${b}`).join('\n')}`)
      process.exitCode = 1
    } else {
      console.log(`✓ 架构门基线一致（${Object.keys(measured.depsFace).length} 个子系统 / ${Object.keys(measured.sizes).length} 个受控文件）`)
    }
  }
}
