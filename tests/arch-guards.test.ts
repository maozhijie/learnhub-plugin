/**
 * 架构门（#165 / ADR-0047）：构成约定只活在注释与 ADR 里 = 不存在，跑进 npm test 才算存在。
 *
 * 门清单（全部零依赖、文本／加载层面、`node:test` 原生、随 `npm test` 全量执行）：
 *   G1 未定义标识符       —— 硬门 0（剥注释与字符串后「被当函数调用却未声明未导入」即失败）
 *   G2／G2b 宿主装配面    —— 硬门（动态 import 入口与技术层；入口三件套齐备、文件非空）
 *   G2c 宿主可变状态      —— 硬门 0（宿主受控面＝index.ts + host/**\/*.ts 除常量外零模块级 let；ADR-0048）
 *   G3 窄面三向一致       —— 四个装配方向（dead／missing／unwired／surplus）全为硬门 0（第三方向＝门面接线件）
 *   G4 窄面宽度（三槽位） —— 棘轮（handles／facade／fns 逐槽位卡基线）
 *   G5 文件规模           —— 棘轮（逐文件行数卡基线；views 叶子／types.ts 大表在白名单外）
 *   G6 顶层不变量         —— 硬门（除教练层 proposals.ts 外无模块调用图写原语）
 *   G7 类型门             —— 棘轮（`tsc --noEmit` 逐文件错误数卡基线；扫描面 src/）
 *
 * 两条铁律（ADR-0047，两条都来自实测教训）：
 *   ① **带自检**：每个门构造一个必然违规的样本并断言门会失败；收集器类门另断言它能看见
 *      目标形态——R3 曾因收集器只收相对说明符而**恒过**，恒过的门比没有门更坏。
 *   ② **棘轮是精确匹配**：实际 == 基线，涨了失败、降了但未同步下调基线也失败（过期即失败）；
 *      基线自身也要自检幽灵条目（删掉对象却留下基线条目 = 永不复活的门）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanUndefined } from '../scripts/undefined-scan.mjs'
import { faceOf, scanDepsFaces, depthOneKeys, faceViolations } from '../scripts/scan-deps-face.mjs'
import { scanSizes, srcFiles, whitelistHits, SIZE_WHITELIST } from '../scripts/scan-budget.mjs'
import { scanGraphWriters, graphWriteCallers, GRAPH_WRITE_WHITELIST } from '../scripts/scan-invariant.mjs'
import { hostFiles, moduleLevelLets, scanHostLets } from '../scripts/scan-host-state.mjs'
import { BASELINE_FILE, measure, readBaseline, depsFaceViolations, sizeViolations, typeViolations } from '../scripts/arch-baseline.mjs'
import { countAdapterFace, adapterFaceTotals, adapterFaceViolations } from '../scripts/scan-adapter-face.mjs'
import { parseTscOutput, scanTypes, checkedSrc } from '../scripts/scan-types.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const BASELINE = readBaseline(join(ROOT, BASELINE_FILE))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

// ---------------------------------------------------------------- G1 未定义标识符

test('G1 无未定义标识符（抽文件漏导出/漏导入的兜底门）', () => {
  const files = walk(SRC)
  assert.ok(files.length > 50, `扫描面异常：只找到 ${files.length} 个 src/*.ts`)
  const bad = scanUndefined(files)
    .filter(r => r.missing.length)
    .map(r => `${r.file.slice(ROOT.length + 1)}: ${r.missing.join(', ')}`)
  assert.deepEqual(bad, [], `未定义标识符（运行时 ReferenceError 的静态前兆）：\n${bad.join('\n')}`)
})

// ---------------------------------------------------------------- G2／G2b 宿主装配面

test('G2 宿主模块可加载且装配面齐备', async () => {
  const host = await import('../src/index.ts')
  assert.equal(host.name, 'dsh-learnhub')
  assert.deepEqual(host.inject, ['tools', 'webServer', 'llm'])
  assert.equal(typeof host.apply, 'function')

  const llm = await import('../src/host/llm.ts')
  for (const n of ['llmComplete', 'llmSeam', 'llmStreamSeam', 'llmStreamOnce', 'llmView', 'contentEffort']) {
    assert.equal(typeof llm[n], 'function', `host/llm.ts 缺导出 ${n}`)
  }
  // 统一 agent 缝（#162 / ADR-0041/0044）：应用层端口消费者 + 随缝归位的 stripFences
  const agentSeam = await import('../src/engine/agent.ts')
  assert.equal(typeof agentSeam.AgentSeam, 'function', 'engine/agent.ts 缺 AgentSeam')
  assert.equal(typeof agentSeam.stripFences, 'function', 'engine/agent.ts 缺 stripFences（补全后处理随缝归位）')
  assert.equal(agentSeam.AGENT_LOOP_MAX_TOOL_ROUNDS, 6, '回路预算 K≤6（ADR-0041）')
  assert.equal(typeof agentSeam.AgentSeam.prototype.complete, 'function', '缝缺单发模式 complete()')
  assert.equal(typeof agentSeam.AgentSeam.prototype.agentLoop, 'function', '缝缺回路模式 agentLoop()')
  assert.equal(typeof agentSeam.AgentSeam.prototype.gateRepairRound, 'function', '缝缺门错修复轮 gateRepairRound()')
  const http = await import('../src/host/http.ts')
  for (const n of ['sendJson', 'readJson', 'injectKatexIfMathed', 'PAGE_DIST', 'VENDOR_DIST', 'FILE_MIME', 'ASSET_MIME']) {
    assert.ok(http[n] !== undefined, `host/http.ts 缺导出 ${n}`)
  }
  // 参数守卫语义的唯一出处（#168：`need` 自 http.ts 迁来，21 处内联与 51 处手写 typeof 一并收口）
  const params = await import('../src/host/params.ts')
  for (const n of ['need', 'needQuery', 'optQuery', 'requireBoolean', 'requireNumber', 'requireString', 'requireObject',
    'requireOneOf', 'optText', 'optTrimmed', 'optRaw', 'optString', 'optNumber', 'optFinite', 'optBoolean', 'optTrue',
    'optObject', 'optList', 'pick']) {
    assert.equal(typeof params[n], 'function', `host/params.ts 缺导出 ${n}`)
  }

  // 宿主技术层五文件（#167 / ADR-0048）：构造 / 队列 / 路由 / 伺服 / 工具面的关键导出在
  // （stripFences 已随缝归位 engine/agent.ts，#162——宿主不再拥有补全后处理）
  const runtime = await import('../src/host/runtime.ts')
  for (const n of ['createHostRuntime', 'runLog', 'run', 'apiRun']) {
    assert.equal(typeof runtime[n], 'function', `host/runtime.ts 缺导出 ${n}`)
  }
  const jobs = await import('../src/host/jobs.ts')
  for (const n of ['pumpGeneration', 'enqueueGeneration', 'enqueueQuizGeneration', 'waitForQuizJob',
    'scheduleJobRetention', 'sweepGenJobs', 'resumeQueue', 'restoreGenJobs']) {
    assert.equal(typeof jobs[n], 'function', `host/jobs.ts 缺导出 ${n}`)
  }
  const api = await import('../src/host/api.ts')
  assert.equal(typeof api.handleApi, 'function', 'host/api.ts 缺导出 handleApi')
  assert.equal(typeof api.matchRoute, 'function', 'host/api.ts 缺导出 matchRoute（分发即查表）')
  assert.equal(api.API, '/learnhub/api', 'host/api.ts 路由前缀漂移')

  // 路由表三段各自成模块（#168）：形状在 route-table.ts，GET/PUT 在 routes.ts，POST 子表在 routes-post.ts
  const table = await import('../src/host/route-table.ts')
  for (const n of ['get', 'post', 'put', 'getPrefix']) {
    assert.equal(typeof table[n], 'function', `host/route-table.ts 缺表项构造器 ${n}`)
  }
  // #169：路由表演进为命令注册表（routes.ts／routes-post.ts 的 125 条表项 → src/commands/ 的声明，
  // 例外 handler 落 host/handlers.ts）
  const commands = await import('../src/commands/index.ts')
  assert.equal(commands.COMMAND_LIST.length, 154, '注册表应为 154 条命令')
  assert.equal(Object.keys(commands.COMMANDS).length, 154, '按 id 键的装配表应为 154 个键')
  assert.equal(commands.BY_TOOL.size, 111, 'agent 通道索引应为 111 条工具')
  assert.equal(commands.BY_ROUTE.size, 125, 'panel 通道索引应为 125 条路由')
  const handlers = await import('../src/host/handlers.ts')
  assert.equal(typeof handlers.HANDLERS, 'object', 'host/handlers.ts 缺 HANDLERS')
  const staticSrv = await import('../src/host/static.ts')
  for (const n of ['panelPageHandler', 'serveVaultFile', 'serveVendor', 'serveInteractive']) {
    assert.equal(typeof staticSrv[n], 'function', `host/static.ts 缺导出 ${n}`)
  }
  assert.equal(staticSrv.PAGE, '/learnhub', 'host/static.ts 页面前缀漂移')
  const tools = await import('../src/host/tools.ts')
  assert.equal(typeof tools.registerTools, 'function', 'host/tools.ts 缺导出 registerTools')
  assert.ok(Array.isArray(tools.AGENT_GUIDE) && tools.AGENT_GUIDE.length > 0, 'host/tools.ts 缺 AGENT_GUIDE')
})

test('G2b src 下的入口文件存在且非空（防止误删/误移）', () => {
  for (const rel of ['index.ts', 'host/llm.ts', 'host/http.ts', 'host/params.ts', 'host/route-table.ts',
    'host/handlers.ts',
    'host/runtime.ts', 'host/jobs.ts', 'host/api.ts', 'host/static.ts', 'host/tools.ts', 'engine/index.ts',
    'engine/agent.ts']) {
    assert.ok(statSync(join(SRC, rel)).size > 0, `${rel} 缺失或为空`)
  }
})

// ---------------------------------------------------------------- G2c 宿主模块级可变状态

test('G2c 自检：模块级 let 会被看见、函数内 let 不误伤（门不是恒过）', () => {
  // 自检驱动门自己用的纯判据（真代码），不是另写一份正则——否则门可以腐烂而自检照绿
  assert.deepEqual(moduleLevelLets('let genJobs = new Map()\nfunction f() { let x = 1 }'), ['genJobs'],
    '行首 let = 模块级（被抓）；缩进 let = 函数局部（不误伤）')
  assert.deepEqual(moduleLevelLets("export let VAULT = ''"), ['VAULT'], 'export let 同样被抓')
  assert.deepEqual(moduleLevelLets('const genJobs = new Map()'), [], '常量放行（无运行时可变性声明）')
  assert.deepEqual(moduleLevelLets('    let x = 1'), [], '缩进即局部（即使顶层缩进也不误判为模块级）')
})

test('G2c 宿主模块级可变状态归零（ADR-0048：可变态全部进 HostRuntime）', () => {
  const files = hostFiles(ROOT)
  // 收集器可见性自检（R3 恒过教训）：面塌了门会静默恒过
  assert.ok(files.length >= 6, `宿主受控面只剩 ${files.length} 个文件（扫描面塌了）`)
  assert.ok(files.includes('src/index.ts'), '受控面必须含装配入口 src/index.ts')
  assert.ok(files.some(f => f === 'src/host/runtime.ts'), '受控面必须含 runtime.ts（ADR-0048 的分层基准）')
  const bad = scanHostLets(ROOT)
    .filter(r => r.names.length)
    .map(r => `${r.file}: ${r.names.join(', ')}`)
  assert.deepEqual(bad, [], `宿主出现模块级 let（可变态必须进 HostRuntime，ADR-0048）：\n${bad.join('\n')}`)
})

// ---------------------------------------------------------------- 自检夹具（三向／宽度）

/** 夹具：含嵌套子面（registry）与一条多余接线（extraGhost，门面上并不存在该成员）。 */
const FIXTURE_SRC = `
export interface DemoDeps {
  store: Store
  registry: {
    load(): Promise<void>
    save(x: number): Promise<void>
  }
  jolRng: () => number
  learningDay(): Promise<string>
}
export class DemoSubsystem {
  constructor(private e: DemoDeps) {}
  async go() {
    return this.e.learningDay() + this.e.jolRng() + String(this.e.store) + this.e.registry.load()
  }
}
`

