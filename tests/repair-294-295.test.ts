import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AnkiTransport } from '../src/engine/vault/anki.ts'
import { assertSchemaVersion } from '../src/engine/schema.ts'
import { withVault, tfQuestion } from './helpers/vault.ts'
import { FakeAnki } from './helpers/anki-fake.ts'
import { todayStr } from '../src/engine/dates.ts'

// #294/#295 复查后的行为修复回归：fail-loud 与取消传导（#294）、读侧宽容与补偿路径（#295）

// 题库种子：questions 空组是 Broken（题库契约非空），一律给一道既有题
const SEED_BANK = [
  '  - id: q0',
  '    kind: true_false',
  '    q: 既有题占位：说法是否成立。',
  '    answer: true',
]

const SECTIONS_NOTE = {
  content: { sections: ['    - id: s1', '      title: 概念：大三度', '      type: 概念', '      status: ready', '      version: 1', '    - id: s2', '      title: 概念：小三度', '      type: 概念', '      status: ready', '      version: 1'] },
  body: ['# 入门', '', '## 概念：大三度', '', '大三度 = 4 个半音。', '', '## 概念：小三度', '', '小三度 = 3 个半音。'],
}

function sectionYaml(stem: string, kind = 'true_false', answer = 'true'): string {
  return ['questions:', `  - kind: ${kind}`, `    q: ${stem}`, `    answer: ${answer}`].join('\n')
}

test('#294 admitQuestion：IO 故障 fail loud，不再洗成 invalid 计数', async () => {
  await withVault({
    notes: { 入门: { body: ['# 入门', '', '大三度 = 4 个半音。'] } },
    banks: { 入门: SEED_BANK },
  }, async ({ engine, paths }) => {
    // 盘面故障：题库文件置为只读（writeFile → EPERM，带 errno code）——读正常、写失败
    const bankPath = join(paths.courseRoot('math'), '题库', '入门.yaml')
    await chmod(bankPath, 0o444)
    await assert.rejects(
      engine.bank2.questionGenerate('数学', '入门', 1, async () =>
        ['node: 入门', 'questions:', '  - kind: true_false', '    q: 全新考点的题面？', '    answer: true'].join('\n')),
      /入库失败[\s\S]*存储故障不折算成单题非法/,
      '存储故障必须 fail loud，不能折算成 invalid/skipped 计数')
  })
})

test('#294 questionGenerateSections：取消旗标在节循环头生效（一次 LLM 都不烧）；消息如实对账已入库量', async () => {
  await withVault({
    notes: { 入门: SECTIONS_NOTE },
    banks: { 入门: SEED_BANK },
  }, async ({ engine }) => {
    const calls: string[] = []
    await assert.rejects(
      engine.bank2.questionGenerateSections('数学', '入门', async prompt => {
        calls.push(prompt)
        return sectionYaml('大三度有几个半音？')
      }, { isCancelled: () => true }),
      /生成已取消，结果已丢弃/,
    )
    assert.equal(calls.length, 0, '取消后逐节主循环一次 LLM 调用都不发起')
  })
})

test('#294 questionGenerateSections：第一节入库后取消——不回滚、消息带已入库 N 题、修复轮入口也查旗标', async () => {
  await withVault({
    notes: { 入门: SECTIONS_NOTE },
    banks: { 入门: SEED_BANK },
  }, async ({ engine, paths }) => {
    let calls = 0
    await assert.rejects(
      engine.bank2.questionGenerateSections('数学', '入门', async prompt => {
        calls++
        // 按节标题路由（节 id 短串会在提示词他处出现，不作判据）
        return sectionYaml(prompt.includes('小三度') ? '小三度有几个半音？' : '大三度有几个半音？')
      }, { isCancelled: () => calls >= 2 }),
      /已入库 1 题[\s\S]*已落盘，不回滚/, '消息如实对账半批入库量')
    const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
    assert.equal(bank.questions.length, 2, '半批已入库的题不回滚（既有 q0 + 新增 1，与消息对账一致）')
    assert.ok(calls >= 1)
  })
})

