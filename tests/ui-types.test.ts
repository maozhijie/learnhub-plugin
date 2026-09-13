/**
 * UI 公共面门（#169 / ADR-0045 裁定 7）：类型检查本身在 `npm run typecheck` 里
 * （`scripts/scan-ui-types.mjs`，串行跑一次 tsc——塞进并行的 `node --test` 会抢资源、实测偶发失败）。
 * 本文件只断言两件**便宜且关键**的事：调用点零改动，以及「引擎形状手工镜像已收口」这个不变式。
 *
 * UI 的响应类型现在从命令注册表的 `output` 派生（`CommandOutput<id>`），
 * 于是 UI 的类型程序必然把宿主/引擎源码作为**类型依赖**拉进来（要门面类型才能派生）。
 * 那些文件是按**根 tsconfig（strict: false）**写的，用 UI 自己的 `strict: true` 去诊断它们
 * 只会得到一堆与 UI 无关的存量债——所以本门只断言 `ui/src/` 下 0 错，
 * 依赖源码的错数照实报出（它们的严格化属于根类型门的事，另开票）。
 *
 * 另一半是「公共面零改动」：`api.<name>(` 调用点数量必须与迁移前一致（迁移时 139 处），
 * 有意增减要显式同步（#157 生长批失败重试：通知与生成页各 +1 处 api.coachGrowth → 141）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { WIRE_ARGS } from '../src/commands/index.ts'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 调用点棘轮（迁移回归网）；有意增减随提交同步（注释里给理由）。
 * #159：+1（提案页 api.proposalImpact，reseed 影响预览）。
 * #196：+2（生成页失败行「重试」——retryJob 调 api.generate 与 api.questionGenerate 各一处）。
 * #208：+6（今日页成型——供给卡 api.generateResume/重试三路由 api.generate·
 * api.questionGenerate·api.coachGrowth、闸门计数 api.proposals；课程卡迁出今日暂住
 * 学习图页，逐课复习自取 api.reviewQueue。courseDelete/resetCourse 随组件整体搬迁不计数）。 */
const API_CALLSITES = 150

test(`UI 公共面零改动：api.<name>( 调用点数量不变（${API_CALLSITES} 处，函数名与签名未动）`, () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
  const callsites = walk(join(ROOT, 'ui', 'src'))
    .filter(f => !f.endsWith('api.ts'))
    .reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(/\bapi\.[A-Za-z_]\w*\s*\(/g)].length, 0)
  assert.equal(callsites, API_CALLSITES, `调用点从 ${API_CALLSITES} 漂到 ${callsites}（受影响的文件：${walk(join(ROOT, 'ui', 'src')).join(', ')}）`)
})

test('UI 形状收口：引擎形状手工镜像已清零（响应类型一律从注册表 output 派生）', () => {
  const text = readFileSync(join(ROOT, 'ui', 'src', 'types.ts'), 'utf8')
  // 旧形态：按引擎 schema 手抄的 interface（`export interface X { ... }`）。收口后本文件只剩
  // UI 本地词汇（Stage/ContentStatus/LlmView/StatusWithLlm/AgentGuideItem）与一处有理由的复合响应
  // （/experiments 多入口，组成仍派生）。任何新的手抄 interface 都会被这条挡住。
  const local = [...text.matchAll(/^export interface (\w+)/gm)].map(m => m[1]!)
  assert.deepEqual(local.sort(), ['AgentGuideItem', 'ExperimentsDoc', 'LlmView'].sort(),
    `ui/src/types.ts 又多出手写 interface（引擎形状该从 output 派生）：${local.join(', ')}`)
  assert.ok(text.includes("from '../../src/commands/index'"), '派生入口（注册表）不在了')
})

test('UI 请求体线名以声明为权威：UI 写出的每个 snake_case 键都在某个命令的声明里', () => {
  // 第三处手写映射（UI 端 JS 名 → 线名）今天仍逐处写着；这条门把它的**权威**钉在声明上：
  // 声明（registry 的 args 键）是线名的唯一出处——UI 写出一个声明里没有的 snake_case 键即失败。
  const text = readFileSync(join(ROOT, 'ui', 'src', 'api.ts'), 'utf8')
  const declared = new Set([...WIRE_ARGS.values()].flat())
  const written = new Set([...text.matchAll(/(?:^|[{,\s])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*[:,}]/gm)]
    .map(m => m[1]!)
    // 排除误取：URL 查询串里的参数名不是「体键」（`?week_start=` 一类由 q() 拼）
    .filter(k => !text.includes(`?${k}=`) && !text.includes(`${k}=\${`)))
  // 覆盖面说明：只扫「体对象里直接写出的 snake_case 键」（展开式 `...(cond ? {k: v} : {})` 里的
  // 键也在内），不含 q() 拼进查询串的参数名——键集小不是塌了，是它只覆盖这一层；
  // 加一个新线名而声明里没有，仍然会被挡下。
  assert.ok(written.size >= 8, `扫到的线名只剩 ${written.size} 个（扫描面塌了）`)
  // 登记在案的非请求键（逐条理由）：扫描把**响应字段**也一并看见了，它们不是线名；
  // defer_schedule 是唯一真例外——面板独有键，工具面 schema 不许它进 args，由该路由的 handler 自读。
  const NOT_WIRE: Record<string, string> = {
    suggest_next: '响应字段（读侧，非请求键）',
    arm_today: '响应字段（读侧，非请求键）',
    maintenance_days: '响应字段（读侧，非请求键）',
    defer_schedule: '面板独有键：工具面 schema 不含它（门⑧ 不许并进 args），由 /question-answer 的 handler 自读',
  }
  const bad = [...written].filter(k => !declared.has(k) && !(k in NOT_WIRE))
  assert.deepEqual(bad, [], `这些线名不在任何命令的声明里（映射与声明漂移）：${bad.join(', ')}`)
  // 清单自检：登记的非请求键必须真的不在声明里（不许沉淀成永久豁免）
  const stale = Object.keys(NOT_WIRE).filter(k => declared.has(k))
  assert.deepEqual(stale, [], `这些键已经在声明里了，该从 NOT_WIRE 里删掉：${stale.join(', ')}`)
})
