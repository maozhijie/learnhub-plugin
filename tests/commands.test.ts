/**
 * 命令注册表（#169 / ADR-0045 裁定）：形状、唯一性、接线与两面一致性的门。
 *
 * 门清单（ADR-0045 末尾的八道门 + ⑨ 可达性〔#257 / ADR-0083〕；7 由既有的两份快照测试承担）：
 *   ① `engine` 声明值 ∈ 门面原型方法；留空的必须落在白名单（逐条理由＝ADR 的三类）
 *   ② 队列通道的 `phase` ∈ GEN_JOB_PHASES，且 runner 认得它（节点锚定阶段或 jobs.ts 里有分支）
 *   ③ 唯一性：`id`／`tool` 名／`(method, path)` 在装配表上各自唯一（并断言索引没被静默覆盖）
 *   ④ handler 覆盖：适配器 handler 的 id 集合 == 注册表里非生成路径命令的 id 集合
 *   ⑤ `AGENT_GUIDE` 受检投影：每条指南的 tool 所属命令确实带 agent 通道
 *   ⑥ 零运行时依赖：`src/commands/` 下只允许 `import type`，禁 `node:*`／`@deepseek-ai/*`
 *   ⑧ 声明与面一致：agent 通道的 `(tool, summary, args)` 投影后与工具面快照逐字一致；
 *      路由通道（panel/ops）的 `(method, path)` 与路由清单逐字一致
 *   ⑨ 可达性：每个命令至少一个可达面（panel 路由→UI 源码 / ops 路由→`scripts/` / agent 工具位）；
 *      ops 路由必有 `scripts/` 调用点（#257 新增，见 ADR-0083）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BY_ROUTE, BY_TOOL, COMMAND_LIST, COMMANDS, DOMAIN_SIZES } from '../src/commands/index.ts'
import { GEN_JOB_PHASES, isNodeAnchoredPhase } from '../src/generation-jobs.ts'
import { LearnhubEngine } from '../src/engine/index.ts'
import { LearnerSubsystem } from '../src/engine/learner-cards.ts'
import { ContentSubsystem } from '../src/engine/content-subsystem.ts'
import { ProjectSubsystem, Projects } from '../src/engine/projects.ts'
import { BankSubsystem } from '../src/engine/question-bank.ts'
import { ChannelsSubsystem } from '../src/engine/note-source.ts'
import { LabSubsystem } from '../src/engine/nof1.ts'
import { GraphSubsystem } from '../src/engine/graph-subsystem.ts'
import { GrowthSubsystem } from '../src/engine/growth-subsystem.ts'
import { SchedSubsystem } from '../src/engine/sched-subsystem.ts'
import { Registry } from '../src/engine/registry.ts'
import { GraphProposals } from '../src/engine/proposals.ts'
import { AGENT_GUIDE, sdkParameters } from '../src/host/tools.ts'
import { HANDLERS } from '../src/host/handlers.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const json = <T>(rel: string) => JSON.parse(read(rel)) as T

/** 递归读取目录下全部源码文本（可达性门的「面」扫进来；.d.ts 也算 .ts）。 */
function walkText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return [walkText(p)]
    return /\.(ts|tsx|mjs|mts|html)$/.test(e.name) ? [readFileSync(p, 'utf8')] : []
  }).join('\n')
}

/** 可达性判据的结构输入（只需 id 与通道面字段，够合成夹具即好）。 */
interface ReachChannel {
  channel: string
  tool?: string
  prefix?: boolean
  route?: { method: string; path: string }
}
interface ReachCommand { id: string; channels: readonly ReachChannel[] }
interface ReachSurfaces { ui: string; scripts: string }