const FIXTURE_FACADE = `
export class LearnhubEngine {
  private store = 1
  async learningDay() { return 'x' }
  build() {
    this.demo = new DemoSubsystem({
      store: this.store,
      registry: {
        load: () => this.registryLoad(),
        save: x => this.registrySave(x),
      },
      jolRng: () => this.rng,
      learningDay: () => this.learningDay(),
      extraGhost: () => this.nope(),
    })
  }
}
`

// ---------------------------------------------------------------- G3 窄面三向一致

test('G3 自检：嵌套子面不误计为顶层接线（扁平抽取会伪造 phantom）', () => {
  const face = faceOf(FIXTURE_SRC, FIXTURE_FACADE, 'fixture.ts')
  assert.ok(face, '夹具没被解析出 deps 接口／类——收集器对不上真实形态')
  // 前提检查：扁平抽取确实会把子面成员（load／save）当成顶层键，否则本自检没在测东西
  const flat = [...FIXTURE_FACADE.matchAll(/([A-Za-z_]\w*)\s*:/g)].map(m => m[1])
  assert.ok(flat.includes('load'), '自检前提失效：扁平抽取已看不见子面成员（本用例失去意义）')
  // 正文：brace-depth-1 只取顶层键，子面成员不算
  assert.equal(face.wiredCount, 5, `接线键应恰为 5 个顶层键，实得 ${face.wiredCount}`)
  assert.deepEqual(face.phantom, ['extraGhost'], 'phantom 应恰为 extraGhost——子面成员不得被误计成 phantom')
})

