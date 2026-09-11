/**
 * 窄面三向一致 + 三槽位宽度扫描（#165 门 G3／G4；ADR-0043 / ADR-0047）。
 *
 * 三向＝「deps 接口声明」↔「类体 this.e.X 实用」↔「门面 new XSubsystem({…}) 提供的键」：
 *   dead    声明了却从不使用（死成员）
 *   missing 用了却未声明（运行期 undefined 调用的前兆）
 *   unwired 声明了但门面接线没给（装配缺件 → 运行期 undefined）
 *   surplus 接线给了但 deps 没声明（多余接线；其中门面上不存在同名成员的＝ phantom）
 * 四个方向**都是硬门 0**（surplus／phantom 在 #171 清理到 0 后由棘轮转硬门，不进基线）。
 *
 * 第三方向只取接线字面量的 **brace-depth-1** 键：ChannelsSubsystem 的
 * `registry: { load, loadNoteSources, save, get }` 是嵌套窄子面（ChannelsDeps 以结构化
 * 窄面声明它），按扁平正则抽取会把子面成员误计为顶层接线——实测会伪造出 4 条不存在的
 * phantom。宽度门同款：嵌套子面只算父成员一个（顶层成员计）。
 *
 * 三槽位（宽度门的槽位归属是**声明形式**规则，本注释即规范）：
 *   handles 属性且类型不是函数类型 → 领域实例与值（store／paths／registry／bank／…）
 *   facade  方法签名（含 generator）→ 回引门面的方法
 *   fns     属性且类型是函数类型（`jolRng: () => number`）→ 注入的纯函数
 *
 * 用法：node scripts/scan-deps-face.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ENGINE_DIR = 'src/engine'
const FACADE_FILE = 'src/engine/index.ts'

/** 从 `{` 位置取配对正文（不含两端括号）。 */
export function braceBody(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return src.slice(openIdx + 1)
}

