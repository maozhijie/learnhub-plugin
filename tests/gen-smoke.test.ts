/**
 * 生成冒烟运行器（#215）：临时 vault 跑通全管线 + 结构断言报告。
 *
 * 这里用**路由式假 provider**（按提示词形态分派应答）驱动真实管线：种子起草 → 提案
 * 直通 → 大纲 → 逐节正文 → 出题，每一步都由真引擎的解析器与门禁裁决。两条断言：
 *
 *  ① 全绿路径：报告 verdict=ok、四站齐全、token 计量 > 0、产物断言全过。
 *  ② 解析回归现形：把大纲应答换成非法 YAML（等价于解析器回归的输入端注入）——报告里
 *     大纲站 outcome=failed + 失败码、产物断言失败、verdict=failed。报告是诊断面，
 *     它必须能指认「哪一站、什么码」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { runGenerationSmoke } from '../src/host/smoke.ts'

/** 路由式假 provider：按提示词形态分派应答（正文/题目/大纲/种子各一条规则）。 */
function routingCtx(outlineYaml: string, calls: string[]): Context {
  const answer = (prompt: string): string => {
    if (prompt.includes('## 起草方向')) {
      // 种子起草（ADR-0076 种子降职）：给已注册课程起草结构——顶层键随 v5 契约
      // （course/goal_type/endpoint/starts/…，不再有 mode；方向由锚定终点携带）
      return [
        'course: 冒烟课', 'goal_type: capability', 'reason: 冒烟验证',
        'endpoint:', '  name: 冒烟终点', '  region: 基础', '  block: 终点块',
        'starts:', '  - name: 冒烟起点', '    region: 基础', '    block: 起点块', '    basis: baseline',
      ].join('\n')
    }
    if (prompt.includes('## 本节任务')) {
      const title = /- 节标题：(.*)/.exec(prompt)?.[1]?.trim() ?? '概念：冒烟'
      return `## ${title}\n\n这是本节正文，用来验证冒烟链路。\n`
    }
    if (prompt.includes('## 题目数量')) {
      // 定向补节（逐节出题）要求 section 精确等于该节 id；综合批写「通用」。
      // 两批题面必须互不相同：查重门（trigram）会把同题面的综合题整批判重弃光
      const perSection = /section 字段必须精确写「(.+?)」/.exec(prompt)?.[1]
      const section = perSection ?? '通用'
      const tag = perSection ? `定向${perSection}` : '综合'
      return [
        `node: 冒烟起点`, 'questions:',
        '  - kind: true_false', `    q: 冒烟${tag}题一：冒烟链路的题干。`, '    answer: true',
        `    difficulty: 1`, `    section: ${section}`,
        '  - kind: true_false', `    q: 冒烟${tag}题二：冒烟链路的另一题干。`, '    answer: false',
        `    difficulty: 1`, `    section: ${section}`,
      ].join('\n')
    }
    return outlineYaml  // 其余（大纲）走调用方给定的应答
  }
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* (req: { messages?: Array<{ content?: Array<{ text?: string }> }> }) {
        const prompt = (req.messages ?? []).flatMap(m => (m.content ?? []).map(c => c.text ?? '')).join('')
        calls.push(prompt)
        yield { type: 'text-delta', text: answer(prompt) }
        yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 60, reasoningTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  } as unknown as Context
}

const GOOD_OUTLINE = [
  'node: 冒烟起点', 'sections:',
  '  - id: s1', '    title: 概念：冒烟甲', '    type: 概念', '    points: 要点甲', '    visual: 无',
  '  - id: s2', '    title: 概念：冒烟乙', '    type: 概念', '    points: 要点乙', '    visual: 无',
].join('\n')

/** 解析回归注入：不是合法大纲产物（无 sections 映射）。 */
const BROKEN_OUTLINE = 'node: 冒烟起点\nsections: 这不是列表'

test('冒烟全绿路径：四站齐全、token 计量、产物断言全过、verdict=ok', async () => {
  const calls: string[] = []
  const report = await runGenerationSmoke(routingCtx(GOOD_OUTLINE, calls))
  assert.equal(report.verdict, 'ok', `报告应全绿：${JSON.stringify(report.artifacts.filter(a => !a.ok))}`)
  assert.equal(report.node, '冒烟起点')
  assert.equal(report.pipeline.jobStatus, 'done')
  const stations = report.stations.map(s => s.station)
  for (const s of ['种子起草', '课程大纲', '课程节生成', '题目生成']) {
    assert.ok(stations.includes(s), `报告缺站「${s}」（实得 ${stations.join('、')}）`)
  }
  const total = report.stations.reduce((n, s) => n + s.inputTokens + s.outputTokens, 0)
  assert.ok(total > 0, 'token 计量应大于 0（usage 贯通）')
  assert.ok(report.stations.every(s => s.failed === 0), `不该有失败站：${JSON.stringify(report.stations.filter(s => s.failed))}`)
  for (const a of report.artifacts) assert.ok(a.ok, `产物断言「${a.name}」应过：${a.detail}`)
  assert.ok(report.artifacts.some(a => a.name === '题目契约 shape'), '题目契约断言在场')
  // 大纲提示词用的是裁剪包（无 §8 交付要求）——冒烟走的是生产管线，这条顺带钉住
  assert.ok(calls.some(p => p.includes('本节任务')), '逐节正文调用在场')
})

test('冒烟解析回归现形：大纲应答非法 → 报告指认站/失败码，verdict=failed', async () => {
  const report = await runGenerationSmoke(routingCtx(BROKEN_OUTLINE, []))
  assert.equal(report.verdict, 'failed', '解析回归必须让报告判失败')
  const outline = report.stations.find(s => s.station === '课程大纲')
  assert.ok(outline, '大纲站应在报告里')
  assert.ok(outline.failed > 0, `大纲站应有失败捕获：${JSON.stringify(outline)}`)
  assert.ok(Object.keys(outline.failureCodes).length > 0,
    `失败码分布应非空（指认哪类死因）：${JSON.stringify(outline.failureCodes)}`)
  const outlineCheck = report.artifacts.find(a => a.name === '大纲节清单')
  assert.ok(outlineCheck && !outlineCheck.ok, '产物断言应失败（节清单缺席）')
  assert.notEqual(report.pipeline.jobStatus, 'done', '管线不该被记为成功')
})

test('冒烟语料可外落（--corpus）：站表读的是外落目录、语料文件留在盘上（#222 实跑抽样池）', async () => {
  // 这一条是 #222 实跑抓出的回归：临时 vault 随跑随删，语料给了外落目录后**报告站表仍读
  // 临时 vault 的空目录**，站表恒 0 行（语料写外面、报告读里面，两边各说各话）。
  const dir = mkdtempSync(join(tmpdir(), 'learnhub-smoke-corpus-'))
  try {
    const report = await runGenerationSmoke(routingCtx(GOOD_OUTLINE, []), { corpusDir: dir })
    assert.equal(report.corpusDir, dir.replace(/\\/g, '/'), '报告语料目录 = 外落目录')
    assert.ok(report.stations.length >= 4, `站表应读外落目录：实得 ${report.stations.length} 站`)
    assert.ok(report.stations.every(s => s.calls > 0), '各站调用数 > 0')
    const outlineDir = join(dir, '课程大纲')
    assert.ok(existsSync(outlineDir), '外落目录里有大纲站的捕获文件')
    const f = readdirSync(outlineDir)[0]!
    assert.ok(readFileSync(join(outlineDir, f), 'utf8').includes('## 原始输出'), '捕获文件是本格式（frontmatter + 提示词 + 原始输出）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