test('#294 questionGenerateSections：单题非法计数进返回面（invalid 字段）', async () => {
  await withVault({
    notes: { 入门: SECTIONS_NOTE },
    banks: { 入门: SEED_BANK },
  }, async ({ engine }) => {
    const r = await engine.bank2.questionGenerateSections('数学', '入门', async prompt =>
      prompt.includes('小三度')
        ? 'questions: []' // 第二节不出题，避免与第一节同题面互查
        : ['questions:', '  - kind: true_false', '    q: 合法题面？', '    answer: true', '  - kind: 超纲题型', '    q: 非法题面？', '    answer: true'].join('\n'))
    assert.equal(r.added, 1)
    assert.equal(r.invalid, 1, 'invalid 计数出现在返回面')
  })
})

test('#295 loadProposals/loadPins/loadAdviceDismissals/loadExperiments：ENOENT=空态，其余 IO 错 fail loud', async () => {
  await withVault({}, async ({ engine }) => {
    // ENOENT（文件不存在）= Missing 合法空态
    assert.deepEqual(await engine.store.loadPins(), [])
    assert.deepEqual(await engine.store.loadAdviceDismissals(), [])
    assert.deepEqual(await engine.store.loadExperiments(), [])
    assert.deepEqual(await engine.store.loadProposals(), [])
    // 盘面故障：路径换成同名目录（readFile → EISDIR）——静默回空会让下一次全量替换写销毁原档
    for (const [name, path] of [
      ['loadPins', engine.paths.pinPath],
      ['loadAdviceDismissals', engine.paths.adviceDismissPath],
      ['loadExperiments', engine.paths.experimentsPath],
      ['loadProposals', engine.paths.proposalsPath],
    ] as const) {
      await mkdir(path, { recursive: true })
      await assert.rejects((engine.store as never as Record<string, () => Promise<unknown>>)[name](), /不可读（Broken）/, `${name} 非 ENOENT 错必须上抛`)
    }
  })
})

test('#295 schema 拒因分流：JSON 损坏给备份+人工检查指引，不给删库建议', () => {
  const brokenFs = { readFileSync: () => '{ "schema": ' } as never
  assert.throws(() => assertSchemaVersion('/x/learnhub.json', brokenFs), /JSON 解析失败（损坏）[\s\S]*备份[\s\S]*不要直接删库重建/)
  // 版本不符（可解析）仍走迁移指引文案
  const oldFs = { readFileSync: () => JSON.stringify({ schema: { version: 1 } }) } as never
  assert.throws(() => assertSchemaVersion('/x/learnhub.json', oldFs), /版本硬门/)
})

// ---- #295 Anki 导入水位幂等：重放窗口事件不重复入账 ----

/** cardReviews 下边界取**闭区间**（≥ mmin）的假 Anki：模拟真实 AnkiConnect 把上一次
 * 最后一条事件原样返回的重放形态——旧代码会重复入账，水位过滤后必须零副作用。 */
class ReplayAnki extends FakeAnki implements AnkiTransport {
  override async invoke(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (action === 'cardReviews') {
      const mmin = Number(params.mmin)
      const mmax = Number(params.mmax)
      return this.reviews.filter(r => r[0]! >= mmin && r[0]! <= mmax)
    }
    return super.invoke(action, params)
  }
}

test('#295 ankiImportEvents：按水位幂等，重放不重复入账', async () => {
  await withVault({
    notes: { 入门: { stage: 'review', body: ['# 入门'] } },
    banks: { 入门: tfQuestion('q1', { fsrs: { stability: 3, difficulty: 5, due: todayStr(new Date()), last_review: '2026-09-01', reps: 2, lapses: 0 } }) },
  }, async ({ engine }) => {
    const anki = new ReplayAnki()
    await engine.channels.ankiExportPush(anki)
    anki.answer('数学/入门/q1', 3, Date.now())
    const r1 = await engine.channels.ankiImportEvents(anki, { nowMs: Date.now() + 600_000 })
    assert.equal(r1.advanced, 1)
    const practiceAfterFirst = (await engine.store.practiceAll()).filter(x => x.judge === 'review').length
    const reviewsAfterFirst = (await engine.store.reviewLogAll()).length
    // 同一批事件重放（闭区间下界把最后一条原样带回）：零重复入账
    const r2 = await engine.channels.ankiImportEvents(anki, { nowMs: Date.now() + 600_000 })
    assert.equal(r2.imported, 0, '重放事件被水位过滤')
    assert.equal(r2.advanced, 0)
    assert.equal((await engine.store.practiceAll()).filter(x => x.judge === 'review').length, practiceAfterFirst, 'practice 流水不重复落行')
    assert.equal((await engine.store.reviewLogAll()).length, reviewsAfterFirst, '复习日志不重复落行')
  })
})
