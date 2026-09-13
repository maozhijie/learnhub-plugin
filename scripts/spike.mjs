/**
 * 工具调用通道 spike 驱动（#216）：一条命令跑完双臂协议并落报告。
 *
 *   npm run spike                 # 协议缺省：每格 9 次（每臂 18 次）× 两站 × 两变体
 *   npm run spike -- --runs 1 --stations 课程大纲   # 试跑（验装置与 provider 连通）
 *
 * 装置本体住宿主（真 provider 只在宿主 ctx，见 src/host/spike.ts），本脚本只做三件事：
 *   ① 找宿主（--base 或 LEARNHUB_BASE，缺省 http://127.0.0.1:3080）；
 *   ② POST /learnhub/api/spike 拿报告（默认超时 60 分钟——每臂 18 次 × 两站是真实配额）；
 *   ③ 渲染读数 + 预注册线裁决 + 落 JSON（--out，缺省 docs/research/2026-09-spike-tool-channel.json）。
 *
 * 成本纪律：这是**协议内次数**的实验（真实配额），不要挂循环；试跑用 --runs 1。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, resolve } from 'node:path'

/** 长任务 POST：用 node:http 而非 fetch——fetch（undici）默认 headersTimeout 300s，
 * 「宿主同步跑完整轮再回」的调用会被 5 分钟掐断（#216 首轮实验实测：语料跑齐 72 格次，
 * 响应头未在 300s 内发出 → 驱动拿不到报告）。node:http 无隐式头超时。 */
function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = JSON.stringify(body)
    const req = httpRequest({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) reject(new Error(`宿主返回 ${res.statusCode}：${text}`))
        else resolve(JSON.parse(text))
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`等待宿主超过 ${Math.round(timeoutMs / 60000)} 分钟`)))
    req.on('error', reject)
    req.end(payload)
  })
}

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const base = (opt('base', process.env.LEARNHUB_BASE ?? 'http://127.0.0.1:3080')).replace(/\/+$/, '')
const timeoutMs = Number(opt('timeout', process.env.LEARNHUB_SPIKE_TIMEOUT_MS ?? String(60 * 60_000)))
const out = opt('out', 'docs/research/2026-09-spike-tool-channel.json')

const body = {}
const runs = opt('runs', undefined)
if (runs !== undefined) body.runsPerCell = Number(runs)
const stations = opt('stations', undefined)
if (stations !== undefined) body.stations = stations.split(',').map(s => s.trim()).filter(Boolean)
const quizCount = opt('quiz-count', undefined)
if (quizCount !== undefined) body.quizCount = Number(quizCount)
const temperature = opt('temperature', undefined)
if (temperature !== undefined) body.temperature = Number(temperature)
const corpusDir = opt('corpus', undefined)
// 语料目录由**宿主进程**写盘：相对路径会落在宿主的 cwd 里而不是本脚本的 cwd（#216 实测踩过），
// 故一律解析成本脚本视角的绝对路径再发过去
if (corpusDir !== undefined) body.corpusDir = resolve(corpusDir)

let report
try {
  report = await postJson(`${base}/learnhub/api/spike`, body, timeoutMs)
} catch (err) {
  console.error(`未取到报告：${err instanceof Error ? err.message : String(err)}`)
  console.error(`确认宿主在 ${base} 且已载入本 checkout 的构建（npm run build 后重启）：curl ${base}/learnhub/api/status`)
  console.error('（若整轮已跑完但响应被掐断：语料仍在 --corpus 目录里，可用 --from-corpus 复算报告）')
  process.exit(1)
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(report, null, 1) + '\n', 'utf8')

const pct = v => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
const ci = r => (r ? `（CI ${(r[0] * 100).toFixed(0)}–${(r[1] * 100).toFixed(0)}%）` : '')
const num = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

console.log('# 工具调用通道 spike 报告（#216）')
console.log('')
console.log(`耗时：${(report.durationMs / 1000 / 60).toFixed(1)} 分钟｜每格 ${report.config.runsPerCell} 次｜站：${report.config.stations.join('、')}｜温度：${report.config.temperature}`)
console.log(`变体：对照臂 ${report.config.variants.control.join(' / ')}｜工具臂 ${report.config.variants.tool.join(' / ')}`)
console.log('')

console.log('## 一、格式轴（格级读数）')
console.log('')
console.log('| 站 | 臂 | 变体 | 次数 | 交付 | 交付率 | 命中 | 命中率 | schema 合规 | 入 token | 出 token | 工具 schema 字符 |')
console.log('|---|--|--|--:|--:|--:|--:|--:|--:|--:|--:|--:|')
for (const c of report.cells) {
  console.log(`| ${c.station} | ${c.arm} | ${c.variant} | ${c.runs} | ${c.delivered} | ${pct(c.deliveryRate)} | ${c.toolHits} | ${pct(c.hitRate)} | ${pct(c.schemaRate)} | ${num(c.inputTokens)} | ${num(c.outputTokens)} | ${c.toolSchemaChars} |`)
}
console.log('')

console.log('## 二、臂级（预注册线）')
console.log('')
for (const a of report.arms) {
  console.log(`${a.station}｜${a.arm}：交付 ${a.delivered}/${a.runs} = ${pct(a.deliveryRate)}${ci(a.deliveryCi)}`
    + `｜命中 ${a.hitRate === null ? '—（无工具）' : `${pct(a.hitRate)}${ci(a.hitCi)}`}`
    + `｜token 入 ${num(a.inputTokens)} / 出 ${num(a.outputTokens)}｜工具 schema ${a.toolSchemaChars} 字符`)
}
console.log('')
console.log('裁决线：')
for (const l of report.verdict.lines) console.log(`- ${l}`)
console.log(`→ ${report.verdict.decision}`)
console.log('')

console.log('## 三、多样性/内容轴（批内范围均值）')
console.log('')
for (const q of report.quality) {
  const m = q.metrics
  const parts = Object.entries(m).map(([k, v]) => `${k}=${v === null ? '—' : v}`).join('  ')
  console.log(`${q.station}｜${q.arm}（n=${q.runs}）：${parts}`)
}
console.log('')
console.log('## 备注')
for (const n of report.notes) console.log(`- ${n}`)
console.log('')
console.log(`报告 JSON：${out}${report.corpus.dir ? `｜语料：${report.corpus.dir}（${report.corpus.files} 个文件）` : ''}`)
process.exit(report.verdict.formatPass === false ? 2 : 0)