/**
 * 可达性判据（#257 / ADR-0083）：命令必须至少有一个可达面，面按通道种类定。
 * - `agent` 通道：注册即产品面（工具名下发即暴露，无需静态调用点）。
 * - `panel` 路由：在 UI 源码（`ui/src` ∪ `src/client`）找到**调用点**即可达。
 * - `ops` 路由：在 `scripts/` 找到**调用点**即可达。
 * - `prefix` 路由：静态伺服前缀（唯一一条 `GET /vendor/`），由运行期生成物引用，不参与断言。
 * 判据是**调用点**而非「字符串恰好出现」——后者会把注释里的 `src/host/smoke.ts`、别名
 * `/note-sources`（含 `/note` 子串）、历史死路由 `/review`（含于 `/question-dispute/review`）
 * 误当调用，正是 ADR-0047 要防的恒过门。纯函数：门体与两向自检共用（自检不许另写一份正则）。
 */

/** 引号三态（单／双／反引号）——调用点的路径字面量可能以任一种包裹。 */
const QUOTE = "['\"`]"

/** 正则转义：路径里的 `.` 等按字面匹配。 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 一条 (method, path) 是否在其面里有调用点：
 * - UI 形态：`('<METHOD>', '<path>'…)`（`api.ts` 的 `http(...)`）；
 * - 宿主 API 形态：`` `/learnhub/api<path>`… ``（client 桥与脚本的 `postJson`／`fetch`）。
 * 路径后须接**终止符**（引号／反引号／`?`／`&`／`$`／空白），挡住 `/note` 命中 `/note-sources` 的前缀别名。
 */
function routeCalled(surface: string, method: string, path: string): boolean {
  const e = escapeRe(path)
  const term = "(?=['\"`?&$\\s])"
  return new RegExp(`${QUOTE}${method}${QUOTE}\\s*,\\s*${QUOTE}${e}${term}`).test(surface)
    || new RegExp(`/learnhub/api${e}${term}`).test(surface)
}

export function scanReachability(
  commands: readonly ReachCommand[],
  surfaces: ReachSurfaces,
): { orphans: string[]; opsUncalled: string[] } {
  const orphans: string[] = []
  const opsUncalled: string[] = []
  for (const c of commands) {
    let reachable = false
    let hasPrefix = false
    for (const ch of c.channels) {
      if (ch.channel === 'agent' && ch.tool) reachable = true
      const r = ch.route
      if (!r) continue
      if (ch.prefix) { hasPrefix = true; continue }
      const surface = ch.channel === 'ops' ? surfaces.scripts : surfaces.ui
      if (routeCalled(surface, r.method, r.path)) reachable = true
      else if (ch.channel === 'ops') opsUncalled.push(`${c.id} ${r.method} ${r.path}`)
    }
    // 纯前缀伺服命令（无产品命令面）：本就无静态调用方，登记豁免（唯一一条 vendor-）。
    const servoOnly = hasPrefix && !c.channels.some(ch => ch.route && !ch.prefix)
    if (!reachable && !servoOnly) orphans.push(c.id)
  }
  return { orphans, opsUncalled }
}

/**
 * `engine` 留空的白名单（ADR-0045 裁定 1 的三类，逐条理由）。
 * 三类之外留空即失败：这是「接线不许指向空气」的登记处。
 */