test('G3 自检：多余接线是硬门 0（门不是恒过）', () => {
  const face = faceOf(FIXTURE_SRC, FIXTURE_FACADE, 'fixture.ts')
  assert.deepEqual(face?.surplus, ['extraGhost'], '接了一条 deps 没声明的线却看不见 = 门恒过')
  assert.deepEqual(face?.dead, [], '夹具里声明全部在用')
  assert.deepEqual(face?.missing, [], '夹具里实用全部已声明')
  assert.deepEqual(face?.unwired, [], '夹具里声明全部已接线')
  // 硬门本体（#171 转档）：surplus 不再走基线，任何一条即失败
  const bad = faceViolations([{ deps: 'DemoDeps', dead: [], missing: [], unwired: [], surplus: ['extraGhost'], phantom: ['extraGhost'] }])
  assert.ok(bad.some(v => v.includes('surplus') && v.includes('extraGhost')), '多余接线必须被硬门直接抓住')
  assert.ok(bad.some(v => v.includes('phantom')), 'phantom 明细要一并报出来（门面上根本没这个成员）')
  assert.deepEqual(faceViolations([{ deps: 'DemoDeps', dead: [], missing: [], unwired: [], surplus: [], phantom: [] }]), [],
    '四向全 0 则绿')
})

test('G3 自检：depthOneKeys 只认键位置（注释／字符串／三元的冒号都不误取），简写键也算', () => {
  const keys = depthOneKeys(`
    a: 1,
    // b: 注释里的不算,
    s: 'c: 字符串里的不算',
    t: cond ? x : y,
    n: { deep: 1 },
    z: () => this.f(1, { q: 2 }),
    shorthand,
  `)
  assert.deepEqual(keys, ['a', 's', 't', 'n', 'z', 'shorthand'])
})

