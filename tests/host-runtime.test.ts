/**
 * 宿主 runtime 单测（#167 / ADR-0048）——宿主第一次可测：
 * 造一个 HostRuntime（临时 vault + 假 ctx + 影子引擎方法）即可断言：
 *   - 队列泵状态机：入队 → 执行 → 终态 → 保留期清扫（进程内定时器与恢复补挂同语义）
 *   - 暂停/恢复：重启暂停旗标挡泵，resumeQueue 清旗标并复泵
 *   - quizJobResults 等待语义：agent 工具同步语义（入队 + 等终态 + 读结果表）、超时与消失 fail loud
 *   - 工具面快照：111 个工具的名称/描述/schema 与重构前基线逐字不变（tests/fixtures/host-tools-snapshot.json，
 *     由重构前的 src/index.ts mock-apply 捕获）
 *   - 「路由 ↔ 工具」对账基线：84 共享引擎入口 / 工具独有 26 / 路由独有 50
 *     （tests/fixtures/host-face-baseline.json，ADR-0045 命令注册表迁移的回归网）
 * 引擎方法用实例属性影子化（shadowing prototype），不依赖真实模型与真实课程数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { LearnhubEngine } from '../src/engine/index.ts'
import { createHostRuntime, resolveEngineEntry } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { mathRng, systemClock } from '../src/host/clock.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { handleApi } from '../src/host/api.ts'
import {
  cancelGeneration,
  enqueueGeneration,
  enqueueGrowthBatch,
  enqueueQuizGeneration,
  enqueueGraphJob,
  generationStatus,
  pumpGeneration,
  resetCourseChain,
  restoreGenJobs,
  resumeQueue,
  scheduleJobRetention,
  sweepGenJobs,
  triggerSeedContent,
  waitForGenJob,
} from '../src/host/jobs.ts'
import { AGENT_GUIDE, registerTools } from '../src/host/tools.ts'
import { COMMAND_LIST } from '../src/commands/index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpVaults: string[] = []

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 轮询直至条件成立；超时 fail loud（不用真等待，泵与定时器都是毫秒级）。 */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail('等待超时：条件未在时限内成立')
    await sleep(10)
  }
}

/** 假宿主 ctx：tools.register 捕获注册对象；effect/webServer 空转（createHostRuntime 不触 ctx）。 */
function fakeCtx(captured?: unknown[]): Context {
  return {
    tools: { register: (t: unknown) => { captured?.push(t); return () => undefined } },
    effect: () => undefined,
    webServer: { register: () => undefined },
  } as unknown as Context
}

/** 造一个隔离 runtime：临时 vault + 空旗标（并行测试互不污染——模块级状态归零的直接收益）。 */
function makeRuntime(): HostRuntime {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-rt-'))
  tmpVaults.push(vault)
  mkdirSync(join(vault, '学习中心'))
  return createHostRuntime(fakeCtx(), { vault, centerRel: '学习中心' })
}

/** 影子化引擎方法（实例属性覆盖原型方法），脚本化宿主依赖的引擎入口。 */
/** 测试桩（C 形态感知，ADR-0049）：键可以是裸名（hub 装配域方法，覆盖在门面实例上）
 * 或 `<子系统>.<方法>` 点路径（覆盖在子系统实例上）——与 jobs 的实际调用路径一致。 */
function stub(rt: HostRuntime, methods: Record<string, unknown>): void {
  const engine = rt.engine as unknown as Record<string, unknown>
  for (const [k, fn] of Object.entries(methods)) {
    const dot = k.indexOf('.')
    if (dot < 0) { engine[k] = fn; continue }
    const sub = engine[k.slice(0, dot)] as Record<string, unknown>
    sub[k.slice(dot + 1)] = fn
  }
}

/** 内容管线的确定性脚本：节清单直接 ready（跳过大纲与逐节正文），出题两段走固定结果；
 * saveGenJobs 捕获每次落盘快照；coach/settle 静默（queue_idle 触点的消费方）。 */
function stubContentPipeline(rt: HostRuntime, opts: { saved?: Array<Array<unknown>> } = {}): void {
  stub(rt, {
    'content2.contentPack': async () => '上下文包',
    'content2.contentTierOf': async () => 1,
    'content2.loadPrompt': async () => 'TPL',
    'content2.contentSectionsView': async () => [{ id: 's1', title: '第一节', type: '概念', status: 'ready' }],
    'bank2.questionGenerateSections': async () => ({ added: 2 }),
    'bank2.questionGenerate': async () => ({ added: 3, total: 5, duplicates: [], rejected: [], skipped: [], enc: {} }),
    'registry.get': async () => ({ name: '数学' }),
    loadView: async () => ({ graph: { nset: new Set(['节点A', '节点B', '节点C']) } }),
    saveGenJobs: async (jobs: Array<unknown>) => { opts.saved?.push(jobs) },
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
}

// ---------------------------------------------------------------- runtime 构造

test('resolveEngineEntry：抽函数展开调用必须携带接收者（#190——真引擎组合缝）', async () => {
  // 路由/工具探针把引擎方法影子化为录制替身——替身不用 this，unbound 缺陷对快照
  // 不可见（#182 批A 引入抽函数裸调用后面板注册表路由全 500，三层验收全数穿透）。
  // 本测试用真引擎补上「分发器 ↔ 真引擎」的组合缝：点路径绑子系统实例、裸名绑 hub。
  const rt = makeRuntime()
  const tree = await (resolveEngineEntry(rt, 'content2.coursesTree') as () => Promise<{ courses: unknown[] }> )()
  assert.ok(Array.isArray(tree.courses), '点路径引擎入口丢 this（子系统方法 this.e undefined）')
  await (resolveEngineEntry(rt, 'statusJson') as () => Promise<unknown>)()
})

test('createHostRuntime：部署校验 fail loud（缺失/不存在不做静默兜底）', () => {
  const ctx = fakeCtx()
  assert.throws(() => createHostRuntime(ctx, {}), /config\.vault 缺失/)
  assert.throws(() => createHostRuntime(ctx, { vault: join(tmpdir(), 'learnhub-不存在-vault') }), /config\.vault 目录不存在/)
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-rt-chk-'))
  tmpVaults.push(vault)
  assert.throws(() => createHostRuntime(ctx, { vault }), /学习中心目录不存在/)
})

test('createHostRuntime：新鲜库出生盖 v2 戳；已有 v2 learnhub.json 的库原样保留', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'learnhub-rt-fresh-'))
  tmpVaults.push(fresh)
  mkdirSync(join(fresh, '学习中心'))
  createHostRuntime(fakeCtx(), { vault: fresh })
  const stamped = JSON.parse(readFileSync(join(fresh, '学习中心', 'state', 'learnhub.json'), 'utf8'))
  assert.deepEqual(stamped, { schema: { version: 2, formats: {} } }, '首启 seed 写入 runtime 构造路径（#138）')

  const existing = mkdtempSync(join(tmpdir(), 'learnhub-rt-old-'))
  tmpVaults.push(existing)
  mkdirSync(join(existing, '学习中心', 'state'), { recursive: true })
  const marker = '{"schema":{"version":2,"formats":{}},"marker":"已有库"}'
  writeFileSync(join(existing, '学习中心', 'state', 'learnhub.json'), marker, 'utf8')
  createHostRuntime(fakeCtx(), { vault: existing })
  assert.equal(readFileSync(join(existing, '学习中心', 'state', 'learnhub.json'), 'utf8'), marker, '非新鲜库不重盖戳')
})

