/**
 * 工具调用通道 spike 装置（#216）：用**假 provider** 驱动双臂协议全链（零网络、零配额），
 * 钉住装置的行为面——
 *
 *  ① 两臂 × 两变体 × 两站都出格与行；对照臂的命中率恒 null（无工具可调）；
 *  ② 工具臂「命中」判定 = 模型确实发了工具调用；未命中回落文本仍走现行解析（协议语义）；
 *  ③ 交付判定走**生产受理门**（`contentOutline` / `questionGenerate`），故等价于真跑同一条路；
 *  ④ 预注册线裁决：工具臂交付 ≥ 对照臂 且 命中 ≥95% 才判达标。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { runToolChannelSpike, wilson } from '../src/host/spike.ts'

const OUTLINE = [
  'node: 变量入门',
  'sections:',
  '  - id: s1', '    title: 概念：变量是什么', '    type: 概念', '    points: 名字与值分离', '    visual: 无',
  '  - id: s2', '    title: 概念：赋值与读取', '    type: 概念', '    points: 两个动作成对', '    visual: 无',
  '  - id: s3', '    title: 练习：两个时刻', '    type: 练习', '    points: 判断赋值与读取', '    visual: 无',
].join('\n')

const QUESTIONS_JSON = JSON.stringify({
  node: '变量入门',
  questions: [
    { kind: 'true_false', q: '变量的名字一旦定了，值就不能再变。', answer: false, difficulty: 1, section: '通用', invokes: '变量' },
    { kind: 'true_false', q: '读取拿到的永远是此刻的值。', answer: true, difficulty: 1, section: '通用', invokes: '读取' },
  ],
})

/**
 * 假 provider：按「本轮是否带 tools」分派——带 tools 即工具臂（发一次 submit 工具调用，
 * 参数是 JSON 串），不带即对照臂（回文本 YAML）。`mode` 控制工具臂是否真的调工具。
 */
function fakeProvider(mode: 'call' | 'text' = 'call'): Context {
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* (req: { tools?: unknown[]; messages?: Array<{ content?: Array<{ text?: string }> }> }) {
        const prompt = (req.messages ?? []).flatMap(m => (m.content ?? []).map(c => c.text ?? '')).join('')
        const isQuiz = prompt.includes('题目数量')
        const payload = isQuiz ? QUESTIONS_JSON : OUTLINE
        if (req.tools?.length && mode === 'call') {
          yield { type: 'block-end', block: { type: 'tool-call', id: 'c1', name: 'submit', arguments: payload } }
          yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 300 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', text: payload }
        yield { type: 'usage', usage: { inputTokens: 800, outputTokens: 250 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  } as unknown as Context
}

test('spike 装置：两臂×两变体×两站出齐读数，工具臂命中即交付，对照臂命中率 null', async () => {
  const report = await runToolChannelSpike(fakeProvider('call'), { runsPerCell: 1 })
  // 格：2 站 × 2 臂 × 2 变体 = 8
  assert.equal(report.cells.length, 8, `格数应为 8，实得 ${report.cells.length}`)
  assert.equal(report.arms.length, 4, '臂级 2 站 × 2 臂 = 4')
  for (const station of ['课程大纲', '题目生成'] as const) {
    const c = report.arms.find(a => a.station === station && a.arm === 'control')!
    const t = report.arms.find(a => a.station === station && a.arm === 'tool')!
    assert.equal(c.deliveryRate, 1, `${station} 对照臂应全交付`)
    assert.equal(c.hitRate, null, '对照臂无工具，命中率恒 null')
    assert.equal(t.hitRate, 1, `${station} 工具臂应全命中`)
    assert.equal(t.deliveryRate, 1, `${station} 工具臂参数即 JSON 应能过既有受理门（JSON ⊂ YAML）`)
  }
  assert.equal(report.verdict.formatPass, true, '预注册线：交付 ≥ 对照 且 命中 ≥95% → 达标')
  assert.ok(report.verdict.lines.some(l => l.includes('预注册线')), '裁决行在报告里')
  // 成本面：工具臂输入 token 应有读数（含工具 schema 占额，实际由 provider 计）
  const toolQuiz = report.arms.find(a => a.station === '题目生成' && a.arm === 'tool')!
  assert.ok(toolQuiz.inputTokens > 0, 'token 计量在场')
  // 质量面：题目站的多样性读数进报告（#230 仪表）
  const q = report.quality.find(x => x.station === '题目生成' && x.arm === 'control')!
  assert.equal(typeof q.metrics.entropy, 'number', '题型熵读数在场')
  assert.equal(typeof q.metrics.distinctStems, 'number', 'distinct 题面数（自算）在场')
})

test('spike 装置：工具臂未命中回落文本，仍走现行解析（协议预注册的失败无害回落）', async () => {
  const report = await runToolChannelSpike(fakeProvider('text'), { runsPerCell: 1, stations: ['课程大纲'] })
  const t = report.arms.find(a => a.arm === 'tool')!
  assert.equal(t.hitRate, 0, '模型不调工具 → 命中率 0')
  assert.equal(t.deliveryRate, 1, '回落文本仍被现行解析接受（交付成功）')
  assert.equal(report.verdict.formatPass, false, '命中 <95% → 预注册线未达标')
  assert.ok(report.verdict.lines.some(l => l.includes('命中 <95%')), '未达标原因点名')
})

test('spike 装置：Wilson 区间（小样本诚实读数）', () => {
  assert.deepEqual(wilson(0, 0), [0, 1])
  const [lo, hi] = wilson(18, 18)
  assert.ok(lo > 0.8 && hi === 1, `18/18 的 95% 下界应 >0.8：${lo}`)
  const [l2, h2] = wilson(9, 18)
  assert.ok(l2 > 0.25 && h2 < 0.75, `9/18 的区间应跨 0.5：${l2}–${h2}`)
})