test('G3 自检：多余接线无论是 `k: v` 还是简写 `k,` 都看得见', () => {
  const shorthandFacade = `
export class LearnhubEngine {
  private store = 1
  build() { this.demo = new DemoSubsystem({ store, rogueThing, jolRng: () => this.rng }) }
}
`
  const face = faceOf(FIXTURE_SRC, shorthandFacade, 'fixture.ts')
  assert.ok(face?.surplus.includes('rogueThing'), `简写形态的多余接线漏了：surplus=${JSON.stringify(face?.surplus)}`)
})

test('G3 窄面三向一致：四个装配方向全为 0（多余接线已清、转硬门）', () => {
  const faces = scanDepsFaces(ROOT)
  // 收集器可见性自检：扫描面塌成空集时门会静默恒过
  assert.deepEqual(faces.map(f => f.deps).sort(), Object.keys(BASELINE.depsFace).sort(),
    '收集器找到的子系统与基线不一致（改名／新增／漏扫都会到这里）')
  const bad = [...faceViolations(faces), ...depsFaceViolations(measure(ROOT).depsFace, BASELINE.depsFace)]
  assert.deepEqual(bad, [], `窄面三向一致门不符基线：\n${bad.join('\n')}`)
})

// ---------------------------------------------------------------- G4 窄面宽度（三槽位）

