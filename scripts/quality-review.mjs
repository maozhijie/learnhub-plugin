/**
 * 离线批量评审驱动（#222；图质量面审计 #224）：一条命令从生成语料抽样、按质量量规评分、
 * 落人读报告。
 *
 *   npm run quality-review                          # 全部有量规的站（每站 3 失败件 + 2 成功件，重复 2 次）
 *   npm run quality-review -- --stations 教练生长,种子起草 --bad 2 --ok 1
 *   npm run quality-review -- --out docs/research/quality-review.json   # 另存机器可读报告
 *
 * 装置本体住宿主（真 provider 只在宿主 ctx，见 src/host/quality-review.ts），本脚本只做四件事：
 *   ① 找宿主（--base 或 LEARNHUB_BASE，缺省 http://127.0.0.1:3080）；
 *   ② POST /learnhub/api/quality-review 拿报告（分钟级同步等待，超时 30 分钟）；
 *   ③ 打印人读报告（宿主已把它落盘到 state/质量评审/，脚本再打印一遍供终端阅读）；
 *   ④ 可选 --out：把机器可读报告 JSON 落盘（跨轮次对照/给提示词 changelog #220 消费用）。
 *
 * 成本纪律：每件 = 两段式评审（盲评 + 对账）× 重复次数，走真实 provider 与用户配额。
 * 默认配额是「先看失败件」的起步档；要看全貌再调 --bad/--ok，不要挂循环。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, resolve } from 'node:path'

/** 长任务 POST：用 node:http 而非 fetch——fetch（undici）默认 headersTimeout 300s，
 * 「宿主同步跑完整轮再回」的调用会被 5 分钟掐断（#216 首轮实验实测）。node:http 无隐式头超时。 */
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
const timeoutMs = Number(opt('timeout', process.env.LEARNHUB_REVIEW_TIMEOUT_MS ?? String(30 * 60_000)))
const out = opt('out', undefined)

const body = {}
for (const [flag, key, cast] of [
  ['stations', 'stations', v => v.split(',').map(s => s.trim()).filter(Boolean)],
  ['bad', 'badQuota', Number], ['ok', 'okQuota', Number], ['repeats', 'repeats', Number],
  ['corpus', 'corpusDir', String], ['out-dir', 'outDir', String],
  ['systemic-min', 'systemicMinSamples', Number], ['systemic-rate', 'systemicLowRate', Number],
]) {
  const v = opt(flag, undefined)
  if (v === undefined) continue
  if (key === 'systemicMinSamples' || key === 'systemicLowRate') {
    body.systemic = { ...(body.systemic ?? {}), ...(key === 'systemicMinSamples' ? { minSamples: cast(v) } : { lowRate: cast(v) }) }
  } else body[key] = cast(v)
}
// 语料目录由**宿主进程**读盘：相对路径会落在宿主的 cwd（#216 实测踩过），一律解析成
// 本脚本视角的绝对路径再发过去
if (body.corpusDir !== undefined) body.corpusDir = resolve(body.corpusDir).replace(/\\/g, '/')

/** 拿不到报告时的可执行指引（本仓最常见的人工卡点，逐条给命令）。 */
function guidance(reason) {
  return [
    `未取到报告：${reason}`,
    '',
    '按顺序排查：',
    `  1. 编译后重启宿主才能生效（lib 是宿主启动时加载的，不热更新）：npx @deepseek-ai/dsh web`,
    `     起完看输出里的本地 URL；端口不是 3080 时用 npm run quality-review -- --base http://127.0.0.1:<端口>`,
    `  2. 报 Cannot find package '@deepseek-ai/dsh-llm' = peer junction 缺失：node scripts/link-peers.mjs`,
    `  3. 报「语料目录里没有有量规的站样本」= 还没跑过生成：先 npm run smoke（临时 vault 全管线）`,
    `     或让宿主跑一轮真实生成，语料落在 <学习中心>/state/生成语料/<站>/`,
    `  4. 报 EADDRINUSE 3080：先查 netstat -ano | findstr :3080——很可能是用户自己起的宿主，`,
    `     探活 curl ${base}/learnhub/api/status 正常就别动它（直接对它跑评审）。`,
    '',
    '（本脚本只驱动宿主里的评审器：真 provider 只在宿主 ctx 上，脚本自己不碰模型。）',
  ].join('\n')
}

let result
try {
  result = await postJson(`${base}/learnhub/api/quality-review`, body, timeoutMs)
} catch (err) {
  console.error(guidance(err instanceof Error ? err.message : String(err)))
  process.exit(1)
}

const { report, markdown, reportPath } = result
if (out) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(report, null, 1) + '\n', 'utf8')
}
console.log(markdown)
console.log('')
console.log(`报告已落盘：${reportPath}`)
if (out) console.log(`机器可读报告：${out}`)
console.log(`读数：抽样 ${report.sampling.selected} 件（池 ${report.sampling.pool}）｜调用 ${report.cost.calls} 次`
  + `｜低分件 ${report.lowScores.length}｜评审失败 ${report.reviews.filter(r => r.failure).length}`
  + `｜未评分（空输出） ${report.unscoreable.length}`
  + `${report.systemic ? `｜系统性候选 ${report.systemic.length}` : ''}`)
