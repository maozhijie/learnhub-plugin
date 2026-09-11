/**
 * 适配器面扫描（#175 阶段① / ADR-0044 四层表）：engine 内对时钟、随机与 node:fs
 * 的直读计数——适配器外移的棘轮测量。端口（Clock/Rng/VaultFs 形状）住应用层、
 * 实现住 host/、装配住投递层后，engine 内这些直读只许降不许升（基线棘轮），
 * 目标归零。
 *
 * 扫描面：src/engine/ 全部 .ts（域 + 应用层；host/ 是适配器本身，读时钟/碰 fs 合法）。
 *
 * 计数口径：
 *   clockReads —— `Date.now(` 与无参 `new Date()`（读「当前时刻」）。`new Date(<参数>)`
 *                 是纯日历换算（域层正当形态），不计。
 *   mathRandom — `Math.random` 直读（随机源端口 = Rng）。
 *   fsImports —— `node:fs`／`node:fs/promises` 的 import 语句数（含动态 import）。
 *   fsCalls  —— 导入的 fs 函数在文件内的调用点数（别名导入按别名计；动态 import
 *               的命名空间调用按 `<别名>.<方法>(` 计）。
 *
 * 已登记的例外（不设白名单机制，基线精确匹配天然把它们钉死）：
 *   - io.ts `atomicWrite` 的 tmp 文件名含 `Date.now()`（ADR-0046：tmp 命名属适配器
 *     关注点；io.ts 是 R5 零相对导入叶子，不能反向 import clock 端口类型，故保留
 *     直读并在此登记——engine 内唯一有理由的时钟直读）。
 *
 * 注释与字符串先剥（undefined-scan 的 strip 同源），免得注释里的模式名虚增计数；
 * fsImports 数 import 语句本身，在剥字符串后的文本上会丢（`from 'node:fs'` 的引号
 * 被 strip 吃掉），故在原文上单独数。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 计数专用剥离：剥注释与 ' " 字符串，但**保留模板字符串的 `${...}` 插值内容**——
 * atomicWrite 的 tmp 名把 Date.now() 嵌在模板串里（`${p}.tmp-${Date.now()}`），
 * 通用 strip（undefined-scan）把整段模板串吃掉，例外点就对门不可见——收集器
 * 静默看不见已知形态，正是 ADR-0047 的 R3 教训。状态栈处理嵌套（插值里可以有
 * 对象字面量与再嵌的模板串）。
 */
export function stripForCount(code) {
  const out = []
  const stack = [] // {kind:'tpl', lit} 模板串字面段 | {kind:'interp', depth} ${} 插值
  let i = 0
  const n = code.length
  const flush = () => {
    const t = stack[stack.length - 1]
    if (t && t.kind === 'tpl') { out.push(t.lit.replace(/[^\n]/g, ' ')); t.lit = '' }
  }
  while (i < n) {
    const top = stack[stack.length - 1]
    if (top?.kind === 'tpl') {
      const c = code[i]
      if (c === '\\') { top.lit += '  '; i += 2; continue }
      if (c === '`') { flush(); out.push('`'); stack.pop(); i += 1; continue }
      if (c === '$' && code[i + 1] === '{') {
        flush(); out.push('${'); stack.push({ kind: 'interp', depth: 0 }); i += 2; continue
      }
      top.lit += c; i += 1; continue
    }
    if (top?.kind === 'interp') {
      const c = code[i]
      if (c === '{') { top.depth += 1; out.push(c); i += 1; continue }
      if (c === '}') {
        if (top.depth === 0) { stack.pop(); out.push('}'); i += 1; continue }
        top.depth -= 1; out.push(c); i += 1; continue
      }
    }
    const c = code[i]
    const d = code[i + 1]
    if (c === '/' && d === '*') {
      const j = code.indexOf('*/', i + 2)
      out.push(' ')
      i = j === -1 ? n : j + 2
    } else if (c === '/' && d === '/') {
      const j = code.indexOf('\n', i)
      i = j === -1 ? n : j
    } else if (c === "'" || c === '"') {
      out.push('""')
      i += 1
      while (i < n && code[i] !== c) { if (code[i] === '\\') i += 1; i += 1 }
      i += 1
    } else if (c === '`') {
      out.push('`'); stack.push({ kind: 'tpl', lit: '' }); i += 1
    } else {
      out.push(c); i += 1
    }
  }
  return out.join('')
}

