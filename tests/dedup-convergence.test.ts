/**
 * #172 重复实现收敛：对照测试 + 单一出处门。
 *
 * 两件事：
 * 1. 对照——每个单一出处与其收敛前的参考公式「同一输入、同一输出」内联对照；
 *   出处语义被人改动时这里先红（不改对外行为的收敛，输出必须逐值不变）。
 * 2. 单一出处门——文本扫描断言七组模式在出处模块之外零残留（与 import-rules /
 *   arch-guards 同族：零依赖、文本扫描、自带「必然违规样本」自检）。
 *
 * 口径锚（ADR-0020）：calendarDayOf = 日历日（出处戳/统计窗），dayOfTs = 学习日
 * （调度/结算）；两者在 cutoff=0 时恒等，cutoff>0 时允许分叉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { round2, clamp01, pctOf } from '../src/engine/grading.ts'
import { DAY_MS, calendarDayOf, dayOfTs, fmtDay, addDays } from '../src/engine/dates.ts'
// 来源键经 anki.ts 原路径导入——有意验证 re-export 接缝未晃（本体在 types.ts）
import { sourceKeyOf, parseSourceKey, nodeKeyOf } from '../src/engine/anki.ts'
import { PROPOSAL_STATUSES } from '../src/engine/types.ts'
import { saveNote } from '../src/engine/notes.ts'

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine')

// ---- 对照：两位舍入（参考公式 Math.round(x * 100) / 100，原 15 处）----

test('round2 与参考公式逐值一致（含边界与噪声值）', () => {
  const samples = [0, 1, -1, 0.5, 2 / 3, 0.12345, 0.005, 1.005, -1.005, 99.999, 1234.567, 1e-8, 42]
  for (const x of samples) assert.equal(round2(x), Math.round(x * 100) / 100, `round2(${x})`)
})

// ---- 对照：clamp01（参考公式 Math.min(1, Math.max(0, x))，原 7 处）----

test('clamp01 与参考公式逐值一致（下界、上界、越界双侧）', () => {
  const samples = [-3, -0.5, 0, 0.25, 0.999, 1, 1.5, 100]
  for (const x of samples) assert.equal(clamp01(x), Math.min(1, Math.max(0, x)), `clamp01(${x})`)
})

// ---- 对照：百分比格式化（参考公式 `${Math.round(x * 100)}%`，原 5 处本地 pct）----

test('pctOf 与参考公式逐值一致', () => {
  const samples = [0, 0.0625, 0.1234, 0.4567, 0.999, 1, 0.5]
  for (const x of samples) assert.equal(pctOf(x), `${Math.round(x * 100)}%`, `pctOf(${x})`)
})

// ---- 对照：日毫秒常量 + 日历日（dates.ts 单点）----

test('DAY_MS 恒等 86400000；addDays 走它推日不漂移', () => {
  assert.equal(DAY_MS, 86400000)
  assert.equal(DAY_MS, 24 * 60 * 60 * 1000)
  assert.equal(addDays('2026-09-11', 1), '2026-09-12')
  assert.equal(addDays('2026-09-11', -1), '2026-09-10')
  assert.equal(addDays('2026-02-28', 1), '2026-03-01') // 平年
  assert.equal(addDays('2028-02-28', 1), '2028-02-29') // 闰年
})

test('calendarDayOf 恒等 ts.slice(0, 10)；cutoff=0 时与学习日 dayOfTs 恒等', () => {
  const samples = [
    '2026-09-11T01:30:00',
    '2026-09-11',
    '2026-09-11T23:59:59',
    'garbage!!',
    '',
  ]
  for (const ts of samples) assert.equal(calendarDayOf(ts), ts.slice(0, 10), `calendarDayOf(${ts})`)
  assert.equal(calendarDayOf('2026-09-11T01:30:00'), '2026-09-11')
  // 口径锚：无日界（cutoff=0）时两种口径重合；有日界才分叉
  assert.equal(dayOfTs('2026-09-11T01:30:00'), calendarDayOf('2026-09-11T01:30:00'))
  assert.equal(dayOfTs('2026-09-11T01:30:00', 120), '2026-09-10') // 02:00 日界：凌晨归前一日
  // Date 侧的日历日 = fmtDay（同一 UTC 日分量，与旧 toISOString().slice(0,10) 恒等）
  assert.equal(fmtDay(new Date(Date.UTC(2026, 8, 11, 1, 30))), '2026-09-11')
})

// ---- 对照：复合键（anki.ts 来源键 = 既有解析同址；nodeKeyOf 同族）----

test('sourceKeyOf/parseSourceKey 往返一致；nodeKeyOf 同族拼接', () => {
  assert.equal(sourceKeyOf('课程', '节点', 'q1'), '课程/节点/q1')
  const round = parseSourceKey(sourceKeyOf('课程', '节点/含/斜杠', 'q42'))
  assert.deepEqual(round, { course: '课程', node: '节点/含/斜杠', qid: 'q42' }) // 节点可含 /，题 id 取尾段
  assert.equal(parseSourceKey('没有分隔'), null)
  assert.equal(parseSourceKey('/q1'), null)
  assert.equal(nodeKeyOf('课程', '节点'), '课程/节点')
})

// ---- 对照：提案状态字面量（types.ts 单点，模式随 PROPOSAL_KINDS）----

test('PROPOSAL_STATUSES 与既有字面量数组一致', () => {
  assert.deepEqual([...PROPOSAL_STATUSES], ['pending', 'applied', 'rejected'])
})

// ---- 单一出处门：七组模式在出处模块之外零残留（含自检）----

function engineFiles(): Array<{ name: string; code: string }> {
  return readdirSync(ENGINE).filter(f => f.endsWith('.ts'))
    .map(f => ({ name: f, code: String(readFileSync(join(ENGINE, f), 'utf8')) }))
}

/** 门自检：构造必然违规的样本，断言正则真能咬住（恒过的门比没有门更坏）。 */
function selfCheck(re: RegExp, bad: string, label: string): void {
  assert.ok(re.test(bad), `[自检] ${label} 的正则咬不住违规样本，规则形同虚设`)
}