const NO_ENGINE: Record<string, '队列型' | '按参分派型' | '无引擎型'> = {
  // ① 队列型 8：handler 只入队，引擎调用在 jobs.ts 的 runner（多方法管线；#256 −1：seed-propose）
  'generate': '队列型', 'section-rewrite': '队列型', 'course-reset': '队列型',
  'question-generate': '队列型', 'coach-growth': '队列型', 'coach-compass': '队列型',
  'project-plan-generate': '队列型', 'project-milestone-generate': '队列型',
  // ② 按参分派型 7：同一个命令的入口是实参的函数（#256 −1：node-pin）
  'experiments': '按参分派型', 'graph-apply': '按参分派型',
  'question-update': '按参分派型', 'bank-cleanup': '按参分派型', 'probation': '按参分派型',
  'sleep-config': '按参分派型', 'receipt-review-mode': '按参分派型',
  // ③ 无引擎型 14：伺服、host 队列态、常量、LLM 会话、实验运行器（smoke/spike，#215/#216；quality-review 评审器，#222/#224）、
  // 终点手加/删（#240/ADR-0076：主体动作在 handler——一个写入单元直调引擎图域 add/removeEndpoint 立即落盘，
  // add 是纯声明、不触发生成（放行教练走 /coach/growth）；不经命令队列的 runner，故不入 ① 队列型）
  'file': '无引擎型', 'vendor-': '无引擎型', 'interactive': '无引擎型',
  'generate-status': '无引擎型', 'generate-resume': '无引擎型', 'generate-cancel': '无引擎型',
  'agent-guide': '无引擎型', 'tutor': '无引擎型', 'explain-back': '无引擎型',
  'smoke': '无引擎型',
  'spike': '无引擎型',
  'quality-review': '无引擎型',
  'endpoint-add': '无引擎型',
  'endpoint-remove': '无引擎型',
  // 卡点自报（#248/ADR-0077：主体动作在 handler——引擎落账 + 队列入队的编排，
  // 同 endpoint-add 的「不经命令队列 runner」；频控在引擎写点，在途语义在 jobs.ts）
  'stuck-report': '无引擎型',
}

// ---------------------------------------------------------------- ① engine 存在性

test('门① engine 存在性：点路径 ∈ 子系统原型 / 裸名 ∈ hub 装配域（ADR-0049 C 形态）；留空的逐条在白名单里', () => {
  // 子系统名 → 类原型（C 形态的公开面契约表；hub 字段名与此表键一一对应）
  const SUBSYSTEM_PROTOS: Record<string, Record<string, unknown>> = {
    learner: LearnerSubsystem.prototype,
    content2: ContentSubsystem.prototype,
    project: ProjectSubsystem.prototype,
    bank2: BankSubsystem.prototype,
    channels: ChannelsSubsystem.prototype,
    lab: LabSubsystem.prototype,
    graph: GraphSubsystem.prototype,
    growth2: GrowthSubsystem.prototype,
    sched2: SchedSubsystem.prototype,
    registry: Registry.prototype,
    proposals: GraphProposals.prototype,
    projects: Projects.prototype,
  } as unknown as Record<string, Record<string, unknown>>
  const proto = LearnhubEngine.prototype as unknown as Record<string, unknown>
  const bad: string[] = []
  const unlisted: string[] = []
  for (const c of COMMAND_LIST) {
    if (c.engine === undefined) {
      if (!NO_ENGINE[c.id]) unlisted.push(c.id)
      continue
    }
    // C 形态（ADR-0049）：`<子系统>.<方法>` 断言子系统类原型；裸名断言 hub 装配域方法
    const dot = c.engine.indexOf('.')
    const hit = dot < 0
      ? typeof proto[c.engine] === 'function'
      : typeof SUBSYSTEM_PROTOS[c.engine.slice(0, dot)]?.[c.engine.slice(dot + 1)] === 'function'
    if (!hit) bad.push(`${c.id} → ${c.engine}`)
  }
  assert.deepEqual(bad, [], `这些命令的 engine 在门面上不存在（接线指向空气）：\n${bad.join('\n')}`)
  assert.deepEqual(unlisted, [], `这些命令没有 engine 又不在白名单里（留空要逐条有理由）：\n${unlisted.join('\n')}`)
  // 白名单自检：不许沉淀成幽灵条目（登记了 id，注册表里却没有）
  const ids = new Set(COMMAND_LIST.map(c => c.id))
  const ghosts = Object.keys(NO_ENGINE).filter(id => !ids.has(id))
  assert.deepEqual(ghosts, [], `白名单里的这些 id 在注册表里不存在（幽灵条目）：\n${ghosts.join('\n')}`)
  // 生成路径的命令必须真的声明了 bind（否则适配器无从装配实参）
  const generic = COMMAND_LIST.filter(c => c.channels.some(x => x.bind !== undefined))
  assert.ok(generic.length >= 66, `走生成路径的命令只剩 ${generic.length} 条（#240 +1：course-create 的 bind 通道进生成路径；塌了就说明声明退化）`)
})

