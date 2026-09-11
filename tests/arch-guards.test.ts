/**
 * 架构门（#165 / ADR-0047）：构成约定只活在注释与 ADR 里 = 不存在，跑进 npm test 才算存在。
 *
 * 门清单（全部零依赖、文本／加载层面、`node:test` 原生、随 `npm test` 全量执行）：
 *   G1 未定义标识符       —— 硬门 0（剥注释与字符串后「被当函数调用却未声明未导入」即失败）
 *   G2／G2b 宿主装配面    —— 硬门（动态 import 入口与技术层；入口三件套齐备、文件非空）
 *   G3 窄面三向一致       —— 缺件方向硬门 0 + 多余接线按基线棘轮（第三方向＝门面接线件）
 *   G4 窄面宽度（三槽位） —— 棘轮（handles／facade／fns 逐槽位卡基线）
 *   G5 文件规模           —— 棘轮（逐文件行数卡基线；views 叶子／types.ts 大表在白名单外）
 *   G6 顶层不变量         —— 硬门（除教练层 proposals.ts 外无模块调用图写原语）
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
import { faceOf, scanDepsFaces, depthOneKeys } from '../scripts/scan-deps-face.mjs'
import { scanSizes, srcFiles, whitelistHits, SIZE_WHITELIST } from '../scripts/scan-budget.mjs'
import { scanGraphWriters, graphWriteCallers, GRAPH_WRITE_WHITELIST } from '../scripts/scan-invariant.mjs'
import { BASELINE_FILE, measure, readBaseline, depsFaceViolations, sizeViolations, missingDirectionViolations } from '../scripts/arch-baseline.mjs'

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
  for (const n of ['llmComplete', 'llmSeam', 'llmStreamOnce', 'llmView', 'contentEffort']) {
    assert.equal(typeof llm[n], 'function', `host/llm.ts 缺导出 ${n}`)
  }
  const http = await import('../src/host/http.ts')
  for (const n of ['sendJson', 'readJson', 'need', 'injectKatexIfMathed', 'PAGE_DIST', 'VENDOR_DIST', 'FILE_MIME', 'ASSET_MIME']) {
    assert.ok(http[n] !== undefined, `host/http.ts 缺导出 ${n}`)
  }
})

test('G2b src 下的入口文件存在且非空（防止误删/误移）', () => {
  for (const rel of ['index.ts', 'host/llm.ts', 'host/http.ts', 'engine/index.ts']) {
    assert.ok(statSync(join(SRC, rel)).size > 0, `${rel} 缺失或为空`)
  }
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

test('G3 自检：多余接线看得见（门不是恒过）', () => {
  const face = faceOf(FIXTURE_SRC, FIXTURE_FACADE, 'fixture.ts')
  assert.deepEqual(face?.surplus, ['extraGhost'], '接了一条 deps 没声明的线却看不见 = 门恒过')
  assert.deepEqual(face?.dead, [], '夹具里声明全部在用')
  assert.deepEqual(face?.missing, [], '夹具里实用全部已声明')
  assert.deepEqual(face?.unwired, [], '夹具里声明全部已接线')
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

test('G3 窄面三向一致：缺件方向为 0，多余接线按基线', () => {
  const faces = scanDepsFaces(ROOT)
  // 收集器可见性自检：扫描面塌成空集时门会静默恒过
  assert.deepEqual(faces.map(f => f.deps).sort(), Object.keys(BASELINE.depsFace).sort(),
    '收集器找到的子系统与基线不一致（改名／新增／漏扫都会到这里）')
  const bad = [...missingDirectionViolations(faces), ...depsFaceViolations(measure(ROOT).depsFace, BASELINE.depsFace)]
  assert.deepEqual(bad, [], `窄面三向一致门不符基线：\n${bad.join('\n')}`)
})

// ---------------------------------------------------------------- G4 窄面宽度（三槽位）

test('G4 自检：三槽位按声明形式分组（值属性→handles／方法→facade／函数属性→fns）', () => {
  const face = faceOf(FIXTURE_SRC, FIXTURE_FACADE, 'fixture.ts')
  assert.deepEqual(face?.slots, { handles: 2, facade: 1, fns: 1 },
    'store／registry 属 handles，learningDay() 属 facade，jolRng: () => number 属 fns（嵌套子面成员不计）')
})

test('G4 自检：棘轮抓 depsFace 的每一类漂移与幽灵条目（门不是恒过）', () => {
  const base = { A: { declared: 4, used: 4, wired: 5, slots: { handles: 2, facade: 1, fns: 1 }, surplus: ['x'], phantom: [] } }
  const now = (over: Record<string, unknown>) => ({ A: { ...base.A, ...over } })
  const at = (measured: Record<string, unknown>) => depsFaceViolations(measured, base)
  assert.ok(at(now({ declared: 5 })).some(v => v.includes('[棘轮] A.declared')), '声明数漂移必须失败')
  assert.ok(at(now({ wired: 6 })).some(v => v.includes('[棘轮] A.wired')), '接线数漂移必须失败')
  assert.ok(at(now({ slots: { handles: 3, facade: 1, fns: 1 } })).some(v => v.includes('[宽度棘轮] A.handles')), '宽度槽位漂移必须失败')
  assert.ok(at(now({ wired: 4, surplus: [] })).some(v => v.includes('[棘轮] A.surplus')), '多余接线清掉未同步基线必须失败')
  assert.ok(at(now({ phantom: ['x'] })).some(v => v.includes('[棘轮] A.phantom')), 'phantom 漂移必须失败')
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