test('单一出处门：七组收敛模式在出处外零残留', () => {
  const gates: Array<{ label: string; re: RegExp; home: string; bad: string }> = [
    {
      label: '两位舍入',
      re: /Math\.round\([^\n]*\* 100\) \/ 100/,
      home: 'grading.ts',
      bad: 'const x = Math.round((a / b) * 100) / 100',
    },
    {
      label: 'clamp01 内联',
      re: /Math\.min\(1, Math\.max\(0, /,
      home: 'grading.ts',
      bad: 'const y = Math.min(1, Math.max(0, v))',
    },
    {
      label: '百分比格式化',
      re: /Math\.round\([^`\n]*\* 100\)\}%`/,
      home: 'grading.ts',
      bad: 'const pct = (v: number) => `${Math.round(v * 100)}%`',
    },
    {
      label: '日毫秒字面量',
      re: /\b86400000\b/,
      home: 'dates.ts',
      bad: 'const d = new Date(t + i * 86400000)',
    },
    {
      label: '时间戳取日历日',
      re: /\.ts\.slice\(0, ?10\)|toISOString\(\)\.slice\(0, ?10\)/,
      home: 'dates.ts',
      bad: 'const day = rec.ts.slice(0, 10)',
    },
    {
      label: '三段来源键拼接',
      re: /`\$\{[^}`]+\}\/\$\{[^}`]+\}\/\$\{[^}`]*qid[^}`]*\}`/,
      home: 'types.ts',
      bad: 'const k = `${r.course}/${r.node}/${r.qid}`',
    },
    // 两段节点键 `${course}/${node}` 不设文本门：与 `${dir}/${file}` 一类合法路径
    // 拼接在文本上不可区分（误咬比漏咬更坏）；收敛由调用点改造 + 对照测试覆盖。
    {
      label: '提案状态字面量数组',
      re: /\['pending', 'applied', 'rejected'\]/,
      home: 'types.ts',
      bad: "if (!['pending', 'applied', 'rejected'].includes(s)) throw new Error('x')",
    },
  ]
  for (const g of gates) selfCheck(new RegExp(g.re.source), g.bad, g.label)
  const offenders: string[] = []
  for (const { name, code } of engineFiles()) {
    for (const g of gates) {
      if (name === g.home) continue
      // 剥行注释与块注释，避免文档/示例文本误咬
      const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (g.re.test(bare)) offenders.push(`${name} ← ${g.label}`)
    }
  }
  assert.deepEqual(offenders, [], `[单一出处] 七组模式仍有残留：\n${offenders.join('\n')}`)
})

// ---- #173 原子写倒挂：正典写入器经 atomicWrite（tmp + rename），落盘零 tmp 残留 ----

test('saveNote 原子落盘：内容完整、目录零 tmp 残留、自动建父目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lh-atomic-'))
  try {
    const notePath = join(dir, '区', '节点.md')
    await saveNote(notePath, { node: '节点', content: { version: 1 } }, '## 正文')
    const leftovers = (await readdir(dir, { recursive: true })).filter(f => String(f).includes('.tmp-'))
    assert.deepEqual(leftovers, [], `tmp 残留：${leftovers.join('、')}`)
    const content = await readFile(notePath, 'utf8')
    assert.ok(content.startsWith('---\n'), 'frontmatter 头缺失')
    assert.ok(content.trimEnd().endsWith('## 正文'), '正文缺失')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