/** 一个文件里**全部** `export interface XDeps {` 的正文（一处一子系统，但布局变了也不漏）。 */
function depsBodies(src) {
  const out = []
  for (const m of src.matchAll(/export interface (\w*Deps)\s*\{/g)) {
    out.push({ deps: m[1], body: braceBody(src, src.indexOf('{', m.index)) })
  }
  return out
}

/** 与 deps 接口配对的那个类：接口之后的第一个 `export class`。 */
function pairedClass(src, depsName) {
  const at = src.indexOf(`export interface ${depsName}`)
  const m = src.slice(at).match(/export class (\w+)\s*\{/)
  if (!m) return null
  const openIdx = at + m.index + m[0].length - 1
  return { cls: m[1], body: braceBody(src, openIdx) }
}

/**
 * deps 接口正文 → 顶层成员声明 `{ name, slot }`。
 * 顶层＝缩进恰两格的成员行；嵌套子面的成员缩进更深，只算父成员一个（宽度门口径）。
 */
export function declaredMembers(body) {
  const out = []
  const starts = [...body.matchAll(/^ {2}(\w+)/gm)]
  starts.forEach((m, i) => {
    const to = i + 1 < starts.length ? starts[i + 1].index : body.length
    const seg = body.slice(m.index, to)
    const name = m[1]
    const rest = seg.slice(2 + name.length)
    // 成员声明：名字后面接 `(`／`<`（方法）、`:`（属性）、`?`（选填）——注释行里的词不算
    if (!/^\s*\??\s*[(:<]/.test(rest)) return
    let slot
    if (/^\s*\??\s*[<(]/.test(rest)) slot = 'facade'
    else {
      const typeText = rest.slice(rest.indexOf(':') + 1).split('{')[0]
      slot = typeText.includes('=>') ? 'fns' : 'handles'
    }
    out.push({ name, slot })
  })
  return out
}

/** 类体 `this.e.X` 实用集合（依赖只从构造函数参数 `private e: XDeps` 拿）。 */
export function usedMembers(clsBody) {
  const out = new Set()
  for (const m of clsBody.matchAll(/this\.e\.(\w+)/g)) out.add(m[1])
  return out
}

/**
 * 对象字面量的 brace-depth-1 键：只在「键位置」（`{`／`,` 之后）取 `name:`，
 * 简写键（`store,`）同样算一个键——**跳过注释、字符串与嵌套块**，
 * 嵌套子面的成员因此天然不计。
 */
export function depthOneKeys(span) {
  const keys = []
  let depth = 0
  let atKey = true
  let i = 0
  while (i < span.length) {
    const ch = span[i]
    if (ch === '/' && span[i + 1] === '/') {
      const nl = span.indexOf('\n', i)
      i = nl === -1 ? span.length : nl
      continue
    }
    if (ch === '/' && span[i + 1] === '*') {
      const end = span.indexOf('*/', i + 2)
      i = end === -1 ? span.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1
      while (i < span.length) {
        if (span[i] === '\\') { i += 2; continue }
        if (span[i] === ch) { i += 1; break }
        i += 1
      }
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') { depth += 1; i += 1; continue }
    if (ch === '}' || ch === ')' || ch === ']') { depth -= 1; i += 1; continue }
    if (depth === 0) {
      if (ch === ',') { atKey = true; i += 1; continue }
      if (atKey && /[A-Za-z_$]/.test(ch)) {
        const word = /^[A-Za-z_$][\w$]*/.exec(span.slice(i))[0]
        const after = span.slice(i + word.length)
        const colon = /^\s*:/.exec(after)
        // 简写键：裸标识符后面直接是 `,` 或 `}`（不是 `:` 也不是调用/成员访问）
        const shorthand = !colon && /^\s*[,}]/.test(after)
        if (colon || shorthand) {
          keys.push(word)
          atKey = false
          i += word.length + (colon ? colon[0].length : 0)
          continue
        }
        atKey = false
      }
    }
    i += 1
  }
  return keys
}

/** 门面上已声明的成员名（方法、属性、getter 都算——phantom 判定用）。 */
export function facadeMembers(facadeSrc) {
  const at = facadeSrc.indexOf('export class LearnhubEngine')
  if (at === -1) return new Set()
  const body = braceBody(facadeSrc, facadeSrc.indexOf('{', at))
  const out = new Set()
  const re = /^ {2}(?:(?:static|readonly|async|get|set|public|private|protected|declare|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*[(<:=]/gm
  for (const m of body.matchAll(re)) out.add(m[1])
  return out
}

/** 门面 `new XSubsystem({ … })` 的接线键（同一类多处构造取并集，去重保序）。 */
export function wiringKeys(facadeSrc, cls) {
  const re = new RegExp(`new ${cls}\\(\\{`, 'g')
  const out = []
  for (const m of facadeSrc.matchAll(re)) {
    for (const k of depthOneKeys(braceBody(facadeSrc, m.index + m[0].length - 1))) {
      if (!out.includes(k)) out.push(k)
    }
  }
  return out
}

/** 受控量（基线形状的**单一出处**）：加一个新受控量只改这里，门与基线自动跟上。 */
export const FACE_SCALARS = ['declared', 'used', 'wired']
export const FACE_SLOTS = ['handles', 'facade', 'fns']

/**
 * `surplus`／`phantom` **不进基线**（#171 清理后转硬门 0，与 dead／missing／unwired 同档）：
 * 基线是「可以棘轮化的债」的形状，而多余接线清到 0 后没有任何一条是合法的——一个恒须为空的
 * 清单留在基线里只会沉淀成幽灵条目；且「接了一条没声明的线」本该直接失败，不该走「顺手改基线」。
 * 这正是 ADR-0047「清理后转硬门 0」的落地；判定在 `arch-baseline.mjs` 的 assemblyViolations。
 */

/** 单个子系统的受控量快照（基线里存的就是它）。 */
export function faceSnapshot(face) {
  const snap = {}
  for (const k of FACE_SCALARS) snap[k] = face[k === 'declared' ? 'declaredCount' : k === 'used' ? 'usedCount' : 'wiredCount']
  snap.slots = face.slots
  return snap
}

/**
 * 单个子系统的三向一致 + 分槽记录（**纯函数**：喂源码，不读盘——自检用假样本）。
 * 三个方向都以 `declared` 为基准：dead＝声明未用、missing＝用而未声明、unwired／surplus＝接线两侧。
 */
export function faceOf(src, facadeSrc, file = '', depsName = null) {
  const deps = depsName ? depsBodies(src).find(d => d.deps === depsName) : depsBodies(src)[0]
  if (!deps) return null
  const pair = pairedClass(src, deps.deps)
  if (!pair) return null
  const faceMembers = facadeMembers(facadeSrc)
  const declared = declaredMembers(deps.body)
  const declaredNames = declared.map(d => d.name)
  const used = usedMembers(pair.body)
  const wired = wiringKeys(facadeSrc, pair.cls)
  const surplus = wired.filter(k => !declaredNames.includes(k))
  const slots = Object.fromEntries(FACE_SLOTS.map(s => [s, 0]))
  for (const d of declared) if (d.slot in slots) slots[d.slot] += 1
  return {
    file,
    deps: deps.deps,
    cls: pair.cls,
    declared: declaredNames,
    declaredCount: declaredNames.length,
    usedCount: used.size,
    slots,
    wiredCount: wired.length,
    dead: declaredNames.filter(n => !used.has(n)).sort(),
    missing: [...used].filter(n => !declaredNames.includes(n)).sort(),
    unwired: declaredNames.filter(n => !wired.includes(n)).sort(),
    surplus: surplus.sort(),
    phantom: surplus.filter(k => !faceMembers.has(k)).sort(),
  }
}

/** 扫描全部子系统（递归读盘），按发现顺序返回；每个 Deps 接口一条记录。 */
export function scanDepsFaces(root = process.cwd(), dir = ENGINE_DIR, facadeFile = FACADE_FILE) {
  const abs = p => join(root, p)
  const facadeSrc = readFileSync(abs(facadeFile), 'utf8')
  const out = []
  const walk = rel => {
    for (const e of readdirSync(abs(rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.ts')) continue
      const src = readFileSync(abs(p), 'utf8')
      for (const { deps } of depsBodies(src)) {
        const face = faceOf(src, facadeSrc, p, deps)
        if (face) out.push(face)
      }
    }
  }
  walk(dir)
  return out
}

/**
 * 四个「装配」方向（dead／missing／unwired／surplus）是**装配断裂**，不是可棘轮化的债：
 * 它们必须恒为 0，不进基线。**门（`arch-baseline.mjs` / `arch-guards.test.ts`）与 CLI
 * （本文件）共用这一处判定**，免得两处各写一套四向清单与文案（会漂）。
 * `surplus` 在 #171 把 30 条多余接线清到 0 后由棘轮转本档（ADR-0047「清理后转硬门 0」）：
 * 一个恒须为空的清单留在基线里只会沉淀成幽灵条目。
 */
export function faceViolations(faces) {
  const bad = []
  for (const f of faces) {
    if (f.dead.length) bad.push(`[硬门] ${f.deps} dead（声明未用）: ${f.dead.join(', ')}`)
    if (f.missing.length) bad.push(`[硬门] ${f.deps} missing（用而未声明）: ${f.missing.join(', ')}`)
    if (f.unwired.length) bad.push(`[硬门] ${f.deps} unwired（声明未接线）: ${f.unwired.join(', ')}`)
    if (f.surplus.length) {
      const phantom = f.phantom?.length ? `\n    其中 phantom（门面上根本没有这个成员）: ${f.phantom.join(', ')}` : ''
      bad.push(`[硬门] ${f.deps} surplus（接了一条 deps 没声明的线）: ${f.surplus.join(', ')}${phantom}`)
    }
  }
  return bad
}

if (process.argv[1] && process.argv[1].includes('scan-deps-face')) {
  const rows = scanDepsFaces()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2))
    process.exit(0)
  }
  for (const r of rows) {
    console.log(`${r.cls}（${r.deps}）声明 ${r.declaredCount} ／ 实用 ${r.usedCount} ／ 接线 ${r.wiredCount}`)
    console.log(`  槽位 handles ${r.slots.handles} ／ facade ${r.slots.facade} ／ fns ${r.slots.fns}`)
  }
  const bad = faceViolations(rows)
  if (bad.length) {
    console.error(`\n✗ ${bad.length} 处装配断裂（dead／missing／unwired／surplus 都是硬门 0）：\n${bad.map(b => `  · ${b}`).join('\n')}`)
    process.exit(1)
  }
  console.log('\n✓ 四向装配一致（dead／missing／unwired／surplus 全 0）')
}
