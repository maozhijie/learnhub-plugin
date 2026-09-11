/**
 * 结构性审计（吸收自 Python audit.py）。
 *
 * ERROR: E1 重名 / E2 未定义前置 / E3 环 / E4 课程文件↔图失同步 / E5 frontmatter schema / E6 enc 断边 / E7 enc 非祖先
 * WARN : R1 浅叶子 / R2 单浅前置叶子 / R4 深度异常 / R6 传递冗余 / R8 多连通分量 / R10 状态异常 / R13 认知跨步候选
 *         R14 enc 覆盖缺口 / R15 enc 与反哺候选不一致 / R16 enc 权重无区分度（内容级背书，#53）
 *         R17 先验候选未被结构回应（w≥0.7 喂料分流，#142）
 * INFO : R5 跨区引用 / R9 疑似别名 / R18 概念字段组盘点（#147，档位零门禁零调度的审计面确认）
 * ERROR 存在时返回 failed=true（生成/结算门禁）。
 * 种子图豁免（#142）：图仍 = 终点锚种子节点全集时，R1/R2/R8/R13 豁免、健康分不设阈值
 * ——种子本来就只有起点+终点几张节点，形状告警与低健康分是噪音（生长批进入后恢复）。
 */
import { scanAll, loadNote, hasReadyContent } from './notes.ts'
import { STAGES } from './types.ts'
import type { GRegion, Fm } from './types.ts'
import type { Graph } from './graph.ts'
import type { Paths } from './paths.ts'
import { parseDay, todayStr, daysBetween } from './dates.ts'
import { graphHealthScore } from './health.ts'
import { jumpCandidates } from './quality.ts'
import { Content } from './content.ts'
import { readAnchor, isSeedGraph } from './seed.ts'
import { readVaultLinksCache, splitPriorFeed } from './vault-links.ts'

export interface AuditResult {
  failed: boolean
  errors: string[]
  warns: string[]
  infos: string[]
  baseline: Record<string, number | string>
  exempt: string[]
}

