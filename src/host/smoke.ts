/**
 * 生成冒烟运行器（#215）：一条命令在**临时 vault** 跑通全管线并产出结构断言报告——
 * 专门捕捉「模型升级/换供应商导致的格式漂移」，这是离线 fixture 覆盖不到的唯一盲区
 * （离线测试全确定性、模型输出零实捕）。
 *
 * 与 scripts/smoke.mjs（只读读路径冒烟）分工不同：本文件是**写路径 + 真模型**冒烟，
 * 必须跑在宿主进程里（真 provider 只在宿主 ctx 上）。链路：
 *
 *   临时 vault → 结构站（#256 种子退役后 = 手写 edit 提案铺起点 + 终点接线）→ 提案直通
 *   （脚本内人审等价：apply 即受理，走生产 apply 路径而非人工点按）→ 正文管线（大纲 → 逐节
 *   → 出题，经全局队列）→ 产物复过既有结构门（contentCheck 质检门 / 契约注册表 validateByContract
 *   / 题库读回即 validateBank 门）→ 汇总报告。
 *
 * 报告三块：各站成功率与失败码分布（读语料捕获，#213）、token 消耗（frontmatter
 * usage 求和）、产物结构断言（复跑既有门，不重造判据）。规模控制：1 节点、走真实
 * provider 与用户配额——单次成本压在几个调用内（题量默认 4、第二意见门默认关）。
 *
 * 隔离纪律：一切写在 mkdtemp 临时目录、结束即删；真实 vault 零接触（宿主只借 ctx
 * 与 provider 配置）。宿主未编译/未起时的可执行指引由驱动脚本 scripts/gen-smoke.mjs
 * 给出（它把连接失败转成指引，不静默）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { contractOf, hasReadyContent, validateByContract } from '../engine/index.ts'
import { createHostRuntime } from './runtime.ts'
import type { HostRuntime } from './runtime.ts'
import { afterGraphApply, cancelGeneration, enqueueGeneration, pumpGeneration, waitForGenJob } from './jobs.ts'
import { parseCorpusFrontmatter } from './corpus.ts'

/** 冒烟入参（路由可覆盖，缺省即最小成本档）。 */
export interface SmokeRequest {
  /** 目标描述（终点锚的 goal_note；缺省给一个迷你能力目标）。 */
  goal?: string
  /** 课程名（临时 vault 内新建；缺省「冒烟课」）。 */
  course?: string
  /** 出题目标题量（缺省 4——最小成本档）。 */
  quizCount?: number
  /** 第二意见门抽样率覆盖（缺省 0 = 关；冒烟不背这个成本）。 */
  quizAuditRate?: number
  /** 正文管线等待上限毫秒（缺省 10 分钟）。 */
  jobTimeoutMs?: number
  /** 语料落盘目录覆盖（绝对路径；缺省 = 临时 vault 内的 `state/生成语料`，随 vault 一起删）。
   * 给一个持久目录 = 把本轮真模型调用的提示词与产出留在盘上，供离线评审器抽样（#222/#224
   * 的实跑样本来源；与 spike 的 --corpus 同形态）。 */
  corpusDir?: string
}

/** 一站（语料桶）的汇总：成功率与失败码分布 + token 计量。 */
export interface SmokeStationStats {
  station: string
  calls: number
  ok: number
  tolerated: number
  failed: number
  /** 失败码分布（failed 桶的 code 计数；空 = 无失败）。 */
  failureCodes: Record<string, number>
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  promptChars: number
  replyChars: number
  durationMs: number
}

/** 产物结构断言（复跑既有门；每项带判据出处，不重造判据）。 */
export interface SmokeArtifactCheck {
  name: string
  /** 判据出处（既有门/注册表）。 */
  by: string
  ok: boolean
  detail: string
}

/** 冒烟裁决：ok = 跑通且结构门全过；partial = 管线部分完成（有节/出题失败，死因在报告）；
 * failed = 站级异常或结构门未过。驱动脚本按它定退出码（0/2/1）。 */
export type SmokeVerdict = 'ok' | 'partial' | 'failed'

