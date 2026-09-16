/**
 * 观测面扩展 T4（#292 / ADR-0091）：sched/note_source/host 族新接观测点与直调路由
 * apiRun 收编的内存假 logger 断言。事件名/级别/字段以 ADR-0091 登记表为准。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile as writeFileAsync } from 'node:fs/promises'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { enqueueQuizGeneration, sweepGenJobs } from '../src/host/jobs.ts'
import { HANDLERS } from '../src/host/handlers.ts'
import { resolveFsrsParams } from '../src/engine/sched/srs.ts'
import { defaultParams } from '../src/engine/sched/optimize.ts'
import { todayStr } from '../src/engine/dates.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { withVault } from './helpers/vault.ts'
import { memLogger } from './helpers/logger.ts'
import { FakeAnki } from './helpers/anki-fake.ts'

const NOTE = [
  '---',
  'node: 入门',
  'stage: review',
  'fsrs: null',
  'content:',
  '  version: 1',
  '  generated_at: "2026-09-01"',
  '  status: draft',
  'practice:',
  '  attempts: 2',
  '  correct: 2',
  '---',
  '',
  '# 入门',
  '',
  '## 概念',
  '',
  '课程正文占位。',
].join('\n')

const TODAY = todayStr(new Date())

function bankYaml(): string {
  return [
    'node: 入门',
    'questions:',
    '  - id: q1',
    '    kind: single_choice',
    '    q: 等差数列的定义是？',
    '    options: ["相邻两项之差恒定", "任意两项之比恒定", "各项递增", "各项为整数"]',
    '    answer: A',
    `    fsrs: { stability: 3, difficulty: 5, due: "${TODAY}", last_review: "2026-09-01", reps: 2, lapses: 0 }`,
  ].join('\n')
}

/** 今天上午 10 点的本地毫秒时间戳（事件日 = 今天，避开午夜边界）。 */
function todayNoonMs(): number {
  const d = new Date()
  d.setHours(10, 0, 0, 0)
  return d.getTime()
}

function fakeCtx(responses: string[] = []): Context {
  const queue = [...responses]
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', text: queue.length ? queue.shift() : '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  } as unknown as Context
}

function makeRt(log: ReturnType<typeof memLogger>): HostRuntime {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-obst4-'))
  mkdirSync(join(vault, '学习中心', 'state'), { recursive: true })
  writeFileSync(join(vault, '学习中心', 'state', 'learnhub.json'),
    JSON.stringify({ schema: { version: 4, formats: {} } }, null, 1) + '\n', 'utf8')
  return createHostRuntime(fakeCtx(), { vault, centerRel: '学习中心', logger: log })
}

/** 宿主测试的引擎桩（点路径 = 子系统方法，与 tests/host-runtime.test.ts 的 stub 同款）。 */
function stubEngine(rt: HostRuntime, methods: Record<string, unknown>): void {
  const engine = rt.engine as unknown as Record<string, unknown>
  for (const [k, fn] of Object.entries(methods)) {
    const dot = k.indexOf('.')
    if (dot < 0) { engine[k] = fn; continue }
    const sub = engine[k.slice(0, dot)] as Record<string, unknown>
    sub[k.slice(dot + 1)] = fn
  }
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const at = Date.now()
  while (!cond()) {
    if (Date.now() - at > timeoutMs) throw new Error('等待超时：条件未在时限内成立')
    await new Promise(r => setTimeout(r, 10))
  }
}

/** sendJson 的假 ServerResponse：end 载荷收集进 sink 供断言。 */
function fakeRes(sink: string[] = []): never {
  return {
    writeHead: () => undefined,
    end: (body?: unknown) => { if (typeof body === 'string') sink.push(body) },
  } as never
}

// ---- sched 族 ----

