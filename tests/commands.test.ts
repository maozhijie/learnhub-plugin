/**
 * 命令注册表（#169 / ADR-0045 裁定）：形状、唯一性、接线与两面一致性的门。
 *
 * 门清单（ADR-0045 末尾的八道门；7 由既有的两份快照测试承担）：
 *   ① `engine` 声明值 ∈ 门面原型方法；留空的必须落在白名单（逐条理由＝ADR 的三类）
 *   ② 队列通道的 `phase` ∈ GEN_JOB_PHASES，且 runner 认得它（节点锚定阶段或 jobs.ts 里有分支）
 *   ③ 唯一性：`id`／`tool` 名／`(method, path)` 在装配表上各自唯一（并断言索引没被静默覆盖）
 *   ④ handler 覆盖：适配器 handler 的 id 集合 == 注册表里非生成路径命令的 id 集合
 *   ⑤ `AGENT_GUIDE` 受检投影：每条指南的 tool 所属命令确实带 agent 通道
 *   ⑥ 零运行时依赖：`src/commands/` 下只允许 `import type`，禁 `node:*`／`@deepseek-ai/*`
 *   ⑧ 声明与面一致：agent 通道的 `(tool, summary, args)` 投影后与工具面快照逐字一致；
 *      panel 通道的 `(method, path)` 与路由清单逐字一致
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

/**
 * `engine` 留空的白名单（ADR-0045 裁定 1 的三类，逐条理由）。
 * 三类之外留空即失败：这是「接线不许指向空气」的登记处。
 */
const NO_ENGINE: Record<string, '队列型' | '按参分派型' | '无引擎型'> = {
  // ① 队列型 9：handler 只入队，引擎调用在 jobs.ts 的 runner（多方法管线）
  'generate': '队列型', 'section-rewrite': '队列型', 'course-reset': '队列型',
  'question-generate': '队列型', 'coach-growth': '队列型', 'coach-compass': '队列型',
  'seed-propose': '队列型', 'project-plan-generate': '队列型', 'project-milestone-generate': '队列型',
  // ② 按参分派型 8：同一个命令的入口是实参的函数
  'node-pin': '按参分派型', 'experiments': '按参分派型', 'graph-apply': '按参分派型',
  'question-update': '按参分派型', 'bank-cleanup': '按参分派型', 'probation': '按参分派型',
  'sleep-config': '按参分派型', 'receipt-review-mode': '按参分派型',
  // ③ 无引擎型 9：伺服、host 队列态、常量、LLM 会话
  'file': '无引擎型', 'vendor-': '无引擎型', 'interactive': '无引擎型',
  'generate-status': '无引擎型', 'generate-resume': '无引擎型', 'generate-cancel': '无引擎型',
  'agent-guide': '无引擎型', 'tutor': '无引擎型', 'explain-back': '无引擎型',
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
  assert.ok(generic.length >= 65, `走生成路径的命令只剩 ${generic.length} 条（实测 agent 45 ∪ panel 49 ≈ 70，塌了就说明声明退化）`)
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
  assert.ok(queued >= 16, `队列通道只剩 ${queued} 条（实测应为 16）`)
})

// ---------------------------------------------------------------- ③ 唯一性

test('门③ 唯一性：id／tool 名／(method, path) 各自唯一，索引没被静默覆盖', () => {
  const ids = COMMAND_LIST.map(c => c.id)
  assert.equal(new Set(ids).size, ids.length, 'id 有重复')
  const tools = COMMAND_LIST.flatMap(c => c.channels.filter(x => x.tool).map(x => x.tool!))
  assert.equal(new Set(tools).size, tools.length, 'tool 名有重复')
  assert.equal(tools.length, 112, `agent 通道应恰 112 条，实得 ${tools.length}（#203 +1：learnhub_receipt_review_mode）`)
  const routeKeys = COMMAND_LIST.flatMap(c => c.channels.filter(x => x.route).map(x => `${x.route!.method} ${x.route!.path}`))
  assert.equal(new Set(routeKeys).size, routeKeys.length, '(method, path) 有重复')
  assert.equal(routeKeys.length, 126, `panel 通道应恰 126 条，实得 ${routeKeys.length}（#159 +1：/proposals/impact）`)
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

test('门⑧ 声明与面一致：panel 通道的 (method, path) 与路由清单逐字相同', () => {
  const baseline = json<Array<{ method: string; route: string; prefix?: boolean }>>('tests/fixtures/host-routes-baseline.json')
  const shape = (r: { method: string; route: string; prefix?: boolean }) => `${r.method} ${r.route}${r.prefix ? '（前缀）' : ''}`
  const fromRegistry = COMMAND_LIST.flatMap(c => c.channels.filter(x => x.route)
    .map(x => shape({ method: x.route!.method, route: x.route!.path, ...(x.prefix ? { prefix: true } : {}) })))
    .sort()
  assert.deepEqual(fromRegistry, baseline.map(shape).sort(), 'panel 通道的路由清单与重构前实测漂移')
})

// ---------------------------------------------------------------- ④ handler 覆盖

test('门④ handler 覆盖：handlers.ts 的键集合 == 没有 bind 的 panel 通道集合', () => {
  const panel = COMMAND_LIST.flatMap(c => c.channels.filter(ch => ch.route).map(ch => ({ command: c, channel: ch })))
  const generic = panel.filter(x => x.channel.bind !== undefined)
  const handled = panel.filter(x => x.channel.bind === undefined)
  const keys = new Set(Object.keys(HANDLERS))
  const missing = handled.filter(x => !keys.has(`${x.channel.route!.method} ${x.channel.route!.path}`))
    .map(x => `${x.channel.route!.method} ${x.channel.route!.path}`)
  const dead = [...keys].filter(k => !handled.some(x => `${x.channel.route!.method} ${x.channel.route!.path}` === k))
  assert.deepEqual(missing, [], `这些路由既没有 bind（生成路径）也没有 handler：\n${missing.join('\n')}`)
  assert.deepEqual(dead, [], `这些 handler 已被生成路径覆盖（死代码，该删）：\n${dead.join('\n')}`)
  assert.ok(generic.length >= 45, `生成路径只剩 ${generic.length} 条（装机率塌了）`)
  assert.equal(generic.length + handled.length, 126, '面板通道总数应恰 126（#159 +1：/proposals/impact）')
  // bind 的每个键都必须在 args 里（否则取值器会抛「声明漏键」）
  const badBind = panel.filter(x => (x.channel.bind ?? []).some(k => k !== null && !(k in x.command.args)))
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