export interface SmokeReport {
  verdict: SmokeVerdict
  startedAt: string
  durationMs: number
  course: string
  node: string | null
  /** 管线终局面（任务终态 + 失败节清单——文本面）。 */
  pipeline: {
    /** 结构站（#256：种子退役后改用手写 edit 提案铺起点）受理的提案 id。 */
    proposalId: number | null
    endpoint: string | null
    /** 跑正文管线的起点节点名（edit 提案铺出的节点）。 */
    start: string | null
    jobStatus: string | null
    jobMessage: string | null
    failedSections: Array<{ sectionTitle?: string; code?: string; finding?: string }>
    /** 管线终局失败（站级）：结构站提案未受理 / 正文站任务失败·超时·消失——报告照出
     * （诊断面不给 500：报告里要能看到是哪一站、什么失败码、语料去哪看）。 */
    stageError?: { stage: 'structure' | 'content'; message: string }
  }
  stations: SmokeStationStats[]
  artifacts: SmokeArtifactCheck[]
  /** 语料目录（临时 vault 内绝对路径；报告读出后随 vault 一起删除）。 */
  corpusDir: string
  /** 可执行指引（未编译/未起宿主等场景的下一步）。 */
  hints: string[]
}

/** 复跑既有结构门的判据（写进报告的 by 列——读者一眼知道这不算新判据）。 */
const BY = {
  content: 'engine.contentCheck（质检门：形状/越界/别名/块级）',
  outline: 'output-contracts.validateByContract（课程大纲契约 shape）',
  quiz: 'output-contracts.validateByContract（题目生成契约 shape）+ engine.bank.load（validateBank 读回）',
  note: 'engine.loadView（笔记 frontmatter 读）',
} as const

/** usage 行形如 `usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2 }`。 */
function usageOf(fm: Record<string, string>): { input: number; output: number; reasoning: number } {
  const m = /input_tokens:\s*(\d+),\s*output_tokens:\s*(\d+)(?:,\s*reasoning_tokens:\s*(\d+))?/.exec(fm.usage ?? '')
  return { input: Number(m?.[1] ?? 0), output: Number(m?.[2] ?? 0), reasoning: Number(m?.[3] ?? 0) }
}

/** 读语料目录汇总各站（捕获已是「每调用一文件」，报告只是换个读法）。 */
export function collectStations(corpusDir: string): SmokeStationStats[] {
  const byStation = new Map<string, SmokeStationStats>()
  if (!existsSync(corpusDir)) return []
  for (const station of readdirSync(corpusDir)) {
    const dir = join(corpusDir, station)
    let files: string[]
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.md'))
    } catch {
      continue  // 非目录/已删：跳过
    }
    const s: SmokeStationStats = {
      station, calls: 0, ok: 0, tolerated: 0, failed: 0, failureCodes: {},
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0, promptChars: 0, replyChars: 0, durationMs: 0,
    }
    for (const f of files) {
      const fm = parseCorpusFrontmatter(readFileSync(join(dir, f), 'utf8'))
      s.calls++
      const outcome = fm.outcome ?? 'ok'
      if (outcome === 'ok') s.ok++
      else if (outcome === 'tolerated') s.tolerated++
      else s.failed++
      if (fm.code) s.failureCodes[fm.code] = (s.failureCodes[fm.code] ?? 0) + 1
      const u = usageOf(fm)
      s.inputTokens += u.input
      s.outputTokens += u.output
      s.reasoningTokens += u.reasoning
      s.promptChars += Number(fm.prompt_chars ?? 0)
      s.replyChars += Number(fm.reply_chars ?? 0)
      s.durationMs += Number(fm.duration_ms ?? 0)
    }
    byStation.set(station, s)
  }
  // 稳定序：调用多的站在前，同数按站名（报告 diff 可读）
  return [...byStation.values()].sort((a, b) => b.calls - a.calls || a.station.localeCompare(b.station))
}

/** 产物结构断言：读临时 vault 的最终产物，复跑既有门（零新判据）。
 * 每项自成 try/catch——门因前置缺席（正文未生成/笔记未就绪）跑不动时，如实记成一条
 * 失败断言（含门抛出的原文），报告不因断言自身出错而整体坍掉。 */