export async function runAudit(
  paths: Paths, root: string, courseName: string, graph: Graph, regions: GRegion[],
  today: string = todayStr(),
): Promise<AuditResult> {
  const errors: string[] = []
  const warns: string[] = []
  const infos: string[] = []
  const { names, nset, preOf, depth, reach, hasCycle, blockOf } = graph
  const name2region = Object.fromEntries(names.map(n => [n, blockOf[n][1]]))
  const name2block = Object.fromEntries(names.map(n => [n, blockOf[n][2]]))

  // E1/E2
  for (const [n, c] of Object.entries(graph.count)) {
    if (c > 1) errors.push(`E1 重名节点: ${n} 出现 ${c} 次`)
  }
  for (const n of names) {
    for (const p of preOf[n]) {
      if (!nset.has(p)) errors.push(`E2 未定义的前置引用: ${n} -> ${p}`)
    }
  }
  // E3
  if (hasCycle) errors.push(`E3 存在环！涉及 ${graph.cycleNodes.length} 个节点，例如: ${graph.cycleNodes.slice(0, 5).join('、')}`)

  // 种子图豁免（#142）：图仍 = 终点锚的种子节点全集 = 图还是种子本身——形状类告警
  // 豁免（生长批进入后自动恢复）；E 级照查，种子也有真错误。
  const anchor = await readAnchor(paths.anchorPath(root))
  const seedPhase = isSeedGraph(anchor, graph)

  // R1 / R2 —— R1 阈值随图最大深度相对化（大图 depth>20 时 depth≤5 的旁支叶子是正常收尾），
  // 条目多时只列前 15 条附溢出行，避免淹没报告里的其他发现
  const maxDepth = names.length ? Math.max(...names.map(n => depth[n] ?? 0)) : 0
  const r1Depth = hasCycle ? 5 : Math.max(5, Math.round(maxDepth / 4))
  const r1 = graph.leaves.filter(n => !hasCycle && (depth[n] ?? 0) <= r1Depth)
  if (!seedPhase) {
    for (const n of r1.slice(0, 15)) warns.push(`R1 浅叶子: [${name2region[n]}] ${n}（depth=${depth[n]}，阈值 ${r1Depth}）`)
    if (r1.length > 15) warns.push(`R1 浅叶子另有多 ${r1.length - 15} 处未列出`)
    const r2 = names.filter(n => {
      const ps = preOf[n]
      return ps.length === 1 && depth[ps[0]] !== undefined && depth[ps[0]] <= 1 && depth[n] !== undefined && !graph.succ[n].length
    })
    for (const n of r2.slice(0, 15)) warns.push(`R2 单浅前置叶子: ${n} 仅依赖 ${preOf[n][0]}（depth=${depth[n]}）`)
    if (r2.length > 15) warns.push(`R2 单浅前置叶子另有多 ${r2.length - 15} 处未列出`)
  }

  // R4 深度异常
  const blockDepths: Record<string, Array<[number, string]>> = {}
  for (const n of names) {
    if (depth[n] !== undefined) {
      const key = `${name2region[n]}｜${name2block[n]}`
      ;(blockDepths[key] ??= []).push([depth[n], n])
    }
  }
  for (const [key, items] of Object.entries(blockDepths)) {
    if (items.length < 3) continue
    const mean = items.reduce((s, [d]) => s + d, 0) / items.length
    const [region, block] = key.split('｜')
    for (const [d, n] of items) {
      const ps = preOf[n]
      const isEntry = !ps.length || ps.every(p => name2block[p] !== block)
      if (isEntry) continue
      if (mean > 0 && d < mean / 2) warns.push(`R4 深度异常: [${region} · ${block}] ${n} depth=${d}，块均值=${mean.toFixed(1)}`)
    }
  }
  // R5 / R6（R6 升 WARN：冗余边是「连接不准」的机械可检面，交付前须逐条 verdict 清零）
  for (const n of names) {
    for (const p of preOf[n]) {
      if (nset.has(p) && name2region[p] !== name2region[n]) {
        infos.push(`R5 跨区引用: [${name2region[n]}] ${n} <- [${name2region[p]}] ${p}`)
      }
    }
  }
  if (!hasCycle) {
    for (const n of names) {
      const ps = preOf[n].filter(p => nset.has(p))
      for (const p of ps) {
        if (ps.some(q => q !== p && (reach[q]?.has(p)))) {
          warns.push(`R6 冗余前置: ${n} 的 pre 中 ${p} 可经其它前置传递到达`)
        }
      }
    }
  }
  // R8
  if (!seedPhase && graph.components.length > 1) {
    for (const members of [...graph.components].sort((a, b) => b.length - a.length)) {
      warns.push(`R8 孤立连通分量（${members.length} 节点）: ${members.slice(0, 5).join('、')}${members.length > 5 ? '…' : ''}`)
    }
  }
  // R9
  const uniq = [...nset].sort((a, b) => a.length - b.length)
  const aliasHits: string[] = []
  for (let i = 0; i < uniq.length; i++) {
    if (uniq[i].length < 3) continue
    for (let j = i + 1; j < uniq.length; j++) {
      if (uniq[i] !== uniq[j] && uniq[j].includes(uniq[i])) aliasHits.push(`${uniq[i]} ⊂ ${uniq[j]}`)
    }
  }
  if (aliasHits.length) {
    infos.push('R9 疑似别名/包含命名: ' + aliasHits.slice(0, 15).join('；')
      + (aliasHits.length > 15 ? `；另有多 ${aliasHits.length - 15} 对未列出` : ''))
  }

  // E4 课程文件 ↔ 图同步 + E5 frontmatter schema
  const { found, broken } = await scanAll(paths.courseDir(root))
  const fsErrors = new Set<string>()
  for (const b of broken) {
    errors.push(`E4 课程文件 Broken（${b.path.replace(/\\/g, '/').split(`${root}/`)[1] ?? b.path}）: ${b.reason}`)
  }
  for (const [nodeName, { path, fm: rawFm }] of Object.entries(found).sort()) {
    const rel = path.replace(/\\/g, '/').split(`${root}/`)[1] ?? path
    if (!nset.has(nodeName)) {
      errors.push(`E4 课程文件对应未知节点（改名未同步？用 rename op）: ${rel} → ${nodeName}`)
      continue
    }
    const canonical = paths.courseNotePath(root, blockOf[nodeName][1], nodeName)
    if (path.replace(/\\/g, '/').toLowerCase() !== canonical.replace(/\\/g, '/').toLowerCase()) {
      warns.push(`R10 课程文件位置非规范（应用 rename/move op）: ${rel}`)
    }
    const fm = rawFm as Record<string, unknown>
    const stage = fm.stage
    if (typeof stage !== 'string' || !(STAGES as string[]).includes(stage)) {
      errors.push(`E5 stage 非法（${JSON.stringify(stage)}）: ${rel}，允许 ${STAGES.join('/')}`)
    }
    let fs: Record<string, unknown> | null = null
    if (fm.fsrs !== null && fm.fsrs !== undefined) {
      if (typeof fm.fsrs !== 'object') {
        fsErrors.add(`E5 fsrs 字段类型错误: ${rel}`)
      } else {
        fs = fm.fsrs as Record<string, unknown>
      }
    }
    if ((stage === 'review' || stage === 'mastered') && !fs) {
      fsErrors.add(`E5 stage=${stage} 但 fsrs 字段缺失: ${rel}`)
    }
    if (fs) {
      const s = fs.stability
      const d = fs.difficulty
      if (typeof s !== 'number' || s <= 0) fsErrors.add(`E5 fsrs.stability 非法（${JSON.stringify(s)}）: ${rel}`)
      if (typeof d !== 'number' || !(d >= 1 && d <= 10)) fsErrors.add(`E5 fsrs.difficulty 非法（${JSON.stringify(d)}）: ${rel}`)
      for (const key of ['due', 'last_review'] as const) {
        if (fs[key] !== null && fs[key] !== undefined && !parseDay(fs[key] as string)) {
          fsErrors.add(`E5 fsrs.${key} 日期不可解析（${JSON.stringify(fs[key])}）: ${rel}`)
        }
      }
      for (const key of ['reps', 'lapses'] as const) {
        if (fs[key] !== null && fs[key] !== undefined && !Number.isInteger(fs[key])) {
          fsErrors.add(`E5 fsrs.${key} 必须是整数: ${rel}`)
        }
      }
      const due = parseDay(fs.due as string)
      if (stage === 'review' || stage === 'mastered') {
        if (!due) warns.push(`R10 stage=${stage} 但 due 缺失: ${rel}`)
        else {
          const gap = daysBetween(parseDay(today)!, due)
          if (gap > 14) warns.push(`R10 stage=${stage} 且 due 远过期（${fmt(due)}）: ${rel}`)
        }
      }
      const practice = (fm.practice ?? {}) as { attempts?: number }
      const reps = Number(fs.reps ?? 0)
      if ((stage === 'review' || stage === 'mastered') && reps > 0 && !(practice.attempts)) {
        warns.push(`R10 已复习 ${reps} 次但练习作答为 0: ${rel}`)
      }
    }
    const content = fm.content as Record<string, unknown> | undefined
    if (content && typeof content === 'object' && !['draft', 'reviewed', 'flagged'].includes(String(content.status))) {
      fsErrors.add(`E5 content.status 非法（${JSON.stringify(content.status)}）: ${rel}`)
    }
    // 内容级 enc 背书（#53 / ADR-0008）：已声明 enc 或已有 Ready 内容时读正文，对照
    // 反哺候选与已声明 enc 报覆盖缺口/一致性/权重合理性（warn/info，不阻断——补覆盖渐进）。
    const hasReady = hasReadyContent(fm as unknown as Fm)
    if ((graph.encOf[nodeName] ?? []).length || hasReady) {
      const { body } = await loadNote(path)
      const encHints = Content.encContentHints(graph, nodeName, body, hasReady)
      warns.push(...encHints.warns)
      infos.push(...encHints.infos)
    }
  }
  errors.push(...fsErrors)

  // E6/E7 enc 边
  for (const n of names) {
    for (const [target] of graph.encOf[n] ?? []) {
      if (!nset.has(target)) errors.push(`E6 enc 断边: ${n} -> ${target}`)
      else if (!hasCycle && !graph.isAncestor(target, n)) errors.push(`E7 enc 非祖先（目标不在 pre 传递闭包内）: ${n} -> ${target}`)
    }
  }

  // R12 认知-时长失配（可选字段；渐进采纳不强制存量补齐）
  for (const n of names) {
    const d = graph.difficultyOf[n]
    if (d === undefined) continue
    const est = graph.estOf[n]
    if (est !== undefined && ((d >= 4 && est < 15) || (d <= 2 && est > 40))) {
      infos.push(`R12 认知-时长失配: ${n}（难度${d}，est=${est}分钟）`)
    }
  }

  // R13 认知跨步候选（合成口径：难度差 / 铺垫断层，见 quality.ts；唯一跳步检测器，
  // 已吸收旧 R11 的难度差口径以免同一跳重复 WARN；WARN 只列前 15，全量走 analyze）
  if (!seedPhase) {
    const jumpAll = jumpCandidates(graph)
    for (const j of jumpAll.slice(0, 15)) {
      warns.push(`R13 认知跨步候选（需 verdict）: ${j.pre} -> ${j.node}（难度差 ${j.difficultyGap ?? '—'}，depth 跨 ${j.depthSpan}，${j.reasons.join('+')}）`)
    }
    if (jumpAll.length > 15) warns.push(`R13 认知跨步候选另有多 ${jumpAll.length - 15} 处未列出`)
  }

  // R17 先验喂料分流（#142）：vault 链接先验 w≥0.7 的候选对未被结构显式回应
  // （pre/enc 任一方向）→ WARN 可见——喂料分流取代人审分流；候选/断言边用位置
  // 区分（不动节点键集）。零先验（缓存 Missing）零输出——合法常态路径非 Broken。
  const vaultCache = await readVaultLinksCache(paths.vaultLinksPath)
  if (vaultCache) {
    const { unresponded } = splitPriorFeed(vaultCache.edges, names, graph)
    for (const v of unresponded) {
      warns.push(`R17 先验候选未被结构回应（w≥0.7 喂料分流）: ${v.aNode} ~ ${v.bNode}（w=${v.w}）——补 pre/enc 显式回应，或重扫 vault 后自然消失`)
    }
  }
  if (seedPhase) {
    infos.push(`种子图豁免生效：浅叶/多分量/认知跨步等形状告警豁免、健康分不设阈值（种子 = 终点「${anchor!.endpoint}」，${anchor!.declared} 声明；生长批进入后恢复）`)
  }

  // R18 概念字段组盘点（#147）：teaches/assumes 档位与误解先验的规模盘点。显式分工——
  // 档位（知道/会用/能教）是概念级生成注入的感知面，不进门禁不进调度（既裁；bloom 管
  // 认知形态、difficulty 管难度信号）；误解消费锚定内容生成。本项只盘点，不校验语义。
  const teachesNodes = Object.keys(graph.teachesOf).length
  const assumesNodes = Object.keys(graph.assumesOf).length
  const misCount = Object.values(graph.misconceptionsOf).reduce((s, v) => s + v.length, 0)
  infos.push(`R18 概念字段组盘点: teaches ${teachesNodes} 节点、assumes ${assumesNodes} 节点、误解 ${misCount} 条（概念档位为生成注入感知面——不进门禁不进调度，本项只盘点）`)

  const exempt = names.filter(n => !found[n])
  const baseline: Record<string, number | string> = {
    概念节点: names.length,
    有向边: graph.edgeCount(),
    'enc 边': Object.values(graph.encOf).reduce((s, v) => s + v.length, 0),
    '根节点（无前置）': graph.roots.length,
    '叶子（无后继）': graph.leaves.length,
    最大深度: Object.keys(depth).length ? Math.max(...Object.values(depth)) : '-',
    '课程文件（已纳管）': Object.keys(found).length,
    未生成豁免: exempt.length,
    终点锚: anchor
      ? `${anchor.endpoint}（${anchor.goal_type === 'coverage' ? '覆盖' : '能力'}锚定，${anchor.declared} 声明）`
      : '未播种',
    '概念字段（teaches/assumes/误解）': `${teachesNodes} / ${assumesNodes} / ${misCount}`,
    图谱健康分: graphHealthScore(graph).score,
    'ERROR / WARN / INFO': `${errors.length} / ${warns.length} / ${infos.length}`,
  }

  // 报告落盘
  const lines: string[] = []
  lines.push(`# ${courseName} · 审计报告`, '')
  lines.push('> 由 learnhub 引擎（TS）自动生成。ERROR 阻断生成与结算，WARN 需人工裁决，INFO 仅提示。', '')
  lines.push('## 基线指标', '', '| 指标 | 数值 |', '|---|---|')
  for (const [k, v] of Object.entries(baseline)) lines.push(`| ${k} | ${v} |`)
  lines.push('')
  const section = (title: string, items: string[]) => {
    lines.push(`## ${title}`, '')
    if (items.length) for (const it of items) lines.push(`- ${it}`)
    else lines.push('（无）')
    lines.push('')
  }
  section('ERROR（阻断级，必须修复）', errors)
  section('WARN（需人工裁决）', warns)
  lines.push(`## 未生成课程文件豁免登记（E4，共 ${exempt.length} 个；内容管线生成后自动销号）`, '')
  if (exempt.length) {
    const byRegion: Record<string, string[]> = {}
    for (const n of exempt) (byRegion[name2region[n]] ??= []).push(n)
    for (const region of regions) {
      if (byRegion[region.name]) lines.push(`- [${region.name}] ${byRegion[region.name].length} 个`)
    }
  } else {
    lines.push('（无）')
  }
  lines.push('')
  section('INFO · R5/R9 提示项', infos)
  await import('./io.ts').then(m => m.atomicWrite(paths.reportPath(root), lines.join('\n')))

  return { failed: errors.length > 0, errors, warns, infos, baseline, exempt }
}

function fmt(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** stage 视图（调度消费的统一入口）：无状态行视为 unseen。 */
export { effectiveStage } from './srs.ts'
