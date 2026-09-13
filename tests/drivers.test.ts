/**
 * 驱动脚本冒烟（#215/#216 code-review 补门）：`scripts/gen-smoke.mjs` 与 `scripts/spike.mjs`
 * 必须能真的跑起来——起一个**桩宿主**（node:http，按路由回两份最小报告），以子进程跑驱动，
 * 断言退出码与人读渲染的关键面。
 *
 * 为什么值得一道门：两个驱动是「一条命令跑通」这条例言里的**命令**本身，但它们住在
 * `scripts/`——G1/G7（src/ 扫描）、`npm run check`（lib/ 语法）都看不见它们。实测漏网：
 * gen-smoke.mjs 重构后漏了 `import { request as httpRequest } from 'node:http'`，
 * `npm run smoke` 在发请求前就 ReferenceError，而它被自己的 try/catch 渲染成
 * 「宿主没起」的排查指引——错因被伪装成环境问题。本门用桩宿主把这类「代码没跑起来」
 * 与「环境没起来」分开。
 *
 * 桩宿主只回最小报告（字段与真实报告同构、数值刻意夸张到一眼可辨），
 * 断言驱动能解析并渲染，不复制装置逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 桩宿主：POST /learnhub/api/smoke → 最小冒烟报告；POST /learnhub/api/spike → 最小 spike 报告。 */
async function stubHost(): Promise<{ base: string; close: () => Promise<void>; bodies: unknown[] }> {
  const bodies: unknown[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      bodies.push({ url: req.url, body })
      const out = req.url === '/learnhub/api/smoke'
        ? {
          verdict: 'ok', startedAt: '2026-09-13T00:00:00.000Z', durationMs: 1234,
          course: '桩课', node: '桩节点',
          pipeline: { seedProposalId: 1, endpoint: '桩终点', starts: ['桩节点'], jobStatus: 'done', jobMessage: '桩任务完成', failedSections: [] },
          stations: [{ station: '课程大纲', calls: 2, ok: 2, tolerated: 0, failed: 0, failureCodes: {}, inputTokens: 12, outputTokens: 7, reasoningTokens: 0, promptChars: 100, replyChars: 50, durationMs: 900 }],
          artifacts: [{ name: '大纲节清单', by: '桩判据', ok: true, detail: '2 节' }],
          corpusDir: 'C:/tmp/桩语料', hints: ['桩提示'],
        }
        : {
          startedAt: '2026-09-13T00:00:00.000Z', durationMs: 60_000, provider: '桩 provider', model: '桩模型',
          config: { runsPerCell: 1, stations: ['课程大纲'], quizCount: 4, temperature: 1, variants: { control: ['现状'], tool: ['指令式'] } },
          cells: [{ station: '课程大纲', arm: 'tool', variant: '指令式', runs: 1, delivered: 1, deliveryRate: 1, toolHits: 1, hitRate: 1, schemaOk: 1, schemaRate: 1, inputTokens: 9, outputTokens: 4, toolSchemaChars: 111, meanDurationMs: 800 }],
          arms: [{ station: '课程大纲', arm: 'control', runs: 1, delivered: 1, deliveryRate: 1, deliveryCi: [0.2, 1], hitRate: null, hitCi: null, inputTokens: 5, outputTokens: 3, toolSchemaChars: 0 }],
          verdict: { formatPass: true, lines: ['【桩站】预注册线：达标'], decision: '桩裁决' },
          quality: [{ station: '课程大纲', arm: 'control', runs: 1, metrics: { sections: 3 } }],
          rows: [],
          corpus: { dir: 'C:/tmp/桩语料', files: 1 },
          notes: ['桩备注'],
        }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(r => server.close(() => r())),
    bodies,
  }
}

/** 跑一个驱动子进程，收 { code, out }。 */
function runDriver(rel: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [join(ROOT, rel), ...args], { cwd: ROOT })
    let out = ''
    child.stdout.on('data', c => { out += String(c) })
    child.stderr.on('data', c => { out += String(c) })
    child.on('close', code => resolveRun({ code, out }))
  })
}

test('驱动冒烟：gen-smoke.mjs 对桩宿主跑通并渲染报告（漏导入/引用错这类「代码没跑起来」当场现形）', async () => {
  const host = await stubHost()
  try {
    const r = await runDriver('scripts/gen-smoke.mjs', ['--base', host.base])
    assert.equal(r.code, 0, `驱动应跑通（exit 0），实得 ${r.code}：\n${r.out.slice(0, 800)}`)
    assert.match(r.out, /生成冒烟报告/, '报告标题应渲染')
    assert.match(r.out, /课程大纲/, '站行应渲染（含 12\/7 token 这类数字）')
    assert.match(r.out, /大纲节清单/, '产物断言段应渲染')
    assert.equal(host.bodies.length, 1, '应恰好发一次请求')
  } finally {
    await host.close()
  }
})

test('驱动冒烟：spike.mjs 对桩宿主跑通并渲染三段读数', async () => {
  const host = await stubHost()
  try {
    const out = join(ROOT, 'docs', 'research', '.tmp-driver-test-report.json')
    const r = await runDriver('scripts/spike.mjs', ['--base', host.base, '--runs', '1', '--out', out])
    assert.equal(r.code, 0, `驱动应跑通（exit 0），实得 ${r.code}：\n${r.out.slice(0, 800)}`)
    assert.match(r.out, /工具调用通道 spike 报告/, '报告标题应渲染')
    assert.match(r.out, /预注册线/, '裁决段应渲染')
    assert.match(r.out, /格式轴|格式/, '格式轴段应渲染')
    const { readFileSync, rmSync } = await import('node:fs')
    const written = JSON.parse(readFileSync(out, 'utf8')) as { model: string }
    assert.equal(written.model, '桩模型', '报告 JSON 落盘（含模型留痕）')
    rmSync(out, { force: true })
    assert.equal(host.bodies.length, 1, '应恰好发一次请求')
  } finally {
    await host.close()
  }
})