test('G4 自检：三槽位按声明形式分组（值属性→handles／方法→facade／函数属性→fns）', () => {
  const face = faceOf(FIXTURE_SRC, FIXTURE_FACADE, 'fixture.ts')
  assert.deepEqual(face?.slots, { handles: 2, facade: 1, fns: 1 },
    'store／registry 属 handles，learningDay() 属 facade，jolRng: () => number 属 fns（嵌套子面成员不计）')
})

test('G4 自检：棘轮抓 depsFace 的每一类漂移与幽灵条目（门不是恒过）', () => {
  const base = { A: { declared: 4, used: 4, wired: 5, slots: { handles: 2, facade: 1, fns: 1 } } }
  const now = (over: Record<string, unknown>) => ({ A: { ...base.A, ...over } })
  const at = (measured: Record<string, unknown>) => depsFaceViolations(measured, base)
  assert.ok(at(now({ declared: 5 })).some(v => v.includes('[棘轮] A.declared')), '声明数漂移必须失败')
  assert.ok(at(now({ wired: 6 })).some(v => v.includes('[棘轮] A.wired')), '接线数漂移必须失败')
  assert.ok(at(now({ slots: { handles: 3, facade: 1, fns: 1 } })).some(v => v.includes('[宽度棘轮] A.handles')), '宽度槽位漂移必须失败')
  assert.ok(at({}).some(v => v.includes('[幽灵条目]') && v.includes('A')), '基线幽灵条目必须被抓')
  assert.ok(at({ ...now({}), B: base.A }).some(v => v.includes('[新受控对象] B')), '新受控对象必须显式登记')
  assert.deepEqual(at(now({})), [], '一致则绿')
})

test('G4 窄面宽度棘轮：三槽位逐子系统卡基线', () => {
  const faces = scanDepsFaces(ROOT)
  assert.ok(faces.length > 0, '扫描面为空——宽度门会静默恒过')
  for (const f of faces) {
    const was = (BASELINE.depsFace as Record<string, { slots: Record<string, number> }>)[f.deps]
    assert.deepEqual(f.slots, was.slots,
      `${f.deps} 三槽位变了：基线 ${JSON.stringify(was.slots)} → 实测 ${JSON.stringify(f.slots)}\n`
      + '  加宽窄面是有代价的：先问这一格该不该长；确实该长则同步基线并说明理由')
  }
})

// ---------------------------------------------------------------- G5 文件规模

test('G5 自检：棘轮抓增长、抓缩水未同步、抓幽灵条目、抓新文件', () => {
  const base = { 'a.ts': 10, 'gone.ts': 3 }
  const at = (sizes: Record<string, number>) => sizeViolations(sizes, base)
  assert.ok(at({ 'a.ts': 11, 'gone.ts': 3 }).some(v => v.includes('[规模棘轮] a.ts')), '涨了必须失败')
  // 降了但未同步下调基线也失败——单侧棘轮会沉淀成永久余量、逐条恒过
  assert.ok(at({ 'a.ts': 9, 'gone.ts': 3 }).some(v => v.includes('[规模棘轮] a.ts')), '缩水未同步必须失败')
  assert.ok(at({ 'a.ts': 10 }).some(v => v.includes('[幽灵条目]') && v.includes('gone.ts')), '基线幽灵条目必须被抓')
  assert.ok(at({ 'a.ts': 10, 'gone.ts': 3, 'new.ts': 1 }).some(v => v.includes('[新受控文件] new.ts')), '新受控文件必须显式登记')
  assert.deepEqual(at({ 'a.ts': 10, 'gone.ts': 3 }), [], '一致则绿')
})

test('G5 自检：白名单每条都要命中真实文件（白名单本身不许是幽灵）', () => {
  assert.ok(SIZE_WHITELIST.length > 0, '白名单不能为空（否则受控面含义不明）')
  for (const w of whitelistHits(srcFiles(ROOT))) {
    assert.ok(w.hits > 0, `规模白名单条目 ${w.entry} 没命中任何文件（幽灵白名单＝偷偷放行）`)
  }
})