// ---------------------------------------------------------------- ② 队列阶段

test('门② 队列阶段：phase ∈ GEN_JOB_PHASES，且 runner 认得它', () => {
  const jobs = read('src/host/jobs.ts')
  const bad: string[] = []
  let queued = 0
  for (const c of COMMAND_LIST) {
    for (const ch of c.channels) {
      if (ch.mode !== 'queued') continue
      queued++
      if (ch.phase === undefined) { bad.push(`${c.id}：queued 但没声明 phase`); continue }
      if (!(GEN_JOB_PHASES as readonly string[]).includes(ch.phase)) { bad.push(`${c.id}：phase ${ch.phase} 不在词表`); continue }
      // 节点锚定阶段走管线（outline/sections/quiz）；其余必须在 runner 里有字面分支
      if (!isNodeAnchoredPhase(ch.phase) && !jobs.includes(`'${ch.phase}'`)) bad.push(`${c.id}：runner 里没有 ${ch.phase} 的分支`)
    }
  }
  assert.deepEqual(bad, [], `队列通道的阶段声明有问题：\n${bad.join('\n')}`)
  assert.ok(queued >= 15, `队列通道只剩 ${queued} 条（实测应为 15；#256 −1：seed-propose）`)
})

// ---------------------------------------------------------------- ③ 唯一性

test('门③ 唯一性：id／tool 名／(method, path) 各自唯一，索引没被静默覆盖', () => {
  const ids = COMMAND_LIST.map(c => c.id)
  assert.equal(new Set(ids).size, ids.length, 'id 有重复')
  const tools = COMMAND_LIST.flatMap(c => c.channels.filter(x => x.tool).map(x => x.tool!))
  assert.equal(new Set(tools).size, tools.length, 'tool 名有重复')
  assert.equal(tools.length, 113, `agent 通道应恰 113 条，实得 ${tools.length}（#274 +1：learnhub_concept_merge_candidates；#265 +1：learnhub_concept_confusable_candidates；#203 +1：learnhub_receipt_review_mode；#256 −1：learnhub_project_decompile_apply 随反编译 plan-only 退役）`)
  const routeKeys = COMMAND_LIST.flatMap(c => c.channels.filter(x => x.route).map(x => `${x.route!.method} ${x.route!.path}`))
  assert.equal(new Set(routeKeys).size, routeKeys.length, '(method, path) 有重复')
  assert.equal(routeKeys.length, 129, `路由通道（panel+ops）应恰 129 条，实得 ${routeKeys.length}（#274 +1：POST /concepts/merge-candidates；#209 +1：GET /compass；#215 +1：POST /smoke；#216 +1：POST /spike；#222 +1：POST /quality-review；#240 +3：POST /course/create、POST /endpoint/add、POST /endpoint/remove；#248 +1：POST /coach/stuck-report；#255 −1：GET /doctor 随 doctor 退役；#256 −6：GET /courses、POST /node/pin、/proposals/impact、/review、/seed/propose、PUT /day-cutoff 死路由退役）`)
  assert.equal(BY_TOOL.size, tools.length, 'BY_TOOL 索引吞了条目（有重复 tool 名被 Map 覆盖）')
  assert.equal(BY_ROUTE.size, routeKeys.length, 'BY_ROUTE 索引吞了条目（有重复路由被 Map 覆盖）')
})

// ---------------------------------------------------------------- ⑤ AGENT_GUIDE 受检投影