/** 单文件计数（纯函数；自检直接喂文本样本）。 */
export function countAdapterFace(code) {
  const stripped = stripForCount(code)
  const clockReads =
    (stripped.match(/\bDate\.now\s*\(/g) ?? []).length +
    (stripped.match(/\bnew\s+Date\s*\(\s*\)/g) ?? []).length
  const mathRandom = (stripped.match(/\bMath\.random\b/g) ?? []).length
  const importRe = /from\s+['"]node:fs(\/promises)?['"]|import\s*\(\s*['"]node:fs(\/promises)?['"]\s*\)/g
  const fsImports = (code.match(importRe) ?? []).length
  let fsCalls = 0
  // 具名导入（含别名）：import { readFile as rf, existsSync } from 'node:fs'
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:fs(\/promises)?['"]/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) fsCalls += (stripped.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) ?? []).length
    }
  }
  // 动态导入的命名空间调用：const fs = await import('node:fs/promises') → fs.readdir(...)
  for (const m of code.matchAll(/(\w+)\s*=\s*await\s+import\s*\(\s*['"]node:fs(\/promises)?['"]/g)) {
    fsCalls += (stripped.match(new RegExp(`\\b${m[1]}\\.\\w+\\s*\\(`, 'g')) ?? []).length
  }
  return { clockReads, mathRandom, fsImports, fsCalls }
}

export function engineFiles(root = process.cwd()) {
  const dir = join(root, 'src', 'engine')
  const out = []
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  walk(dir)
  return out
}

/** 全量扫描：合计 + 逐文件明细（违规消息里定位用）。 */
export function scanAdapterFace(root = process.cwd()) {
  const total = { clockReads: 0, mathRandom: 0, fsImports: 0, fsCalls: 0 }
  const files = {}
  for (const f of engineFiles(root)) {
    const c = countAdapterFace(readFileSync(f, 'utf8'))
    files[f.slice(root.length + 1)] = c
    for (const k of Object.keys(total)) total[k] += c[k]
  }
  return { ...total, files }
}

/** 只取合计（基线形状：四个标量的精确匹配棘轮）。 */
export function adapterFaceTotals(root = process.cwd()) {
  const { clockReads, mathRandom, fsImports, fsCalls } = scanAdapterFace(root)
  return { clockReads, mathRandom, fsImports, fsCalls }
}

/** 棘轮比较（纯函数；自检喂假样本）。实际 == 基线：涨了失败、降了未同步也失败。 */
export function adapterFaceViolations(measured, baseline) {
  const LABELS = {
    clockReads: '时钟直读（Date.now()/new Date()）',
    mathRandom: 'Math.random 直读',
    fsImports: 'engine 的 node:fs import',
    fsCalls: 'engine 的 fs 调用点',
  }
  const bad = []
  for (const key of Object.keys(LABELS)) {
    const now = measured[key]
    const was = baseline?.[key]
    if (typeof was !== 'number') {
      bad.push(`[新受控量] adapterFace.${key} 不在基线里（#175 阶段①起受控）`)
      continue
    }
    if (now !== was) {
      const d = now - was
      bad.push(`[适配器面棘轮] ${key}（${LABELS[key]}）: 基线 ${was} → 实测 ${now}（${d > 0 ? '+' : ''}${d}）`
        + `\n    ${d > 0 ? '涨了：engine 内不该新增直读——走 Clock/Rng/VaultFs 端口' : '降了：好——同一提交里把基线一并下调（过期即失败）'}`)
    }
  }
  return bad
}