test('createHostRuntime：runtime 形状——引擎实例、路径归一、旗标清零、空任务表', () => {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-rt-shape-'))
  tmpVaults.push(vault)
  mkdirSync(join(vault, '学习中心'))
  const rt = createHostRuntime(fakeCtx(), { vault: `${vault}\\`, centerRel: '/学习中心/' })
  assert.ok(rt.engine instanceof LearnhubEngine)
  assert.equal(rt.vault, vault.replace(/\\/g, '/'), 'vault 反斜杠归一、尾分隔符剥掉')
  assert.equal(rt.centerRel, '学习中心', 'centerRel 剥首尾分隔符')
  assert.deepEqual(rt.flags, { queuePaused: false, pumping: false, lastSessionStartAt: 0, genQueueBroken: null })
  assert.equal(rt.jobs.genJobs.size, 0)
  assert.equal(rt.jobs.quizJobResults.size, 0)
})

// ---------------------------------------------------------------- 队列泵状态机

test('队列泵状态机：入队 → 执行 → 终态 done → 保留期清扫出册', async () => {
  const rt = makeRuntime()
  const saved: Array<Array<unknown>> = []
  stubContentPipeline(rt, { saved })
  const r = await enqueueGeneration(rt, fakeCtx(), '数学', '节点A')
  assert.equal(r.queued, true)
  assert.match(r.message, /已入队/)
  const key = '数学/节点A'
  await until(() => rt.jobs.genJobs.get(key)?.status === 'done')
  const job = rt.jobs.genJobs.get(key)!
  assert.match(job.message, /正文完成（1 节）/, '正文完成 + 自动出题的终态消息')
  assert.equal(job.phase, 'quiz', '管线收尾后 phase 停在出题段')
  assert.equal(rt.flags.pumping, false, '跑完释放泵槽（全局单并发闸）')
  assert.ok(saved.length >= 3, `状态变更逐次落盘（实得 ${saved.length} 次快照）`)
  const last = saved.at(-1)![0] as { status: string }
  assert.equal(last.status, 'done', '最后落盘即终态')
  assert.ok(job.finishedAt, '终态盖 finishedAt 戳（保留期起算点落盘，ADR-0039）')

  // 保留期清扫：done 留 30 分钟，超期出册（与恢复侧同一 sweepGenJobs 入口）
  job.finishedAt = new Date(Date.now() - 31 * 60_000).toISOString()
  const swept = await sweepGenJobs(rt)
  assert.equal(swept, 1)
  assert.equal(rt.jobs.genJobs.has(key), false)
})