async function checkArtifacts(rt: HostRuntime, course: string, node: string): Promise<SmokeArtifactCheck[]> {
  const checks: SmokeArtifactCheck[] = []
  const push = (name: string, by: string, ok: boolean, detail: string): void => {
    checks.push({ name, by, ok, detail })
  }
  const gate = async (name: string, by: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<void> => {
    try {
      const r = await fn()
      push(name, by, r.ok, r.detail)
    } catch (err) {
      push(name, by, false, `门未跑通：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const c = await rt.engine.registry.get(course)
  if (!c) {
    push('课程注册', BY.note, false, `注册表里没有课程「${course}」`)
    return checks
  }
  await gate('大纲节清单', BY.outline, async () => {
    const { state } = await rt.engine.loadView(c)
    const fm = state[node]
    const sections = (fm?.content?.sections ?? []) as Array<{ id?: unknown; status?: unknown }>
    return {
      ok: sections.length > 0,
      detail: sections.length
        ? `${sections.length} 节：${sections.map(s => String(s.id ?? '?')).join('、')}（就绪 ${sections.filter(s => s.status === 'ready').length}）`
        : '笔记 frontmatter 没有 content.sections',
    }
  })
  await gate('大纲契约 shape', BY.outline, async () => {
    const outlineContract = contractOf('课程大纲')
    if (!outlineContract) return { ok: false, detail: '契约注册表里没有「课程大纲」条目' }
    const { state } = await rt.engine.loadView(c)
    const sections = state[node]?.content?.sections ?? []
    const verdict = validateByContract(outlineContract, { sections })
    return { ok: verdict.ok, detail: verdict.ok ? 'sections 是列表（契约 shape 过）' : verdict.errors.join('；') }
  })
  await gate('正文质检门', BY.content, async () => {
    const gateReport = await rt.engine.content2.contentCheck(course, node)
    return {
      ok: gateReport.passed,
      detail: gateReport.passed ? `过（warn ${gateReport.warns.length} 条）` : gateReport.findings.join('；'),
    }
  })
  await gate('正文就绪', BY.note, async () => {
    const { state } = await rt.engine.loadView(c)
    const fm = state[node]
    return {
      ok: hasReadyContent(fm),
      detail: hasReadyContent(fm)
        ? `content.status=${String(fm?.content.status ?? '?')} v${String(fm?.content.version ?? '?')}`
        : '笔记 frontmatter 无就绪节',
    }
  })
  await gate('题库存量', BY.quiz, async () => {
    const bank = await rt.engine.bank.load(rt.engine.paths.courseRoot(c.root), node)
    const live = bank.questions.filter(q => !q.archived)
    return {
      ok: live.length > 0,
      detail: live.length ? `${live.length} 道（归档 ${bank.questions.length - live.length}）` : '题库为空',
    }
  })
  await gate('题目契约 shape', BY.quiz, async () => {
    const quizContract = contractOf('题目生成')
    if (!quizContract) return { ok: false, detail: '契约注册表里没有「题目生成」条目' }
    const bank = await rt.engine.bank.load(rt.engine.paths.courseRoot(c.root), node)
    const live = bank.questions.filter(q => !q.archived)
    const verdict = validateByContract(quizContract, { node, questions: live })
    return { ok: verdict.ok, detail: verdict.ok ? 'questions 是列表（契约 shape 过）' : verdict.errors.join('；') }
  })
  await gate('图节点在场', 'engine.loadView（图读）', async () => {
    const { graph, broken } = await rt.engine.loadView(c)
    return { ok: graph.nset.has(node), detail: `${course}/${node}${broken ? '（图有 Broken 项）' : ''}` }
  })
  return checks
}

/** 等任务离开 queued（泵在入队处同步启动执行，毫秒级）——暂停旗标只该落在「已在跑」之后。 */
async function waitUntilRunning(rt: HostRuntime, key: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    const s = rt.jobs.genJobs.get(key)?.status
    if (s !== undefined && s !== 'queued') return
    if (Date.now() - start > timeoutMs) throw new Error(`[smoke] 正文任务「${key}」未在 ${timeoutMs / 1000}s 内开跑。`)
    await new Promise<void>(r => setTimeout(r, 50))
  }
}

/** 终局裁决三态（驱动脚本按此定退出码）：
 * - failed：站级异常（stageError）、结构断言失败、或任务非终态；
 * - partial：任务终态 partial（管线的「未完成全部必需阶段」——有节失败或出题整批失败）。
 *   冒烟是「跑通」检查：partial 不算跑通，但死因已在报告里逐条列出（节标题 + 失败码）；
 * - ok：任务 done + 结构断言全过。 */
function verdictOf(pipeline: SmokeReport['pipeline'], artifacts: SmokeArtifactCheck[]): SmokeVerdict {
  if (pipeline.stageError) return 'failed'
  if (artifacts.some(a => !a.ok)) return 'failed'
  if (pipeline.jobStatus === 'done') return 'ok'
  if (pipeline.jobStatus === 'partial') return 'partial'
  return 'failed'
}

/** 跑一次冒烟（路由 handler 调用；全程临时目录，结束即删）。 */
export async function runGenerationSmoke(ctx: Context, req: SmokeRequest = {}): Promise<SmokeReport> {
  if (!ctx.llm) {
    throw new Error('[smoke] 宿主 ctx 没有 llm——生成冒烟必须在宿主进程内跑（真 provider 只在宿主）。'
      + '先在仓库根 npm run build，再 npx @deepseek-ai/dsh web 起宿主（本机 profile 已 link 本 checkout）。')
  }
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const course = (req.course ?? '冒烟课').trim()
  const goal = (req.goal ?? '能用一句话说清「变量」是什么，并给一个生活里的例子。').trim()
  const quizCount = req.quizCount ?? 4
  const jobTimeoutMs = req.jobTimeoutMs ?? 10 * 60_000
  const root = mkdtempSync(join(tmpdir(), 'learnhub-gen-smoke-')).replace(/\\/g, '/')
  // 语料落点：给了 corpusDir 就写外面（临时 vault 随跑随删，语料留不下来），
  // 报告站表与 corpusDir 字段都读这个实际落点（#222 实测抓出：两边各说各话）
  const corpusDir = req.corpusDir ? req.corpusDir.replace(/\\/g, '/') : `${root}/学习中心/state/生成语料`
  let rt: HostRuntime | null = null
  try {
    mkdirSync(join(root, '学习中心'), { recursive: true })
    // 临时 runtime（#167 唯一装配缝）：同一套宿主技术层与真 provider 适配器，只是
    // 部署路径指向 tmp；quizAuditRate 显式 0（冒烟不背第二意见成本）
    rt = createHostRuntime(ctx, {
      vault: root, centerRel: '学习中心', quizAuditRate: req.quizAuditRate ?? 0,
      ...(req.corpusDir ? { corpusDir: req.corpusDir } : {}),
    })
    const runner = rt

    // 管线终局面累加器：任何一站死掉都照出报告（诊断面不给 500），只有「拿不到宿主
    // llm」在上面直接抛。
    const pipeline: SmokeReport['pipeline'] = {
      proposalId: null, endpoint: null, start: null, jobStatus: null, jobMessage: null, failedSections: [],
    }
    let node: string | null = null

    // —— ① 建课 + 加终点 + 结构提案（#256：种子站退役，改用手写 edit 提案铺起点节点）
    // + 提案直通（脚本内人审等价：apply 即受理）——
    try {
      await runner.engine.graph.createCourse(course)
      const endpoint = `${course}目标`
      await runner.engine.graph.addEndpoint(course, endpoint, goal)
      // 终点落图后「未分区/未分区」块已在图上——edit 的 add_node 据此建起点节点，
      // 再把终点接线到起点（起点 → 终点 一条最小链）。edit 不能新建区/块（add_node 的
      // 区/块必须已存在），故起点只能落在 addEndpoint 建出的未分区块里。
      const startName = `${course}起点`
      const proposal = await runner.engine.graph.graphPropose('edit', [
        `course: ${course}`,
        'reason: 冒烟起点（#256 种子退役后结构站改用手写 edit 提案）',
        'ops:',
        `  - { op: add_node, name: ${startName}, region: 未分区, block: 未分区, pre: [] }`,
        `  - { op: set_pre, node: ${endpoint}, pre: [${startName}] }`,
      ].join('\n'))
      pipeline.proposalId = proposal.id
      pipeline.endpoint = endpoint
      const applied = await runner.engine.graph.graphApply('edit', proposal.id)
      if (!('ops' in applied) || !(applied.ops >= 1)) throw new Error('结构提案应用零操作——无法继续正文管线（见语料「结构提案」死因）')
      pipeline.start = startName
      node = startName
      // 宿主侧 apply 联动（清扫悬空任务）；正文不随 apply 入队（ADR-0078），冒烟在此
      // 补一步显式下发（等价于面板「生成」按钮）——漏了入队就是「任务不在注册表」
      await afterGraphApply(runner)

      // —— ② 正文管线（大纲 → 逐节 → 出题）：与面板「生成」入口同一条生产路径 ——
      await enqueueGeneration(runner, ctx, course, node)
      const key = `${course}/${node}`
      const job0 = runner.jobs.genJobs.get(key)
      if (job0) job0.quizCount = quizCount
      pumpGeneration(runner, ctx)
      // 冒烟只跑生成四站：生成泵排空时会自动拉教练生长批（生产行为），那是另一笔真实
      // 额度（ADR-0078 后不再连锁生成正文）——**挡泵不挡在途**：暂停旗标让后续自动
      // 入队的批安静排队（随临时目录一起丢弃），在跑的正文管线照常到终态。
      await waitUntilRunning(runner, key)
      runner.flags.queuePaused = true
      const job = await waitForGenJob(runner, key, jobTimeoutMs)
      pipeline.jobStatus = job.status
      pipeline.jobMessage = job.message ?? null
      pipeline.failedSections = (job.failures ?? []).map(f => ({
        ...(f.sectionTitle ? { sectionTitle: f.sectionTitle } : {}),
        code: f.code,
        ...(f.finding ? { finding: f.finding } : {}),
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pipeline.jobStatus = pipeline.jobStatus ?? 'failed'
      pipeline.jobMessage = pipeline.jobMessage ?? message
      pipeline.stageError = { stage: node === null ? 'structure' : 'content', message }
      runner.flags.queuePaused = true
    }

    // 语料写盘是异步 fire-and-forget（生产纪律：观测面不挡主流程）——读站统计前放干，
    // 否则刚补标的失败样本可能还在链上，报告会把它读成 ok
    await runner.corpus.flush()
    // 站统计读**本轮实际的语料落点**（#222 实测抓出：给了 corpusDir 时还读临时 vault 的
    // 空目录，报告站表恒 0 行——语料写在外面、报告读在里面，两边各说各话）
    const stations = collectStations(corpusDir)
    const artifacts = node ? await checkArtifacts(runner, course, node) : []
    return {
      verdict: verdictOf(pipeline, artifacts),
      startedAt,
      durationMs: Date.now() - startedAtMs,
      course,
      node,
      pipeline,
      stations,
      artifacts,
      corpusDir,
      hints: [
        `题量目标 ${quizCount}（成本闸只封综合批；逐节批按档位默认）`,
        '要复现「解析回归能在报告里现形」：临时把 src/engine/yaml.ts 的 parseModel 改成抛错 → npm run build → 重启宿主 → 重跑 npm run smoke；'
        + '报告里对应站 outcome=failed、失败码进站行（还原后重跑即绿）。',
      ],
    }
  } finally {
    if (rt) {
      // 收尾：停泵（取消在途任务）再删目录——后台写盘与 rm -r 竞争会 ENOTEMPTY
      for (const [key, j] of rt.jobs.genJobs) {
        if (j.status === 'running' || j.status === 'queued' || j.status === 'cancelling') {
          const i = key.indexOf('/')
          cancelGeneration(rt, key.slice(0, i), key.slice(i + 1))
        }
      }
      await rt.corpus.flush().catch(() => undefined)
    }
    rmSync(root, { recursive: true, force: true })
  }
}