test('G5 文件规模棘轮：逐文件行数卡基线（views 叶子／types.ts 大表在白名单外）', () => {
  const sizes = scanSizes(ROOT)
  assert.ok(Object.keys(sizes).length > 50, `受控文件只剩 ${Object.keys(sizes).length} 个（受控面塌了）`)
  const bad = sizeViolations(sizes, BASELINE.sizes)
  assert.deepEqual(bad, [], `文件规模不符基线：\n${bad.join('\n')}`)
})

// ---------------------------------------------------------------- G6 顶层不变量

test('G6 自检：白名单外调用图写原语会被抓（门不是恒过）', () => {
  const callers = graphWriteCallers([
    ['src/engine/graph.ts', 'async writeRegionDoc(path, region) { await writeFile(path, y) }'],
    ['src/engine/proposals.ts', 'await store.writeRegionDoc(files[r.name], region)'],
    ['src/engine/rogue.ts', 'await store.writeRegionDoc(path, region)'],
    ['src/engine/sneaky.ts', 'const { writeRegionDoc } = store'],
  ])
  assert.deepEqual([...callers.keys()].sort(), ['src/engine/proposals.ts', 'src/engine/rogue.ts', 'src/engine/sneaky.ts'],
    '白名单外的调用（含解构别名）必须被看见；原语自己的家不算调用者')
})

test('G6 自检：注释与字符串里提到原语名不算调用（否则是假红）', () => {
  const callers = graphWriteCallers([
    ['src/engine/notes.ts', '// 只有 proposals.ts 才该调 store.writeRegionDoc(\nconst x = 1'],
    ['src/engine/other.ts', "const doc = '调用 store.writeRegionDoc(path, region)'"],
  ])
  assert.deepEqual([...callers.keys()], [], '注释／字符串里的提及不该触硬门')
})

test('G6 顶层不变量：只有教练层（proposals.ts）能调用图写原语', () => {
  const callers = [...scanGraphWriters(ROOT).keys()].sort()
  assert.deepEqual(callers, [...GRAPH_WRITE_WHITELIST].sort(),
    `图写原语（\`data/*.yaml\` 的唯一写路径）的调用者只准是 ${GRAPH_WRITE_WHITELIST.join('、')}——`
    + '其余模块直调即绕过提案门改图（ADR-0044 顶层不变量）')
})

// ---------------------------------------------------------------- G7 类型门（tsc --noEmit）

test('G7 自检：解析器看得见逐文件错误与错误码（门不是恒过）', () => {
  const out = [
    'src/a.ts(1,2): error TS2304: Cannot find name \'x\'.',
    'src/a.ts(9,4): error TS2339: Property \'y\' does not exist.',
    'src/b.ts(3,1): error TS1016: A required parameter cannot follow an optional parameter.',
    'src/b.ts(3,1): warning TS9999: 警告不算错误（但也不能当错误计）',
    'C:\\work\\repo\\src\\c.ts',
    'C:\\work\\repo\\tests\\x.test.ts',
    'C:\\elsewhere\\node_modules\\typescript\\lib\\lib.es2022.d.ts',
    'C:\\work\\repo\\src\\d.ts',
  ].join('\n')
  const { counts, codes, checked, unpositioned } = parseTscOutput(out, 'C:\\work\\repo')
  assert.deepEqual(counts, { 'src/a.ts': 2, 'src/b.ts': 1 }, '逐文件计数（含重复出现的文件、排除 warning）')
  assert.deepEqual(codes, { TS2304: 1, TS2339: 1, TS1016: 1 })
  assert.deepEqual(checked, ['src/c.ts', 'src/d.ts', 'tests/x.test.ts'],
    '--listFiles 只收仓内文件（仓外路径在外）；src/ 之外的仓内文件由 checkedSrc 再筛')
  assert.deepEqual(unpositioned, [])
})

test('G7 自检：无文件位置的 tsc 错误必须硬失败（否则塌掉的扫描面会静默变绿）', () => {
  // tsconfig 坏掉时 tsc 只报一条无位置的错，解析结果为空——当成「全修好了」就是恒过门
  const { counts, unpositioned } = parseTscOutput('error TS18003: No inputs were found in config file.', process.cwd())
  assert.deepEqual(counts, {})
  assert.equal(unpositioned.length, 1, '配置级错误要被单独识别出来（scanTypes 据此抛错）')
})