test('门⑤ AGENT_GUIDE 受检投影：每条指南的 tool 所属命令确实带 agent 通道', () => {
  const bad = AGENT_GUIDE.filter(g => !BY_TOOL.has(g.tool)).map(g => g.tool)
  assert.deepEqual(bad, [], `指南里的这些 tool 不在注册表的 agent 通道里（ADR-0045 受检投影）：\n${bad.join('\n')}`)
  assert.equal(AGENT_GUIDE.length, 23, '指南条目数（增减要显式）')
})

// ---------------------------------------------------------------- ⑥ 零运行时依赖

test('门⑥ 零运行时依赖：src/commands/ 只允许 import type，禁 node:*／@deepseek-ai/*', () => {
  const files = readdirSync(join(ROOT, 'src', 'commands')).filter(f => f.endsWith('.ts')).sort()
  assert.ok(files.length >= 9, `受控面只剩 ${files.length} 个文件（扫描面塌了）`)
  const bad: string[] = []
  for (const f of files) {
    const text = read(`src/commands/${f}`)
    for (const m of text.matchAll(/^\s*import\s+(type\s+)?[^\n]*from\s+'([^']+)'/gm)) {
      const [, isType, spec] = m
      // 运行时依赖只准是注册表**自己**（同目录相对）；对外一律 type-only
      if (!isType && !/^\.\//.test(spec!)) bad.push(`${f}: 运行时 import ${spec}`)
      if (/^node:|^@deepseek-ai\//.test(spec!)) bad.push(`${f}: 禁的依赖 ${spec}`)
    }
    for (const m of text.matchAll(/^\s*export\s+[^\n]*from\s+'([^']+)'/gm)) {
      if (!/^\s*export\s+type/.test(m[0]) && !/^\.\//.test(m[1]!)) bad.push(`${f}: 运行时 re-export ${m[1]}`)
    }
    if (/readFileSync|writeFileSync|node:fs/.test(text)) bad.push(`${f}: 出现 I/O`)
  }
  assert.deepEqual(bad, [], `注册表必须零运行时依赖（UI 跨包 import type 的前提）：\n${bad.join('\n')}`)
})

// ---------------------------------------------------------------- ⑧ 声明与面一致

test('门⑧ 声明与面一致：agent 通道投影后与工具面快照逐字相同', () => {
  const snapshot = json<Array<{ name: string; description: string; parameters: unknown }>>('tests/fixtures/host-tools-snapshot.json')
  const byTool = new Map(COMMAND_LIST.flatMap(c => c.channels.filter(x => x.tool).map(x => [x.tool!, c] as const)))
  const diffs: string[] = []
  for (const snap of snapshot) {
    const c = byTool.get(snap.name)
    if (!c) { diffs.push(`注册表缺工具 ${snap.name}`); continue }
    if (c.summary !== snap.description) diffs.push(`${snap.name} 的 summary 与工具面 description 不一致`)
    // 快照记的是 defineTool 的**注册形态**（{type:object,properties,required[]}）：
    // sdkParameters 只剥投递层键（工具面吃的是 per-property 形态），这里补上归一化
    const stripped = sdkParameters(c.args) as Record<string, { required?: boolean } & Record<string, unknown>>
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [k, v] of Object.entries(stripped)) {
      const { required: req, ...rest } = v
      properties[k] = rest
      if (req) required.push(k)
    }
    const projected = { type: 'object', properties, ...(required.length ? { required } : {}) }
    if (JSON.stringify(projected) !== JSON.stringify(snap.parameters)) {
      diffs.push(`${snap.name} 的 args 投影后与工具面 schema 不一致\n    期望 ${JSON.stringify(snap.parameters).slice(0, 200)}\n    实得 ${JSON.stringify(projected).slice(0, 200)}`)
    }
  }
  assert.deepEqual(diffs, [], `注册表与工具面漂移（声明不是第二份真相）：\n${diffs.join('\n')}`)
})

