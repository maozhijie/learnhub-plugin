/**
 * 生成冒烟驱动（#215）：一条命令在临时 vault 跑通全管线并打印结构断言报告。
 *
 *   npm run smoke            # 缺省最小成本档（1 节点 / 综合题 4 道 / 第二意见门关）
 *   npm run smoke -- --corpus <目录>   # 语料留在该目录（缺省随临时 vault 一起删）——离线评审
 *                                      # 的抽样池来源（#222/#224）：冒烟跑的是真模型，语料留
 *                                      # 下来才有「对真实生成产出打分」的样本
 *
 * 管线本体住宿主（真 provider 只在宿主 ctx 上，见 src/host/smoke.ts），本脚本只做三件事：
 *   ① 找到宿主（--base 或 LEARNHUB_BASE，缺省 http://127.0.0.1:3080）；
 *   ② POST /learnhub/api/smoke 拿报告（分钟级同步等待，超时 20 分钟）；
 *   ③ 人读渲染：各站成功率／失败码分布／token 消耗／产物结构断言逐项 → 退出码
 *      （verdict=failed 即 1）。
 *
 * 拿不到报告时**不静默**：按失败形态打印可执行指引（编译 / 起宿主 / junction 补齐 /
 * 端口被别的进程占），这几条正是本仓最常见的人工卡点。
 *
 * 注意：本脚本走真实 provider 与用户配额——单次成本压在几次调用内，不要挂循环。
 */
import { request as httpRequest } from 'node:http'
import { resolve } from 'node:path'

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
const timeoutMs = Number(opt('timeout', process.env.LEARNHUB_SMOKE_TIMEOUT_MS ?? '1200000'))

const body = {}
for (const [flag, key, cast] of [
  ['goal', 'goal', String], ['course', 'course', String],
  ['quiz-count', 'quizCount', Number], ['quiz-audit-rate', 'quizAuditRate', Number],
  ['job-timeout-ms', 'jobTimeoutMs', Number],
  // 语料目录由**宿主进程**写盘：相对路径会落在宿主的 cwd 里而不是本脚本的 cwd（#216 实测踩过），
  // 故一律解析成本脚本视角的绝对路径再发过去
  ['corpus', 'corpusDir', v => resolve(v)],
]) {
  const v = opt(flag, undefined)
  if (v !== undefined) body[key] = cast(v)
}

/** 拿不到报告时的可执行指引（本仓最常见的四道人工卡点，逐条给命令）。 */
function guidance(reason) {
  return [
    `未取到报告：${reason}`,
    '',
    '按顺序排查（多数情况第一条就够）：',
    `  1. 编译后重启宿主才能生效（lib 是宿主启动时加载的，不热更新）：npx @deepseek-ai/dsh web`,
    `     起完看输出里的本地 URL；若端口不是 3080，用 npm run smoke -- --base http://127.0.0.1:<端口>`,
    `  2. 报 Cannot find package '@deepseek-ai/dsh-llm' = peer junction 缺失：node scripts/link-peers.mjs`,
    `  3. 报 EADDRINUSE 3080：先 netstat -ano | findstr :3080 —— 很可能是用户自己起的宿主，探活`,
    `     curl ${base}/learnhub/api/status 正常就别动它（直接对该端口跑冒烟即可）`,
    `  4. 报 config.vault 目录不存在：改 ~/.dsh/profiles/web/cordis.patch.yml 里 dsh-learnhub 行的 vault`,
    '',
    `（本脚本只驱动宿主里的管线：真 provider 只在宿主 ctx 上，脚本自己不碰模型。）`,
  ].join('\n')
}

let report
try {
  report = await postJson(`${base}/learnhub/api/smoke`, body, timeoutMs)
} catch (err) {
  if (err instanceof Error && err.message.startsWith('宿主返回')) {
    // 宿主在场但冒烟失败：死因是宿主给的第一手信息，放在指引之前
    console.error(err.message)
    console.error('\n' + guidance('宿主在场但冒烟调用失败（死因见上）'))
    process.exit(1)
  }
  console.error(guidance(err instanceof Error ? err.message : String(err)))
  process.exit(1)
}

const pad = (s, n) => String(s).padEnd(n, ' ')
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const num = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

console.log(`# 生成冒烟报告（#215）`)
console.log('')
const VERDICT = { ok: '✓ 跑通', partial: '△ 部分完成（有节/出题失败，死因见下）', failed: '✗ 失败' }
console.log(`判定：${VERDICT[report.verdict] ?? report.verdict}`)
console.log(`耗时：${(report.durationMs / 1000).toFixed(1)}s｜课程：${report.course}｜节点：${report.node ?? '—'}`)
console.log(`起点：${report.pipeline.start ?? '—'}｜终点：${report.pipeline.endpoint ?? '—'}`)
console.log(`任务终态：${report.pipeline.jobStatus ?? '—'}｜${report.pipeline.jobMessage ?? ''}`)
console.log('')

console.log('## 各站成功率与失败码分布（语料 + usage 计量）')
console.log('')
console.log(`| ${pad('站', 12)} | ${pad('调用', 4)} | ${pad('成功', 4)} | ${pad('容忍', 4)} | ${pad('失败', 4)} | ${pad('成功率', 6)} | ${pad('入/出 token', 12)} | 失败码 |`)
console.log(`|---|--:|--:|--:|--:|--:|---:|---|`)
let calls = 0
let ok = 0
let inTok = 0
let outTok = 0
for (const s of report.stations) {
  calls += s.calls
  ok += s.ok
  inTok += s.inputTokens
  outTok += s.outputTokens
  const codes = Object.entries(s.failureCodes).map(([c, n]) => `${c}×${n}`).join('、') || '—'
  console.log(`| ${pad(s.station, 12)} | ${pad(s.calls, 4)} | ${pad(s.ok, 4)} | ${pad(s.tolerated, 4)} | ${pad(s.failed, 4)} | ${pad(pct(s.ok, s.calls), 6)} | ${pad(`${num(s.inputTokens)}/${num(s.outputTokens)}`, 12)} | ${codes} |`)
}
console.log(`| ${pad('合计', 12)} | ${pad(calls, 4)} | ${pad(ok, 4)} | | | ${pad(pct(ok, calls), 6)} | ${pad(`${num(inTok)}/${num(outTok)}`, 12)} | |`)
console.log('')

console.log('## 产物结构断言（复跑既有门，零新判据）')
console.log('')
for (const a of report.artifacts) {
  console.log(`${a.ok ? '✓' : '✗'} ${a.name}｜${a.detail}`)
  console.log(`   判据：${a.by}`)
}
console.log('')

if (report.pipeline.failedSections.length) {
  console.log('## 失败节（管线 continue→partial；失败提示可重试续跑）')
  console.log('')
  for (const f of report.pipeline.failedSections) {
    console.log(`- ${f.sectionTitle ?? '(未知节)'}｜${f.code}${f.finding ? `｜${f.finding}` : ''}`)
  }
  console.log('')
}
console.log(`语料目录（临时 vault 内，报告读出后随 vault 删除）：${report.corpusDir}`)
for (const h of report.hints) console.log(`提示：${h}`)

// 退出码：0 = 跑通；2 = 部分完成（有节/出题失败——冒烟算未跑通，死因在报告里）；1 = 失败
process.exit(report.verdict === 'ok' ? 0 : report.verdict === 'partial' ? 2 : 1)