test('sched.params_fallback：缓存损坏（解析失败/形态不对）回退留痕，文件不存在是合法空态不留痕', async () => {
  await withVault({}, async ({ engine, logger }) => {
    // 无缓存文件：合法空态，零事件（ADR-0091 判据：只记损坏，不记缺失）
    const r0 = await resolveFsrsParams(engine.paths, ['math'], nodeVaultFs, logger)
    assert.equal(r0.source, 'default')
    assert.equal(logger.count('sched.params_fallback'), 0)

    const p = engine.paths.fsrsParamsPath('math')
    await mkdir(dirname(p), { recursive: true })
    await writeFileAsync(p, '{ 烂的', 'utf8')
    const r1 = await resolveFsrsParams(engine.paths, ['math'], nodeVaultFs, logger)
    assert.equal(r1.source, 'default')
    const e1 = logger.nth('sched.params_fallback')!
    assert.equal(e1.level, 'info')
    assert.deepEqual(e1.fields, { source: 'cache', course: 'math', why: 'parse_fail' })

    await writeFileAsync(p, JSON.stringify({ parameters: [1, 2, 3] }), 'utf8')
    await resolveFsrsParams(engine.paths, ['math'], nodeVaultFs, logger)
    const e2 = logger.nth('sched.params_fallback')!
    assert.equal(e2.fields.why, 'shape')
    assert.equal(logger.count('sched.params_fallback'), 2)
  })
})

test('sched.optimize.meta：优化器入口留混训门指针（DEBUG：execution_included/execution_rows）', async () => {
  await withVault({}, async ({ engine, logger }) => {
    const impl = {
      train: async () => ({ parameters: defaultParams(), splitEval: null }),
      evaluate: async () => ({ logLoss: 1, rmseBins: 1 }),
    }
    const r = await engine.sched2.optimizeFsrsParams(impl)
    assert.equal(r.status, 'skipped', '无日志不足门：优化跳过，但指针事件先落')
    const e = logger.nth('sched.optimize.meta')!
    assert.equal(e.level, 'debug')
    assert.equal(e.fields.execution_included, false)
    assert.equal(e.fields.execution_rows, 0)
  })
})

// ---- note_source 族 ----

test('note_source.anki_export_skipped：镜像 Broken 漏源留痕（WARN + source），不阻塞其他源', async () => {
  await withVault({
    files: [{ path: '我的笔记/费曼技巧.md', content: '# 费曼技巧\n\n讲给别人听，卡壳处回炉。\n' }],
  }, async ({ engine, logger, root }) => {
    const reg = await engine.channels.noteSourceRegister(join(root, '我的笔记', '费曼技巧.md'))
    assert.equal(reg.registered, 1)
    const src = (await engine.registry.loadNoteSources())[0]!
    // 卡池题库文件在场但损坏 → bank.load 抛 Broken → 该源挂起
    const p = engine.bank.bankPath(engine.paths.noteSourceDir, src.id)
    await mkdir(dirname(p), { recursive: true })
    await writeFileAsync(p, ':::: 烂的 ::::', 'utf8')
    const r = await engine.channels.ankiExportPush(new FakeAnki())
    assert.equal(r.broken_sources, 1)
    const e = logger.nth('note_source.anki_export_skipped')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.source, src.id)
  })
})

test('note_source.ease_unknown：Anki 事件按钮越界指针（DEBUG + button），样本计 skipped_unknown', async () => {
  await withVault({ notes: { 入门: `${NOTE}\n` }, banks: { 入门: bankYaml() } }, async ({ engine, logger }) => {
    const anki = new FakeAnki()
    await engine.channels.ankiExportPush(anki)
    anki.answer('数学/入门/q1', 0, todayNoonMs())
    const r = await engine.channels.ankiImportEvents(anki, { nowMs: todayNoonMs() + 600_000 })
    assert.equal(r.skipped_unknown, 1)
    assert.equal(r.advanced, 0)
    const e = logger.nth('note_source.ease_unknown')!
    assert.equal(e.level, 'debug')
    assert.equal(e.fields.button, 0)
  })
})

// ---- host 族 ----

test('host.gen_jobs.run_error：任务执行失败留痕（ERROR + job/error）', async () => {
  const log = memLogger()
  const rt = makeRt(log)
  stubEngine(rt, {
    'content2.contentTierOf': async () => 1,
    'bank2.questionGenerate': async () => { throw new Error('LLM 炸了') },
    saveGenJobs: async () => undefined,
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
  })
  enqueueQuizGeneration(rt, fakeCtx(), '数学', '节点A')
  await until(() => log.count('host.gen_jobs.run_error') === 1)
  const e = log.nth('host.gen_jobs.run_error')!
  assert.equal(e.level, 'error')
  assert.equal(e.fields.job, '数学/节点A')
  assert.equal(e.fields.error, 'LLM 炸了')
  await until(() => rt.jobs.genJobs.get('数学/节点A')?.status === 'failed')
})