test('门⑧ 声明与面一致：路由通道（panel+ops）的 (method, path) 与路由清单逐字相同', () => {
  const baseline = json<Array<{ method: string; route: string; prefix?: boolean }>>('tests/fixtures/host-routes-baseline.json')
  const shape = (r: { method: string; route: string; prefix?: boolean }) => `${r.method} ${r.route}${r.prefix ? '（前缀）' : ''}`
  const fromRegistry = COMMAND_LIST.flatMap(c => c.channels.filter(x => x.route)
    .map(x => shape({ method: x.route!.method, route: x.route!.path, ...(x.prefix ? { prefix: true } : {}) })))
    .sort()
  assert.deepEqual(fromRegistry, baseline.map(shape).sort(), '路由通道的路由清单与重构前实测漂移')
})

// ---------------------------------------------------------------- ④ handler 覆盖

test('门④ handler 覆盖：handlers.ts 的键集合 == 没有 bind 的路由通道（panel+ops）集合', () => {
  const routes = COMMAND_LIST.flatMap(c => c.channels.filter(ch => ch.route).map(ch => ({ command: c, channel: ch })))
  const generic = routes.filter(x => x.channel.bind !== undefined)
  const handled = routes.filter(x => x.channel.bind === undefined)
  const keys = new Set(Object.keys(HANDLERS))
  const missing = handled.filter(x => !keys.has(`${x.channel.route!.method} ${x.channel.route!.path}`))
    .map(x => `${x.channel.route!.method} ${x.channel.route!.path}`)
  const dead = [...keys].filter(k => !handled.some(x => `${x.channel.route!.method} ${x.channel.route!.path}` === k))
  assert.deepEqual(missing, [], `这些路由既没有 bind（生成路径）也没有 handler：\n${missing.join('\n')}`)
  assert.deepEqual(dead, [], `这些 handler 已被生成路径覆盖（死代码，该删）：\n${dead.join('\n')}`)
  assert.ok(generic.length >= 45, `生成路径只剩 ${generic.length} 条（装机率塌了）`)
  assert.equal(generic.length + handled.length, 129, '路由通道（panel+ops）总数应恰 129（#268 +1：GET /concepts/footprint；#274 +1：POST /concepts/merge-candidates；（#209 +1：GET /compass；#215 +1：POST /smoke；#216 +1：POST /spike；#222 +1：POST /quality-review；#240 +3：POST /course/create、POST /endpoint/add、POST /endpoint/remove；#248 +1：POST /coach/stuck-report；#255 −1：GET /doctor；#256 −6：六条死路由退役）')
  // bind 的每个键都必须在 args 里（否则取值器会抛「声明漏键」）
  const badBind = routes.filter(x => (x.channel.bind ?? []).some(k => k !== null && !(k in x.command.args)))
    .map(x => x.command.id)
  assert.deepEqual(badBind, [], `这些命令的 bind 引用了未声明的键：\n${badBind.join('\n')}`)
})

test('门③·装配：按 id 键的装配没被跨文件重名吃掉（键数 == 各域之和）', () => {
  const sum = Object.values(DOMAIN_SIZES).reduce((a, b) => a + b, 0)
  assert.equal(Object.keys(COMMANDS).length, sum,
    `装配表键数 ${Object.keys(COMMANDS).length} != 各域之和 ${sum}——有命令在两个域文件里重名，后者静默覆盖了前者`)
  assert.equal(COMMAND_LIST.length, sum)
  // 声明里的 id 必须与它的键一致（键是主键，id 字段是冗余的人读副本）
  for (const [key, spec] of Object.entries(COMMANDS)) {
    assert.equal(spec.id, key, `键 ${key} 与声明里的 id ${spec.id} 不一致`)
  }
})

// ---------------------------------------------------------------- ⑨ 可达性