test('G7 自检：棘轮抓上涨、抓修好未同步、抓新涉错文件、抓幽灵条目', () => {
  const base = { 'src/a.ts': 2, 'src/gone.ts': 1 }
  const at = (counts: Record<string, number>) => typeViolations(counts, base)
  assert.ok(at({ 'src/a.ts': 3, 'src/gone.ts': 1 }).some(v => v.includes('[类型棘轮] src/a.ts')), '错误变多必须失败')
  assert.ok(at({ 'src/a.ts': 1, 'src/gone.ts': 1 }).some(v => v.includes('[类型棘轮] src/a.ts')), '减少未同步基线必须失败')
  assert.ok(at({ 'src/a.ts': 2 }).some(v => v.includes('src/gone.ts')), '修好到 0 却没删基线条目必须失败（幽灵条目）')
  assert.ok(at({ 'src/a.ts': 2, 'src/gone.ts': 1, 'src/new.ts': 1 }).some(v => v.includes('src/new.ts')), '新涉错文件必须显式登记')
  assert.deepEqual(at({ 'src/a.ts': 2, 'src/gone.ts': 1 }), [], '一致则绿')
})

test('G7 类型门：逐文件错误数卡基线（扫描面 src/，存量债按基线棘轮）', () => {
  const measured = scanTypes(ROOT)
  // 收集器可见性自检：tsc 必须真的读到了整个 src/（扫成空集时门会静默恒过）
  const srcOnDisk = srcFiles(ROOT)
  assert.ok(srcOnDisk.length > 50, `受控面异常：src/ 只有 ${srcOnDisk.length} 个 .ts/.tsx`)
  const missed = srcOnDisk.filter(f => !checkedSrc(measured).includes(f))
  assert.deepEqual(missed, [],
    `这些 src 文件没被 tsc 读到（tsconfig include 漏了它们，或扫描面塌了）：\n${missed.join('\n')}`)
  const bad = typeViolations(measured.counts, BASELINE.typeErrors ?? {})
  assert.deepEqual(bad, [], `类型门不符基线：\n${bad.join('\n')}`)
})

// ---------------------------------------------------------------- G8 适配器面（时钟/随机/fs）

test('G8 自检：三种直读形态都被收集器看见（含模板串插值里的 Date.now）', () => {
  const c = countAdapterFace([
    'const a = Date.now()',
    'const d = new Date()',
    'const r = Math.random',
    'const t = `${p}.tmp-${Date.now()}`', // atomicWrite 的例外形态——通用 strip 会把整段模板串吃掉（R3 恒过教训）
    '// 注释里 Date.now() 与 new Date() 不算',
    'const s = "new Date()"',
    'const conv = new Date(ms)', // 带参换算是纯日历运算，不算时钟直读
  ].join('\n'))
  assert.equal(c.clockReads, 3, 'Date.now + 无参 new Date + 模板串插值各 1；注释/字符串/带参换算不计')
  assert.equal(c.mathRandom, 1)
})

test('G8 自检：棘轮抓上涨、抓降了未同步基线（过期即失败）', () => {
  const base = { clockReads: 1, mathRandom: 0, fsImports: 0, fsCalls: 0 }
  assert.ok(adapterFaceViolations({ clockReads: 2, mathRandom: 0, fsImports: 0, fsCalls: 0 }, base).some(v => v.includes('clockReads')), '涨了必须失败')
  assert.ok(adapterFaceViolations({ clockReads: 0, mathRandom: 0, fsImports: 0, fsCalls: 0 }, base).some(v => v.includes('clockReads')), '降了未同步基线必须失败（过期即失败）')
  assert.deepEqual(adapterFaceViolations({ ...base }, base), [], '一致则绿')
})

test('G8 适配器面：engine 内时钟/随机直读与 node:fs 依赖按基线棘轮（#175 阶段①起受控）', () => {
  const measured = adapterFaceTotals(ROOT)
  assert.ok(measured.fsImports > 0, 'engine 的 node:fs 导入数为 0 但受控面没登记——扫描面塌了会静默恒过（外移完成后再把这条断言收紧为 == 0）')
  const bad = adapterFaceViolations(measured, BASELINE.adapterFace ?? {})
  assert.deepEqual(bad, [], `适配器面棘轮不符基线：\n${bad.join('\n')}\n（Clock/Rng 走 engine/clock.ts 端口、fs 走 vault 存储端口；io.ts 的 atomicWrite tmp 命名是登记过的例外）`)
})