test('host.gen_jobs.sweep_skip：图读不动逐课程留痕（course+why）；broken 整扫跳过只留 why', async () => {
  const log = memLogger()
  const rt = makeRt(log)
  rt.jobs.genJobs.set('数学/节点A', {
    course: '数学', node: '节点A', startedAt: new Date().toISOString(), status: 'cancelled',
  } as never)
  stubEngine(rt, {
    'registry.get': async (key: string) => ({ name: key }),
    saveGenJobs: async () => undefined,
  })
  // 课程在场而图读不动：存在性未知保守保留（不出册），逐课程留一声
  ;(rt.engine as unknown as { loadView: () => never }).loadView = () => { throw new Error('图坏了') }
  assert.equal(await sweepGenJobs(rt), 0)
  const e = log.nth('host.gen_jobs.sweep_skip')!
  assert.equal(e.level, 'warn')
  assert.equal(e.fields.course, '数学')
  assert.equal(e.fields.why, 'graph_unreadable')

  // broken 态：整扫跳过（队列级没有单课程上下文，course 缺省、why 在）
  log.clear()
  rt.flags.genQueueBroken = '任务档损坏（测试注入）'
  assert.equal(await sweepGenJobs(rt), 0)
  const e2 = log.nth('host.gen_jobs.sweep_skip')!
  assert.equal(e2.level, 'warn')
  assert.equal(e2.fields.course, undefined)
  assert.ok(typeof e2.fields.why === 'string' && e2.fields.why.includes('清扫跳过'))
})

// ---- 直调路由收编（ADR-0080 §勘误处置）----

test('直调路由收编复核：勘误清单 9 条逐条经 apiRun 留 engine.call 痕', async () => {
  const log = memLogger()
  const rt = makeRt(log)
  stubEngine(rt, {
    'bank2.questionUpdate': async () => ({}),
    'bank2.questionAdd': async () => ({}),
    'bank2.questionArchive': async () => ({}),
    'bank2.courseDelete': async () => ({}),
    'content2.submitFeedback': async () => 'ok',
    'graph.proposalApply': async () => ({}),
    'graph.graphReject': async () => ({}),
    rebuild: async () => ({ message: 'ok' }),
  })
  const cases: Array<[keyof typeof HANDLERS, Record<string, unknown>, string]> = [
    ['PUT /question-update', { course: '数学', node: '入门', qid: 'q1', patch: {} }, 'api/question-update'],
    ['POST /question-add', { course: '数学', node: '入门', question: { id: 'q9' } }, 'api/question-add'],
    ['POST /question-archive', { course: '数学', node: '入门', qid: 'q1' }, 'api/question-archive'],
    ['POST /rebuild', {}, 'api/rebuild'],
    ['POST /feedback', { path: '我的笔记/x.md' }, 'api/feedback'],
    ['POST /proposals/apply', { kind: 'edit', id: 1 }, 'api/proposals/apply'],
    ['POST /proposals/reject', { id: 1, note: '' }, 'api/proposals/reject'],
    ['POST /course/delete', { course: '数学' }, 'api/course/delete'],
    ['POST /generate/cancel', { course: '数学', node: '节点A' }, 'api/generate/cancel'],
  ]
  for (const [route, body, tool] of cases) {
    await HANDLERS[route]({ rt, res: fakeRes(), body } as never)
    const hit = log.entries.filter(e => e.event === 'engine.call' && e.fields.tool === tool).at(-1)
    assert.ok(hit, `${route} 应留 ${tool} 一痕（engine.call）`)
    assert.equal(hit.level, 'info')
  }
})

test('api.experiments.report_failed：报告读取失败留痕（WARN），响应仍 report=null', async () => {
  const log = memLogger()
  const rt = makeRt(log)
  stubEngine(rt, {
    'lab.experimentList': async () => [{ id: 'exp-1' }],
    'lab.experimentReport': async () => { throw new Error('报告坏了') },
    'lab.experimentTemplates': async () => [],
  })
  const sink: string[] = []
  await HANDLERS['GET /experiments']({ rt, res: fakeRes(sink) } as never)
  const e = log.nth('api.experiments.report_failed')!
  assert.equal(e.level, 'warn')
  assert.equal(e.fields.error, '报告坏了')
  assert.match(sink.join(''), /"report":null/, '响应形状不变：面板拿到的还是 report=null')
})