test('门⑨ 可达性：每个命令至少一个可达面；ops 路由必有 scripts/ 调用点（#257 / ADR-0083）', () => {
  const uiText = walkText(join(ROOT, 'ui', 'src')) + '\n' + walkText(join(ROOT, 'src', 'client'))
  const scriptsText = walkText(join(ROOT, 'scripts'))
  // 收集器可见性自检（R3 恒过教训）：两个面都得真读到**调用点**，否则门会静默恒过
  assert.ok(routeCalled(uiText, 'GET', '/status'), 'UI 收集面塌了：ui/src 里找不到 GET /status 的调用点')
  assert.ok(routeCalled(uiText, 'GET', '/discuss-pack'), 'UI 收集面塌了：src/client 里找不到 GET /discuss-pack 的调用点')
  assert.ok(routeCalled(scriptsText, 'POST', '/smoke'), '脚本收集面塌了：scripts/ 里找不到 POST /smoke 的调用点')
  const { orphans, opsUncalled } = scanReachability(COMMAND_LIST, { ui: uiText, scripts: scriptsText })
  assert.deepEqual(opsUncalled, [],
    `这些 ops 路由在 scripts/ 找不到调用点（声明成 ops 却没有脚本驱动，该改回 panel/agent 或删）：\n${opsUncalled.join('\n')}`)
  assert.deepEqual(orphans, [],
    `这些命令没有任何可达面（无 UI 调用、无脚本调用、无 agent 工具）——死入口，该退役：\n${orphans.join('\n')}`)
})

test('门⑨ 自检：panel 无 UI 调用判孤儿、ops 无脚本调用判违规、agent/prefix 面豁免（门不是恒过）', () => {
  const panel = (path: string): ReachCommand => ({ id: 'ghost', channels: [{ channel: 'panel', route: { method: 'POST', path } }] })
  // 违规样本：panel-only 命令，路由不在 UI 文本里 → 孤儿
  assert.deepEqual(scanReachability([panel('/ghost')], { ui: '', scripts: '' }).orphans, ['ghost'],
    'panel 路由无 UI 调用必须判孤儿')
  // 正样本：同一路由出现在 UI 文本（哪怕只是字面量）→ 不判孤儿
  assert.deepEqual(scanReachability([panel('/ghost')], { ui: "http('POST', '/ghost')", scripts: '' }).orphans, [],
    '收集器必须看得见真实 UI 调用点')
  // ops 样本：ops 路由不在 scripts → 同时进 opsUncalled 与 orphans；在 scripts → 绿
  const op: ReachCommand = { id: 'op', channels: [{ channel: 'ops', route: { method: 'POST', path: '/op' } }] }
  assert.deepEqual(scanReachability([op], { ui: '', scripts: '' }).opsUncalled, ['op POST /op'],
    'ops 路由无脚本调用点必须报出')
  assert.deepEqual(scanReachability([op], { ui: '', scripts: '' }).orphans, ['op'])
  assert.deepEqual(scanReachability([op], { ui: '', scripts: 'postJson(`${base}/learnhub/api/op`)' }).orphans, [],
    'ops 路由被脚本调用即达')
  // agent 面样本：双通道命令的 panel 路由 UI 无调用，命令仍经工具面可达 → 不判孤儿
  const dual: ReachCommand = { id: 'dual', channels: [
    { channel: 'agent', tool: 'learnhub_t' },
    { channel: 'panel', route: { method: 'POST', path: '/dual' } },
  ] }
  assert.deepEqual(scanReachability([dual], { ui: '', scripts: '' }).orphans, [],
    '双面命令经 agent 工具可达，panel 路由无 UI 调用不判孤儿')
  // prefix 伺服样本：静态前缀路由不参与断言 → 不判孤儿
  const servo: ReachCommand = { id: 'servo', channels: [{ channel: 'panel', prefix: true, route: { method: 'GET', path: '/srv/' } }] }
  assert.deepEqual(scanReachability([servo], { ui: '', scripts: '' }).orphans, [], 'prefix 伺服路由豁免')
})