test('队列泵状态机：running 重复入队拒绝；排队任务可取消（直接出队）', async () => {
  const rt = makeRuntime()
  let releasePack: (() => void) | undefined
  const gate = new Promise<void>(r => { releasePack = r })
  stub(rt, {
    'content2.contentPack': () => gate, // 挂住管线，制造 running 窗口
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  const ctx = fakeCtx()
  await enqueueGeneration(rt, ctx, '数学', '节点A')
  await until(() => rt.jobs.genJobs.get('数学/节点A')?.status === 'running')
  await assert.rejects(() => enqueueGeneration(rt, ctx, '数学', '节点A'), /正在生成中/)
  const cancelled = cancelGeneration(rt, '数学', '节点A')
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.status, 'cancelling', 'running 取消 = 置旗标，runner 下个检查点中止')
  releasePack!()
})

test('队列暂停/恢复：暂停旗标挡泵（入队不开跑），resumeQueue 清旗标并复泵', async () => {
  const rt = makeRuntime()
  const hits = { pack: 0 }
  stubContentPipeline(rt)
  stub(rt, { 'content2.contentPack': async () => { hits.pack++; return '上下文包' } })
  const ctx = fakeCtx()
  rt.flags.queuePaused = true // 重启恢复后的暂停语义（restoreGenJobs 置位，生成页一键恢复）
  await enqueueGeneration(rt, ctx, '数学', '节点B')
  await sleep(50)
  assert.equal(rt.jobs.genJobs.get('数学/节点B')?.status, 'queued', '暂停期间不开跑（不静默烧 token）')
  assert.equal(hits.pack, 0, '泵未触引擎')
  const res = resumeQueue(rt, ctx)
  assert.equal(res.paused, false)
  assert.equal(res.resumed, 1, '恢复时在队任务数')
  await until(() => rt.jobs.genJobs.get('数学/节点B')?.status === 'done')
  assert.ok(hits.pack > 0, '恢复后泵跑完管线')
})

test('保留期定时器：delayMs 到点出册（恢复侧按剩余保留期补挂的同语义）', async () => {
  const rt = makeRuntime()
  stub(rt, { saveGenJobs: async () => undefined })
  rt.jobs.genJobs.set('数学/节点D', {
    course: '数学', node: '节点D', startedAt: new Date().toISOString(), status: 'failed',
  })
  scheduleJobRetention(rt, '数学/节点D', 'failed', 30)
  assert.ok(rt.jobs.genJobs.get('数学/节点D')?.finishedAt, '终态进入时盖 finishedAt')
  await until(() => !rt.jobs.genJobs.has('数学/节点D'), 2000)
})

test('泵直驱：未暂停但有排队任务时 pumpGeneration 拉起执行（恢复语义的底层出口）', async () => {
  const rt = makeRuntime()
  stubContentPipeline(rt)
  const ctx = fakeCtx()
  // 绕过 enqueue 的自动泵：手工置排队任务后直驱泵（等价 resumeQueue 的复泵动作）
  rt.jobs.genJobs.set('数学/节点C', {
    course: '数学', node: '节点C', startedAt: new Date().toISOString(), status: 'queued',
    model: 'test', message: '排队等待生成…',
  })
  pumpGeneration(rt, ctx)
  await until(() => rt.jobs.genJobs.get('数学/节点C')?.status === 'done')
})

// ---------------------------------------------------------------- 溢出修复阶梯与 continue→partial（#196/#197 ADR-0054）

/** 脚本化 llm 流：stream() 逐次消耗应答脚本（走真实 llmSeamStripped/streamDshTurn 通路，
 * 只是 provider 换成内存生成器）；prompts 捕获每次调用的提示词全文供断言。 */
function scriptedCtx(responses: string[], prompts?: string[]): Context {
  const queue = [...responses]
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* (req: { messages: Array<{ content?: Array<{ text?: string }> }> }) {
        const text = queue.shift() ?? ''
        prompts?.push((req.messages ?? []).map(m => (m.content ?? []).map(c => c.text ?? '').join('')).join('\n'))
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  } as unknown as Context
}

/** 溢出门禁错误（与引擎 sectionApply 同形状：code + 结构化节信息 + 预算）。 */
function overflowErr(sectionId = 's2', title = '演示：溢出节'): Error & { code?: string; sectionId?: string; sectionTitle?: string; wordBudget?: number; wordBlock?: number } {
  const e: Error & { code?: string; sectionId?: string; sectionTitle?: string; wordBudget?: number; wordBlock?: number }
    = new Error(`[section] 「${title}」质检门未过：\n  ✗ 节「${title}」正文过长（约 906 字 > 拒收线 800 字 = 单节预算 400×2；字数按去空白、去公式与可视化/交互块后的正文字数计）：一节 = 学习页 1–2 屏，把内容拆成多个节（管线可自动拆）或压缩文字`)
  e.code = 'GATE_FAILED'
  e.sectionId = sectionId
  e.sectionTitle = title
  e.wordBudget = 400
  e.wordBlock = 800
  return e
}

// ---------------------------------------------------------------- 大纲回灌修复轮（机器块串味 → 解析反馈）

test('大纲解析失败 → 恰一回灌重产（解析反馈）、大纲用裁剪包，重产通过终态 done', async () => {
  const rt = makeRuntime()
  const prompts: string[] = []
  const packCalls: Array<Record<string, unknown> | undefined> = []
  let outlineCalls = 0
  let views: Array<Record<string, unknown>> = []
  stub(rt, {
    'content2.contentPack': async (_c: unknown, _n: unknown, opts?: Record<string, unknown>) => {
      packCalls.push(opts)
      return '上下文包'
    },
    'content2.contentTierOf': async () => 1,
    'content2.loadPrompt': async (kind: string) => `TPL:${kind}`,
    'content2.contentSectionsView': async () => views,
    'content2.contentOutline': async (_c: unknown, _n: unknown, _yaml: string) => {
      outlineCalls++
      if (outlineCalls === 1) {
        const e = new Error('模型输出不是合法 YAML：Unexpected scalar at node end at line 33, column 25: <!-- enc_candidates: [] -->')
        ;(e as Error & { code?: string }).code = 'MODEL_YAML'
        throw e
      }
      views = [{ id: 's1', title: '概念：A', type: '概念', status: 'pending', tierLabel: '低' }]
    },
    'content2.contentSection': async () => ({ version: 1, title: 'x', hints: [] }),
    'bank2.questionGenerateSections': async () => ({ added: 2 }),
    'bank2.questionGenerate': async () => ({ added: 3, total: 5, duplicates: [], rejected: [], skipped: [], enc: {} }),
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  // 应答脚本：大纲初跑（机器块串味）→ 回灌重产大纲 → 节正文
  const ctx = scriptedCtx([
    'node: X\nsections:\n  - id: s1\n    title: 概念：A  <!-- enc_candidates: [] -->',
    'node: X\nsections:\n  - id: s1\n    title: 概念：A\n',
    '## 概念：A\n\n正文',
  ], prompts)
  enqueueGeneration(rt, ctx, '数学', '节点A')
  const key = '数学/节点A'
  await until(() => rt.jobs.genJobs.get(key)?.status === 'done')
  const job = rt.jobs.genJobs.get(key)!
  assert.equal(outlineCalls, 2, '初跑解析失败 → 恰一回灌重产一次')
  assert.match(job.message!, /正文完成（1 节）/)
  assert.equal(job.failures, undefined)
  assert.equal(packCalls[0]?.omitDeliverables, undefined, '逐节正文用全量包')
  assert.equal(packCalls[1]?.omitDeliverables, true, '大纲调用用裁剪包（无 §8 交付要求）')
  assert.ok(prompts[1]?.includes('## 解析反馈'), '回灌携带解析反馈段')
  assert.ok(prompts[1]?.includes('MODEL_YAML') || prompts[1]?.includes('enc_candidates'), '回灌携带解析死因原文')
})

test('溢出修复阶梯（ADR-0054）：压缩修复仍超 → 大纲拆节 → 子节照常生成 → done', async () => {
  const rt = makeRuntime()
  const prompts: string[] = []
  const saved: Array<Array<unknown>> = []
  const packCalls: Array<Record<string, unknown> | undefined> = []
  const ready = { id: 's1', title: '概念：已就绪', type: '概念', status: 'ready' }
  const overflow = { id: 's2', title: '演示：溢出节', type: '演示', status: 'pending', tierLabel: '中' }
  const subs = [
    { id: 's2-1', title: '演示：溢出节（上）', type: '演示', status: 'pending', tierLabel: '中' },
    { id: 's2-2', title: '演示：溢出节（下）', type: '演示', status: 'pending', tierLabel: '中' },
  ]
  let views = [ready, overflow]
  let splitRequested = false
  stub(rt, {
    'content2.contentPack': async (_c: unknown, _n: unknown, opts?: Record<string, unknown>) => {
      packCalls.push(opts)
      return '上下文包'
    },
    'content2.contentTierOf': async () => 2,
    'content2.loadPrompt': async (kind: string) => `TPL:${kind}`,
    'content2.contentSectionsView': async () => views,
    'content2.contentSection': async (_c: unknown, _n: unknown, sectionId: string) => {
      if (sectionId === 's2') throw overflowErr()
      return { version: 1, title: 'x', hints: [] }
    },
    'content2.contentSplit': async (_c: unknown, _n: unknown, sectionId: string) => {
      splitRequested = true
      assert.equal(sectionId, 's2')
      views = [ready, ...subs]
      return subs
    },
    'bank2.questionGenerateSections': async () => ({ added: 2 }),
    'bank2.questionGenerate': async () => ({ added: 3, total: 5, duplicates: [], rejected: [], skipped: [], enc: {} }),
    saveGenJobs: async (jobs: Array<unknown>) => { saved.push(jobs) },
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  // 应答脚本：s2 初跑 → s2 压缩修复 → 拆节 YAML → 两个子节
  const ctx = scriptedCtx([
    '初跑正文', '压缩后正文',
    'sections:\n  - title: 演示：溢出节（上）\n    type: 演示\n  - title: 演示：溢出节（下）\n    type: 演示\n',
    '子节一', '子节二',
  ], prompts)
  await enqueueGeneration(rt, ctx, '数学', '节点A')
  const key = '数学/节点A'
  await until(() => rt.jobs.genJobs.get(key)?.status === 'done')
  const job = rt.jobs.genJobs.get(key)!
  assert.equal(splitRequested, true, '压缩修复仍溢出触发大纲拆节')
  assert.match(job.message!, /正文完成（3 节）/, '拆节后总节数进进度，全部就绪终态 done')
  assert.equal(job.failures, undefined)
  assert.ok(prompts.some(p => p.includes('TPL:课程节拆分')), '拆节走专用提示词模板')
  assert.ok(prompts.some(p => p.includes('压缩到 ≤ 400 字')), '修复轮直说压缩目标（预算取自门禁错误的结构化字段）')
  assert.equal(packCalls.at(-1)?.omitDeliverables, true, '拆节自取裁剪包（机器块指令不进拆节 YAML 调用）')
  assert.equal(packCalls[0]?.omitDeliverables, undefined, '逐节正文照旧全量包')
  const last = saved.at(-1)![0] as { status: string }
  assert.equal(last.status, 'done')
})

test('拆节被护栏拒绝（MAX_SECTIONS）→ 失败节记录、余节照常、终态 partial', async () => {
  const rt = makeRuntime()
  const ready = { id: 's1', title: '概念：已就绪', type: '概念', status: 'ready' }
  const overflow = { id: 's2', title: '演示：溢出节', type: '演示', status: 'pending', tierLabel: '中' }
  const normal = { id: 's3', title: '概念：正常节', type: '概念', status: 'pending', tierLabel: '中' }
  let views = [ready, overflow, normal]
  stub(rt, {
    'content2.contentPack': async () => '上下文包',
    'content2.contentTierOf': async () => 2,
    'content2.loadPrompt': async (kind: string) => `TPL:${kind}`,
    'content2.contentSectionsView': async () => views,
    'content2.contentSection': async (_c: unknown, _n: unknown, sectionId: string) => {
      if (sectionId === 's2') throw overflowErr('s2')
      return { version: 1, title: 'x', hints: [] }
    },
    'content2.contentSplit': async () => {
      throw new Error('[split] 拆后总节数 9 超过上限 8——不拆，按失败节处理。')
    },
    'bank2.questionGenerateSections': async () => ({ added: 2 }),
    'bank2.questionGenerate': async () => ({ added: 3, total: 5, duplicates: [], rejected: [], skipped: [], enc: {} }),
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  const ctx = scriptedCtx([
    '初跑正文', '压缩后正文',
    'sections:\n  - title: 演示：溢出节（上）\n    type: 演示\n  - title: 演示：溢出节（下）\n    type: 演示\n',
    '正常节正文',
  ])
  await enqueueGeneration(rt, ctx, '数学', '节点B')
  const key = '数学/节点B'
  await until(() => rt.jobs.genJobs.get(key)?.status === 'partial')
  const job = rt.jobs.genJobs.get(key)!
  assert.match(job.message!, /正文部分完成（2\/3 节；未完成：「演示：溢出节」——/)
  assert.match(job.message!, /可「重试续跑」或定点重写/)
  assert.equal(job.failures?.length, 1)
  assert.equal(job.failures?.[0]!.sectionId, 's2')
  assert.match(job.failures?.[0]!.finding ?? '', /拆后总节数 9 超过上限 8/, '死因如实记录：护栏拒拆而非溢出本身')
})

test('continue→partial（ADR-0054）：单节非溢出失败不中止余节，失败清单随终态落盘', async () => {
  const rt = makeRuntime()
  const saved: Array<Array<unknown>> = []
  const ready = { id: 's0', title: '概念：已就绪', type: '概念', status: 'ready' }
  const s1 = { id: 's1', title: '概念：坏节', type: '概念', status: 'pending', tierLabel: '中' }
  const s2 = { id: 's2', title: '概念：好节', type: '概念', status: 'pending', tierLabel: '中' }
  stub(rt, {
    'content2.contentPack': async () => '上下文包',
    'content2.contentTierOf': async () => 2,
    'content2.loadPrompt': async (kind: string) => `TPL:${kind}`,
    'content2.contentSectionsView': async () => [ready, s1, s2],
    'content2.contentSection': async (_c: unknown, _n: unknown, sectionId: string) => {
      if (sectionId === 's1') throw new Error('[section] 模型产出解析失败（示例死因）')
      return { version: 1, title: 'x', hints: [] }
    },
    'bank2.questionGenerateSections': async () => ({ added: 2 }),
    'bank2.questionGenerate': async () => ({ added: 3, total: 5, duplicates: [], rejected: [], skipped: [], enc: {} }),
    saveGenJobs: async (jobs: Array<unknown>) => { saved.push(jobs) },
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  const ctx = scriptedCtx(['坏节正文', '好节正文'])
  await enqueueGeneration(rt, ctx, '数学', '节点E')
  const key = '数学/节点E'
  await until(() => rt.jobs.genJobs.get(key)?.status === 'partial')
  const job = rt.jobs.genJobs.get(key)!
  assert.match(job.message!, /正文部分完成（2\/3 节；未完成：「概念：坏节」——/)
  assert.equal(job.failures?.length, 1)
  assert.equal(job.failures?.[0]!.code, 'ERROR')
  assert.equal(job.failures?.[0]!.sectionId, 's1')
  const last = saved.at(-1)![0] as { failures?: Array<{ sectionId?: string }> }
  assert.equal(last.failures?.[0]!.sectionId, 's1', '失败清单随任务记录落盘（恢复/重启后横幅仍可消费）')
})


// ---------------------------------------------------------------- quizJobResults 等待语义

test('等待语义：入队 + 等终态 + 结果表读取（agent 工具同步语义）', async () => {
  const rt = makeRuntime()
  stub(rt, {
    'bank2.questionGenerate': async () => ({ added: 4, total: 4, duplicates: [], rejected: [], skipped: [], enc: {} }),
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  const enq = enqueueQuizGeneration(rt, fakeCtx(), '数学', '节点C', { count: 4 })
  assert.equal(enq.queued, true)
  const job = await waitForGenJob(rt, enq.key)
  assert.equal(job.status, 'done')
  assert.match(job.message, /出题完成：新增 4 道（题库共 4）/)
  assert.equal(rt.jobs.quizJobResults.get(enq.key)?.added, 4, '完整结果暂存结果表供工具读取')
  rt.jobs.quizJobResults.delete(enq.key) // 工具读取后即删（learnhub_question_generate 的语义）
})

test('等待语义：超时与注册表消失 fail loud', async () => {
  const rt = makeRuntime()
  stub(rt, { saveGenJobs: async () => undefined })
  rt.flags.queuePaused = true
  enqueueQuizGeneration(rt, fakeCtx(), '数学', '节点E', {})
  await assert.rejects(waitForGenJob(rt, '数学/节点E', 50), /等待生成任务超时/)
  await assert.rejects(waitForGenJob(rt, '数学/没有这个节点', 50), /已从注册表消失/)
})

// ---------------------------------------------------------------- 生长批失败终态与重试（#157）

test('生长批任务消息带回路轨迹（#163）：生成页可查裁决前查了哪些只读视图', async () => {
  const rt = makeRuntime()
  stub(rt, {
    'growth2.coachGrowthBatch': async () => ({
      course: '数学', state: 'applied',
      check: { course: '数学', ready: 0, depth: 3, required: 3, cold_start: false, ok: false, exhausted: false, warnings: [] },
      segments: [{ tier: 'light', effort: 'fast', operator: '前进', disagreement: false }],
      trajectory: ['[轻量段] graph_view(2 字符参数) → 412 字符', '[轻量段] concept_registry(15 字符参数) → 88 字符'],
      proposal: { id: 9, ops: 1, operator: '前进', reason: '前沿缺下一台阶', disagreement: false },
      applied: { ops: 1, snapshot: 3, compass_rewritten: true, created: [], ready_unbuilt: [] },
    }),
    'registry.get': async () => ({ name: '数学' }),
    loadView: async () => ({ graph: { nset: new Set(['生长批']) } }),
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  const enq = enqueueGrowthBatch(rt, fakeCtx(), '数学', '测试触发')
  assert.equal(enq.queued, true)
  await until(() => rt.jobs.genJobs.get('数学/生长批')?.status === 'done')
  const msg = rt.jobs.genJobs.get('数学/生长批')!.message ?? ''
  assert.match(msg, /回路轨迹：\[轻量段\] graph_view/, '轨迹带段前缀进任务消息')
  assert.match(msg, /concept_registry/, '逐条工具轨迹可查')
})

test('生长批失败终态：教练回合抛错 → failed 带死因；自动触点阻尼不重拉、force（重试）豁免', async () => {
  const rt = makeRuntime()
  const ctx = fakeCtx()
  let calls = 0
  stub(rt, {
    'growth2.coachGrowthBatch': async () => {
      calls++
      throw new Error('[coach-growth] 生长批受理门拒收（回灌重裁一轮仍未过——零落盘）。\n【首轮】…区不存在: 幻区…\n【重裁】…')
    },
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  const key = '数学/生长批'
  const enq = enqueueGrowthBatch(rt, ctx, '数学', '测试触发')
  assert.equal(enq.queued, true)
  await until(() => rt.jobs.genJobs.get(key)?.status === 'failed')
  assert.match(rt.jobs.genJobs.get(key)!.message ?? '', /受理门拒收/, '失败消息带死因（通知与生成页可读）')
  assert.ok(rt.jobs.genJobs.get(key)!.finishedAt, '终态盖戳（保留期起算点）')

  // 阻尼不回归（AC：失败不自动重拉）：自动触点（无 force）被拒，教练回合不被拉起
  const blocked = enqueueGrowthBatch(rt, ctx, '数学', '再次自动触发')
  assert.equal(blocked.queued, false)
  assert.match(blocked.message, /不自动重试/)
  assert.equal(calls, 1)

  // force（面板「生长一步」/失败通知「重试」）= 显式重新裁决：豁免失败阻尼重新入队
  const retried = enqueueGrowthBatch(rt, ctx, '数学', '面板下发（显式重新裁决）', undefined, { force: true })
  assert.equal(retried.queued, true, '显式重试重新入队')
  await until(() => rt.jobs.genJobs.get(key)?.status === 'failed' && (calls === 2))
})

test('生长批停摆终态（#161）：就绪深度满足 → done 带中性说明（非成功样式）+ growthOutcome=idle 供通知分流', async () => {
  const rt = makeRuntime()
  stub(rt, {
    'growth2.coachGrowthBatch': async () => ({
      course: '数学', state: 'idle',
      check: { course: '数学', ready: 3, depth: 3, required: 3, cold_start: false, ok: true, exhausted: false, warnings: [] },
      segments: [], proposal: null, applied: null,
    }),
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  const enq = enqueueGrowthBatch(rt, fakeCtx(), '数学', 'queue_idle 触发', undefined, { force: true })
  assert.equal(enq.queued, true)
  await until(() => rt.jobs.genJobs.get('数学/生长批')?.status === 'done')
  const job = rt.jobs.genJobs.get('数学/生长批')!
  assert.equal(job.growthOutcome, 'idle', '裁决面落档：面板通知据此走中性说明而非绿色成功')
  assert.match(job.message ?? '', /教练判断暂不需长新内容（就绪 3\/3）/, '停摆文案是中性说明（#161 验收口径）')
  assert.ok(job.finishedAt, '终态盖戳（保留期起算点）')
})

test('生长批已取消：明确的中止意图不被 force 豁免（重试只属于失败批）', async () => {
  const rt = makeRuntime()
  stub(rt, {
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  rt.jobs.genJobs.set('数学/生长批', {
    course: '数学', node: '生长批', startedAt: new Date().toISOString(),
    status: 'cancelled', finishedAt: new Date().toISOString(), message: '已被取消',
  })
  for (const opts of [{}, { force: true }]) {
    const r = enqueueGrowthBatch(rt, fakeCtx(), '数学', '测试触发', undefined, opts)
    assert.equal(r.queued, false)
    assert.match(r.message, /已取消/)
  }
})

// ---------------------------------------------------------------- 重启负载恢复（#157）

test('重启恢复：排队图域任务负载随档恢复，恢复队列后正常执行；生长批裁决面随档保留', async () => {
  const rt = makeRuntime()
  const seedCalls: Array<Record<string, unknown>> = []
  const savedPhases: Array<Record<string, unknown>[]> = []
  stub(rt, {
    'graph.seedPropose': async (req: Record<string, unknown>) => {
      seedCalls.push(req)
      return { id: 7, starts: 1, endpoint: '终点', prior_hits: 0 }
    },
    saveGenJobs: async (jobs: Array<Record<string, unknown>>) => { savedPhases.push(jobs) },
    loadGenJobs: async () => [
      { course: '数学', node: '种子起草', startedAt: new Date().toISOString(), status: 'queued',
        phase: '种子', model: 'test', message: '排队等待生成队列…',
        seedPayload: { goal: '会用导数解决优化问题', mode: 'new', goalType: 'capability', useVaultPrior: false, worksheet: [{ block: '会求导' }] } },
      { course: '物理', node: '生长批', startedAt: new Date().toISOString(), status: 'done',
        phase: '生长', finishedAt: new Date().toISOString(), growthOutcome: 'idle',
        model: 'test', message: '就绪深度满足——教练停摆，无批可产。' },
    ],
    // 恢复清扫的存在性探针（真实注册表为空会把恢复记录判悬空清掉）
    'registry.get': async (key: string) => ({ name: key }),
    loadView: async () => ({ graph: { nset: new Set<string>() } }),
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  restoreGenJobs(rt)
  await until(() => rt.jobs.genJobs.get('数学/种子起草')?.status === 'queued')
  assert.equal(rt.flags.queuePaused, true, '恢复后队列暂停（不自动开跑，生成页一键恢复）')
  // 生长批上一轮裁决面随档恢复：重拉阻尼的判据（恢复丢失 = 停摆裁决被无声抹掉）
  assert.equal(rt.jobs.genJobs.get('物理/生长批')?.growthOutcome, 'idle')
  const blocked = enqueueGrowthBatch(rt, fakeCtx(), '物理', '自动触发')
  assert.equal(blocked.queued, false, '恢复后的 idle 裁决照常阻尼自动重拉')

  const res = resumeQueue(rt, fakeCtx())
  assert.equal(res.resumed, 1)
  await until(() => rt.jobs.genJobs.get('数学/种子起草')?.status === 'done')
  assert.match(rt.jobs.genJobs.get('数学/种子起草')!.message ?? '', /种子提案 #7/)
  assert.equal(seedCalls.length, 1)
  assert.equal(seedCalls[0]!.goal, '会用导数解决优化问题', '负载随档恢复：表单字段原样进引擎')
  // #185 落盘即归一：读侧别名只在恢复缝生效，写侧（含执行过程中的持久化）一律产现值
  assert.ok(savedPhases.length > 0, '执行过程至少落盘一次')
  const persistedSeed = savedPhases.at(-1)!.find(j => j.course === '数学')
  assert.equal(persistedSeed?.phase, 'seed', '旧档 phase=种子 经恢复归一后落盘为现值')
})

test('重启恢复：负载要求的排队图域任务缺负载 → 恢复处明确标失败可重试（不拖到执行器）', async () => {
  const rt = makeRuntime()
  let executed = false
  stub(rt, {
    seedPropose: async () => { executed = true; return { id: 1 } },
    saveGenJobs: async () => undefined,
    loadGenJobs: async () => [
      // 旧档案形态：phase=种子 但 payload 缺失（#157 前的注册表会落出这种档）
      { course: '数学', node: '种子起草', startedAt: new Date().toISOString(), status: 'queued',
        phase: '种子', model: 'test', message: '排队等待生成队列…' },
    ],
    // 恢复清扫的存在性探针（真实注册表为空会把恢复记录判悬空清掉）
    'registry.get': async (key: string) => ({ name: key }),
    loadView: async () => ({ graph: { nset: new Set<string>() } }),
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  restoreGenJobs(rt)
  await until(() => rt.jobs.genJobs.get('数学/种子起草')?.status === 'failed')
  const job = rt.jobs.genJobs.get('数学/种子起草')!
  assert.match(job.message ?? '', /负载缺失/, '失败原因可读（不再是执行器抛「负载缺失或 phase 未知」）')
  assert.match(job.message ?? '', /重新下发（可重试）/)
  assert.ok(job.finishedAt, '恢复当下盖终态戳（保留期起算）')
  assert.equal(rt.jobs.genJobs.get('数学/种子起草')?.status, 'failed')
  // 队列不再有排队假象：一键恢复后没有任务可跑，执行器不被触达
  assert.equal(resumeQueue(rt, fakeCtx()).resumed, 0)
  await sleep(30)
  assert.equal(executed, false)
})

// ---------------------------------------------------------------- 任务档 Broken（#194 / ADR-0053）

test('任务档 Broken 启动：队列 broken、生成页可见报错与指引、入队/开跑被拒且坏档字节原样保留', async () => {
  const rt = makeRuntime()
  // 真引擎真档：写坏任务档后 restoreGenJobs 走真实 loadGenJobs（真 vault 无需打桩）
  const genJobsPath = rt.engine.paths.genJobsPath
  const corrupt = '{oops 不是合法 JSON'
  writeFileSync(genJobsPath, corrupt, 'utf8')
  restoreGenJobs(rt)
  await until(() => rt.flags.genQueueBroken !== null)
  assert.match(rt.flags.genQueueBroken!, /\[gen-jobs\] .+生成任务\.json 不是合法 JSON（Broken）：修复或删除该文件后重启宿主再试/)

  // 生成页可见报错与修复指引（generationStatus 透传 broken 文案）
  const status = await generationStatus(rt)
  assert.equal(status.broken, rt.flags.genQueueBroken)

  // 入队四口 + 整课重置全部被拒，提示先修复
  await assert.rejects(() => enqueueGeneration(rt, fakeCtx(), '数学', '节点A'), /broken 态，已拒绝该操作/)
  assert.throws(() => enqueueQuizGeneration(rt, fakeCtx(), '数学', '节点A'), /broken 态/)
  assert.throws(() => enqueueGrowthBatch(rt, fakeCtx(), '数学', '测试'), /broken 态/)
  assert.throws(() => enqueueGraphJob(rt, fakeCtx(), { course: '数学', node: '罗盘', phase: 'compass' }), /broken 态/)
  await assert.rejects(() => resetCourseChain(rt, fakeCtx(), '数学'), /broken 态/)
  // 开跑被拒：恢复队列拒绝（泵闸静默，交互口给文案）
  assert.throws(() => resumeQueue(rt, fakeCtx()), /broken 态/)

  // 坏档字节原样保留（防下一次入队把坏档全量覆盖，静默销毁现场）
  assert.equal(readFileSync(genJobsPath, 'utf8'), corrupt)
  // 宿主其余功能不受影响：任务注册表照常可读、无可跑任务假象
  assert.equal(status.jobs.length, 0)
})

test('任务档修复后重启：broken 清空，既有恢复语义零回归（中断标失败、队列暂停旗标）', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-rt-'))
  tmpVaults.push(vault)
  mkdirSync(join(vault, '学习中心'))
  const build = () => createHostRuntime(fakeCtx(), { vault, centerRel: '学习中心' })
  const rt = build()
  writeFileSync(rt.engine.paths.genJobsPath, '{oops', 'utf8')
  restoreGenJobs(rt)
  await until(() => rt.flags.genQueueBroken !== null)

  // 修档（重写合法注册表，带一条重启时 running 的中断任务）→ 重启 = 新 runtime
  writeFileSync(rt.engine.paths.genJobsPath, JSON.stringify([
    { course: '数学', node: '节点A', startedAt: new Date().toISOString(), status: 'running', model: 'test' },
  ]), 'utf8')
  const rt2 = build()
  assert.equal(rt2.flags.genQueueBroken, null, '新进程 broken 态从零开始')
  stub(rt2, {
    'registry.get': async (key: string) => ({ name: key }),
    loadView: async () => ({ graph: { nset: new Set(['节点A']) } }),
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  restoreGenJobs(rt2)
  await until(() => rt2.jobs.genJobs.get('数学/节点A')?.status === 'failed')
  assert.match(rt2.jobs.genJobs.get('数学/节点A')!.message ?? '', /进程重启，任务中断/)
  assert.equal(rt2.flags.genQueueBroken, null, '恢复成功不置 broken')
  const status = await generationStatus(rt2)
  assert.equal(status.broken, null)
})

test('broken 态清扫跳过：内存态不动、不落盘（清扫延后到修档重启；apply 出口不被牵连）', async () => {
  const rt = makeRuntime()
  rt.flags.genQueueBroken = '任务档损坏（测试注入）'
  // 一条本应被清扫的悬空记录（课程缺失 → dangling）+ 破坏性 saveGenJobs 桩
  rt.jobs.genJobs.set('已删课/节点A', {
    course: '已删课', node: '节点A', startedAt: new Date().toISOString(), status: 'cancelled',
  } as never)
  stub(rt, {
    'registry.get': async () => null,
    loadView: async () => ({ graph: { nset: new Set<string>() } }),
    saveGenJobs: async () => { throw new Error('broken 期间不得落盘') },
  })
  assert.equal(await sweepGenJobs(rt), 0, 'broken 期间清扫拒绝')
  assert.ok(rt.jobs.genJobs.has('已删课/节点A'), '注册表内存态不动')
})

test('loadGenJobs 读错误（非 ENOENT）= Broken：不静默回空表——防权限/锁档被下一次入队覆盖', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-rt-'))
  tmpVaults.push(vault)
  mkdirSync(join(vault, '学习中心'))
  mkdirSync(join(vault, '学习中心', 'state'))
  // 直构引擎要自备 v2 盖戳（createHostRuntime 的出生盖戳逻辑不经过这条路）
  writeFileSync(join(vault, '学习中心', 'state', 'learnhub.json'),
    JSON.stringify({ schema: { version: 2, formats: {} } }, null, 1) + '\n', 'utf8')
  const base = nodeVaultFs
  const engine = new LearnhubEngine({
    vault, centerRel: '学习中心', clock: systemClock, rng: mathRng,
    fs: {
      ...base,
      readFile: async (p: string) => {
        if (p.endsWith('生成任务.json')) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        return base.readFile(p)
      },
    },
  })
  await assert.rejects(() => engine.loadGenJobs(), /\[gen-jobs\] .+生成任务\.json 不可读（Broken）/)
})

// ---------------------------------------------------------------- 路由分发（static 抽离后行为不变）

/** 假 res：捕获状态码/头/体（handleApi 只用到 writeHead 与 end）。 */
function fakeRes() {
  const out = { code: 0, headers: {} as Record<string, string>, body: '' }
  return {
    out,
    writeHead: (code: number, headers: Record<string, string> = {}) => { out.code = code; out.headers = headers },
    end: (data?: unknown) => { out.body = data === undefined ? '' : String(data) },
  }
}

/** 假 req：GET 只需 method/url（handleApi 对 GET 不读体）；POST 需异步可迭代体（readJson 消费）。 */
const get = (url: string) => ({ method: 'GET', url }) as unknown as IncomingMessage
const post = (url: string, body: unknown) => ({
  method: 'POST', url,
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
}) as unknown as IncomingMessage

test('路由分发：未知路由 404 带方法与前缀后的路由名（未命中行为）', async () => {
  const rt = makeRuntime()
  stub(rt, { saveGenJobs: async () => undefined })
  for (const req of [get('/learnhub/api/nope'), post('/learnhub/api/nope', {})]) {
    const res = fakeRes()
    await handleApi(rt, fakeCtx(), req, res as never)
    assert.equal(res.out.code, 404)
    assert.deepEqual(JSON.parse(res.out.body), { error: `unknown route: ${req.method} /nope` })
  }
})

test('路由分发：/agent-guide 直接回 AGENT_GUIDE 常量（不触引擎）', async () => {
  const rt = makeRuntime()
  const res = fakeRes()
  await handleApi(rt, fakeCtx(), get('/learnhub/api/agent-guide'), res as never)
  assert.equal(res.out.code, 200)
  assert.equal(res.out.headers['cache-control'], 'no-store')
  const body = JSON.parse(res.out.body) as Array<{ tool: string }>
  assert.ok(Array.isArray(body) && body.length > 0)
  assert.ok(body.some(e => e.tool === 'learnhub_pin_today'), 'AGENT_GUIDE 单源（tools.ts）')
})

test('路由分发：GET /status 附 llm 配置视图（模型透明；会话开始触点节流不挡响应）', async () => {
  const rt = makeRuntime()
  stub(rt, {
    statusJson: async () => ({ ok: true }),
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
  })
  const res = fakeRes()
  await handleApi(rt, fakeCtx(), get('/learnhub/api/status'), res as never)
  assert.equal(res.out.code, 200)
  const body = JSON.parse(res.out.body) as { ok: boolean; llm: { provider: string; model: string } }
  assert.equal(body.ok, true)
  assert.equal(typeof body.llm.provider, 'string')
  assert.equal(typeof body.llm.model, 'string')
})

test('路由分发：static 抽离后 /file、/vendor、/interactive 的守卫行为逐字不变', async () => {
  const rt = makeRuntime()
  const cases: Array<{ url: string; error: RegExp }> = [
    { url: '/learnhub/api/file', error: /缺少必填参数：path（路由 GET \/file）/ },
    { url: '/learnhub/api/file?path=../../etc/passwd', error: /path traversal rejected/ },
    { url: '/learnhub/api/file?path=课程/图.exe', error: /unsupported file type: \.exe/ },
    { url: '/learnhub/api/vendor/', error: /path traversal rejected/ },
    { url: '/learnhub/api/vendor/katex/katex.exe', error: /unsupported vendor file type: \.exe/ },
    { url: '/learnhub/api/interactive', error: /缺少必填参数：path（路由 GET \/interactive）/ },
    { url: '/learnhub/api/interactive?path=../x.html', error: /path traversal rejected/ },
  ]
  for (const c of cases) {
    const res = fakeRes()
    await handleApi(rt, fakeCtx(), get(c.url), res as never)
    assert.equal(res.out.code, 500, `${c.url} 应走 500（路由抛错 → 统一 catch）`)
    assert.match(String((JSON.parse(res.out.body) as { error: string }).error), c.error, c.url)
  }
  // POST 分支仍按 body 校验参数（need 的 400 语义经统一 catch 出口）
  const res = fakeRes()
  await handleApi(rt, fakeCtx(), post('/learnhub/api/generate', {}), res as never)
  assert.equal(res.out.code, 500)
  assert.match(String((JSON.parse(res.out.body) as { error: string }).error), /缺少必填参数：course（路由 POST \/generate）/)
})

// ---------------------------------------------------------------- 工具面快照 + 路由↔工具对账

test('工具面快照：112 个工具的名称/描述/schema 与重构前基线逐字不变（#203 +1）', () => {
  const rt = makeRuntime()
  const captured: Array<{ name?: string; description?: string; parameters?: unknown; output?: unknown }> = []
  registerTools(fakeCtx(captured), rt)
  assert.equal(captured.length, 112, '工具总数不变（注册顺序按域分组重排，逐工具逐字不变；#203 +1 receipt_review_mode）')
  const snapshot = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'host-tools-snapshot.json'), 'utf8')) as
    Array<{ name: string; description: string; parameters: unknown }>
  assert.equal(snapshot.length, 112)
  const byName = new Map(captured.map(t => [t.name, t]))
  assert.equal(byName.size, 112, '工具名无重复')
  for (const expect of snapshot) {
    const got = byName.get(expect.name)
    assert.ok(got, `缺工具 ${expect.name}`)
    assert.deepEqual(
      { description: got.description, parameters: got.parameters },
      { description: expect.description, parameters: expect.parameters },
      `工具 ${expect.name} 的描述/schema 相对重构前基线漂移`,
    )
  }
  // output 描述符是工具契约的另一半：111 个共享同一 textOutput（render 把值包成 text 块）
  for (const t of captured) {
    const out = t.output as { schema?: { type?: string }; render?: (a: unknown, v: unknown) => unknown } | undefined
    assert.equal(out?.schema?.type, 'string', `${t.name} 的 output schema 漂移`)
    assert.deepEqual(out?.render?.(undefined, 'x'), [{ type: 'text', text: 'x' }], `${t.name} 的 output render 漂移`)
  }
})

test('AGENT_GUIDE 受检投影：22 条指南的工具名/页签/文案都在册（ADR-0045 的受检投影·前半）', () => {
  // ADR-0045 记：「AGENT_GUIDE（22 条手写）从未与 111 个工具对账过」。后半（「通道分类与该
  // 命令一致」）要等注册表落地才能断言；前半（工具名 ∈ 工具面）今天就能钉住。
  const rt = makeRuntime()
  const captured: Array<{ name?: string }> = []
  registerTools(fakeCtx(captured), rt)
  const toolNames = new Set(captured.map(t => t.name))
  // 面板页签词表（tools.ts 的 AGENT_GUIDE 头注释）：page 只准取这几个
  const pages = new Set(['learn', 'graph', 'bank', 'stats', 'lab', 'generate', 'practice', 'projects', 'global'])
  const seen = new Set<string>()
  for (const g of AGENT_GUIDE) {
    assert.ok(toolNames.has(g.tool), `指南里的 ${g.tool} 不在工具面（${toolNames.size} 个工具）——分流纪律的受检投影断了`)
    assert.ok(pages.has(g.page), `指南页签非法：${g.page}`)
    assert.ok(g.text.trim() && (g.prompt ?? '').trim(), `${g.tool} 的文案/prompt 为空（指南是教学性文字，不许留空）`)
    assert.ok(!seen.has(g.tool), `指南重复条目：${g.tool}`)
    seen.add(g.tool)
  }
  assert.equal(AGENT_GUIDE.length, 23, '指南条目数（22 条手写 + #203 receipt-review-mode，增减要显式）')
})

test('路由↔工具对账基线：86 共享引擎入口、工具独有 25、路由独有 49（终态点路径口径；ADR-0045 迁移回归网）', () => {
  // 与注册表 engine 字段同口径——改名转发按真名（registry.get/resolve）入账。
  const faceOf = (code: string) => new Set([...code.matchAll(/\.engine\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)].map(m => m[1]))
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
  // 工具面 = tools.ts；路由面 = 其余宿主技术层（与基线口径一致：工具注册区 vs 工具区外全部）。
  // **动态发现**（#168：路由表拆成 route-table/routes/routes-post 后，硬编码清单会让
  // 新文件静默逃出对账网——正是 R3「收集器收空」的同族缺陷）
  const hostFiles = readdirSync(join(ROOT, 'src', 'host'))
    .filter(f => f.endsWith('.ts') && f !== 'tools.ts' && f !== 'tool-handlers.ts').sort()
  assert.ok(hostFiles.length >= 8, `路由面受控文件只剩 ${hostFiles.length} 个（扫描面塌了）`)
  // #169：两面都改成「源码直调 ∪ 注册表声明」——生成路径的调用住在声明里（src/commands/），
  // 源码里只剩例外 handler（host/tool-handlers.ts、host/handlers.ts）
  const agentDeclared = new Set(COMMAND_LIST.filter(c => c.channels.some(ch => ch.tool))
    .map(c => c.engine).filter((e): e is string => !!e))
  const toolFace = new Set([...faceOf(read('src/host/tools.ts') + read('src/host/tool-handlers.ts')), ...agentDeclared])
  // #169：路由面的引擎入口 = **注册表 panel 通道的声明** ∪ 宿主源码里的直调。生成路径的调用
  // 现在住在声明里（src/commands/），不在任何 .ts 文件里——只扫源码会让大部分 route-only 凭空消失。
  const declared = new Set(COMMAND_LIST.filter(c => c.channels.some(ch => ch.route))
    .map(c => c.engine).filter((e): e is string => !!e))
  const routeFace = new Set([...faceOf([...hostFiles.map(f => `src/host/${f}`), 'src/index.ts'].map(read).join('\n')), ...declared])
  const base = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'host-face-baseline.json'), 'utf8')) as {
    shared: string[]; toolOnly: string[]; routeOnly: string[]
  }
  const shared = [...toolFace].filter(x => routeFace.has(x)).sort()
  const toolOnly = [...toolFace].filter(x => !routeFace.has(x)).sort()
  const routeOnly = [...routeFace].filter(x => !toolFace.has(x)).sort()
  assert.deepEqual(shared, base.shared, '两面共享的引擎入口集漂移')
  assert.deepEqual(toolOnly, base.toolOnly, '工具独有引擎入口集漂移')
  assert.deepEqual(routeOnly, base.routeOnly, '路由独有引擎入口集漂移')
  // #163：罗盘重画 agent 工具改走生成队列（回路只在队列任务内运行），registry.resolve
  // 进工具面 → 86 共享／路由独有 49（#156 已把工具面一条入口收编共享：25/49；
  // #196/#197 拆节 op content2.contentSplit 仅路由面管线消费 → 25/50；
  // #199 生成门 enqueueGeneration 经 paths.anchorPath 读锚拒终点 → 25/51）
  assert.equal(shared.length, 86)
  assert.equal(toolOnly.length, 27, '#203 +2：lab.receiptReviewMode / lab.setReceiptReviewMode（工具面直调，无 panel 路由）')
  assert.equal(routeOnly.length, 51)
})

// ---------------------------------------------------------------- 种子应用 → 起点正文自动入队（#160）

/** 种子 apply 的返回形状（GraphApplySeedResult 的宿主消费面）+ 镜像生长批的取数桩：
 * 起点A 正文未生成（要入队）、起点B 正文已就绪（不入队）；loadView 同时供
 * sweepGenJobs（nset）与 triggerSeedContent（state）消费。 */
function stubSeedApply(rt: HostRuntime, opts: { applied?: Record<string, unknown> } = {}): void {
  stubContentPipeline(rt)
  stub(rt, {
    'graph.proposalApply': async () => opts.applied ?? {
      course: '数学', mode: 'new', goal_type: 'capability', endpoint: '终点',
      starts: ['起点A', '起点B'], declared: '2026-09-12', regions: [], snapshot: 1,
      created_blocks: [], compass: { state: 'scaffold', annotations_preserved: false },
      prior_feed: { unresponded: 0 }, findings: [],
    },
    'registry.get': async () => ({ name: '数学' }),
    'registry.resolve': async () => ({ name: '数学', root: '数学' }),
    loadView: async () => ({
      graph: { nset: new Set(['起点A', '起点B', '终点']) },
      state: {
        起点A: {},
        起点B: { content: { sections: [{ id: 's1', status: 'ready' }] } },
      },
    }),
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
}

test('种子应用 → 起点正文自动入队（#160）：路由出口入队「正文未生成」的起点，生成页可见', async () => {
  const rt = makeRuntime()
  stubSeedApply(rt)
  const res = fakeRes()
  await handleApi(rt, fakeCtx(), post('/learnhub/api/proposals/apply', { kind: 'seed', id: 3 }), res as never)
  assert.equal(res.out.code, 200)
  // 起点A（正文未生成）已入队；起点B（正文已就绪）不入队；队列泵把它跑完 = 全链真实
  await until(() => rt.jobs.genJobs.get('数学/起点A')?.status === 'done')
  assert.ok(rt.jobs.genJobs.get('数学/起点B') === undefined, '已就绪起点不重复入队')
  // 幂等：重复触发不产生重复任务——同名键唯一（内容仍未生成时重复触发 = 合法重试路径）
  const r2 = await triggerSeedContent(rt, fakeCtx(), { course: '数学', starts: ['起点A', '起点B'] })
  assert.equal(r2, 1, '实入队数：起点A 重试入队（内容仍未生成）；起点B 已就绪不再入队')
  assert.equal([...rt.jobs.genJobs.values()].filter(j => j.node === '起点A').length, 1, '同名键唯一，不产生第二条任务')
})

test('种子应用幂等与跳过（#160）：排队任务去重不重复入队；同名 running 任务跳过不挡其余起点', async () => {
  const rt = makeRuntime()
  stubSeedApply(rt)
  rt.flags.queuePaused = true // 挡泵：保持 queued 形态供断言
  await triggerSeedContent(rt, fakeCtx(), { course: '数学', starts: ['起点A', '起点B'] })
  assert.equal(rt.jobs.genJobs.get('数学/起点A')?.status, 'queued')
  // 排队中重复触发：enqueueGeneration 走去重分支，不产生第二条记录
  await triggerSeedContent(rt, fakeCtx(), { course: '数学', starts: ['起点A'] })
  assert.equal([...rt.jobs.genJobs.values()].filter(j => j.node === '起点A').length, 1, '排队任务不重复入队')

  // 同名 running：跳过留痕，不挡其余起点（起点C 仍入队；暂停旗标挡泵保形态）
  const rt2 = makeRuntime()
  stubSeedApply(rt2)
  rt2.flags.queuePaused = true
  rt2.jobs.genJobs.set('数学/起点A', {
    course: '数学', node: '起点A', startedAt: new Date().toISOString(), status: 'running',
  })
  stub(rt2, { loadView: async () => ({
    graph: { nset: new Set(['起点A', '起点C', '终点']) },
    state: { 起点A: {}, 起点C: {} },
  }) })
  const queued = await triggerSeedContent(rt2, fakeCtx(), { course: '数学', starts: ['起点A', '起点C'] })
  assert.equal(queued, 1, '返回实入队数：起点C 入队，起点A running 跳过不计入')
  assert.equal(rt2.jobs.genJobs.get('数学/起点A')?.status, 'running', 'running 任务不被覆盖')
  assert.equal(rt2.jobs.genJobs.get('数学/起点C')?.status, 'queued', '其余起点照常入队')
})

test('种子应用与重启暂停语义（#160）：queuePaused 挡泵，起点任务安静排队；resume 才开跑', async () => {
  const rt = makeRuntime()
  stubSeedApply(rt)
  rt.flags.queuePaused = true
  const res = fakeRes()
  await handleApi(rt, fakeCtx(), post('/learnhub/api/proposals/apply', { kind: 'seed', id: 3 }), res as never)
  assert.equal(res.out.code, 200)
  await sleep(30)
  assert.equal(rt.jobs.genJobs.get('数学/起点A')?.status, 'queued', '暂停时入队不开跑（重启暂停语义不回归）')
  resumeQueue(rt, fakeCtx())
  await until(() => rt.jobs.genJobs.get('数学/起点A')?.status === 'done')
})

test('非种子 apply 不触发起点入队（#160 只挂种子出口）', async () => {
  const rt = makeRuntime()
  stub(rt, {
    'graph.proposalApply': async () => ({ kind: 'edit', course: '数学', ops: 1, snapshot: 2, compass_rewritten: true }),
    'registry.get': async () => ({ name: '数学' }),
    loadView: async () => ({ graph: { nset: new Set(['起点A']) }, state: { 起点A: {} } }),
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  const res = fakeRes()
  await handleApi(rt, fakeCtx(), post('/learnhub/api/proposals/apply', { kind: 'edit', id: 5 }), res as never)
  assert.equal(res.out.code, 200)
  assert.equal(rt.jobs.genJobs.size, 0, 'edit 提案 apply 不入队正文')
})

// ---------------------------------------------------------------- 清理

test.after(() => {
  for (const v of tmpVaults) rmSync(v, { recursive: true, force: true })
})
