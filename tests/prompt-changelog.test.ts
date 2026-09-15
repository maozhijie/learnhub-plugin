/**
 * 提示词 changelog 纪律门（#220 / ADR-0072）：把「改模板＝改生产行为」变成会失败的东西。
 *
 * 三条门的测试面各按自己的真伪判据：
 * - **登记门（提交级）**：`scripts/prompt-bump.mts check`——**真 git 历史**上跑一遍（当前历史
 *   必须绿），并在临时仓库里造「bump 不补登记」的提交断言**变红**（验收原文：对 bump 无
 *   changelog 变红、对合规变更绿）；纯函数另按合成 diff 逐类自检。
 * - **语料回放**：回放装置对**真实模型输出**的判定必须与 #216 spike 语料记录的
 *   delivered/schema_ok 一致（回放面忠实性的实测链），合成语料另测回归检出。
 * - **评审对照**：纯函数按两报告对照自检（不降/下降/非同源/零样本四态）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHANGELOG_FILE, MARKER_RE, TEMPLATE_FILES, bumpViolations, compareReviewReports, markerVersionsOf, parseLogDiff, replayCorpus, replayViolations, templateVersionsOf,
} from '../scripts/prompt-bump.mts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SCRIPT = join(ROOT, 'scripts', 'prompt-bump.mts')

/** 合成登记表原文：**逐字照真文件的排版**——条目 `{` 单独一行、条目行以 `    version: N,`
 * 起（提交级门按此形态认「本提交新增了登记条目」，合成件必须同形，否则测的是另一回事）。 */
function changelogText(entries: Array<[number, string]>): string {
  const items = entries
    .map(([v, t]) => `    version: ${v}, date: '2026-09-13', changeType: '${t}',\n    expectedDelta: 'z',`)
    .join('\n  }, {\n')
  return `export const PROMPT_CHANGELOG = {\n  课程大纲: [{\n${items}\n  }],\n}\n`
}

/** 跑 CLI（子进程；cwd 可注入——临时仓库要用）。 */
function cli(args: string[], cwd = ROOT): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['--experimental-transform-types', SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

// ---------------------------------------------------------------- ① 提交级登记门

test('#220 登记门：解析 diff 找到新增的版本标记与登记条目（纯函数按合成 diff 自检）', () => {
  const log = [
    '@@COMMIT aaaa1111 feat: bump 模板',
    `+++ b/${TEMPLATE_FILES[0]}`,
    '+<!-- learnhub:prompt/v12 -->',
    '+<!-- learnhub:prompt/v12 -->',
    ' context line with <!-- learnhub:prompt/v11 -->',
    '-<!-- learnhub:prompt/v11 -->',
    '+++ b/' + CHANGELOG_FILE,
    '+    version: 12, date: \'2026-09-13\', changeType: \'x\',',
    '',
    '@@COMMIT bbbb2222 chore: 无关提交',
    '+++ b/src/engine/tree.ts',
    '+  const x = 1',
  ].join('\n')
  const [first, second] = parseLogDiff(log)
  assert.equal(first!.sha, 'aaaa1111')
  assert.equal(first!.subject, 'feat: bump 模板')
  assert.deepEqual(first!.addedMarkers, [12, 12], '两处新增标记都收（同版本出现两次也算）')
  assert.deepEqual(first!.addedChangelogVersions, [12])
  assert.deepEqual(second!.addedMarkers, [])
  assert.deepEqual(markerVersionsOf('a\n<!-- learnhub:prompt/v3 -->\nb\n<!-- learnhub:prompt/v9 -->'), new Set([3, 9]))
  assert.equal(MARKER_RE.test(''), false)
})

test('#220 登记门自检：逐键解析吃掉「版本号跨键撞车」——集合口径会漏判的 bump 现在看得见', () => {
  // 键各自独立计数 → 同一个 v8 天然属于多个键。下面两份文本只差「教练回合」的归属：
  // 前者 v7、后者 bump 到 v8，而 v8 早已被「错误对比卡」占用。集合差口径下后者判
  // 「无新版本号」= 一次真实 bump 隐形（#250 实测踩到：门报「无违规」，但它没看见这次 bump）。
  const before = ['    错误对比卡: `<!-- learnhub:prompt/v8 -->', '    教练回合: `\\', '<!-- learnhub:prompt/v7 -->'].join('\n')
  const after = ['    错误对比卡: `<!-- learnhub:prompt/v8 -->', '    教练回合: `\\', '<!-- learnhub:prompt/v8 -->'].join('\n')
  assert.deepEqual([...templateVersionsOf(before).keys], [['错误对比卡', 8], ['教练回合', 7]])
  assert.deepEqual([...templateVersionsOf(after).keys], [['错误对比卡', 8], ['教练回合', 8]])
  const unionNew = [...markerVersionsOf(after)].filter(v => !markerVersionsOf(before).has(v))
  assert.deepEqual(unionNew, [], '集合口径：一次真实 bump 的新增版本号为空（这就是那个洞）')
  const perKeyNew = [...templateVersionsOf(after).keys].filter(([k, v]) => templateVersionsOf(before).keys.get(k) !== v).map(([, v]) => v)
  assert.deepEqual(perKeyNew, [8], '逐键口径：同一次 bump 看得见')
  // 键集合与版本逐个解析正确（含带引号的键、标记与键同行的形态）
  const mixed = ['    课程大纲: `\\', '<!-- learnhub:prompt/v12 -->', '    罗盘初画: `<!-- learnhub:prompt/v3 -->'].join('\n')
  assert.deepEqual([...templateVersionsOf(mixed).keys], [['课程大纲', 12], ['罗盘初画', 3]])
  // 键的开行之前的标记无法归属 → 退回集合差口径（历史形态：标记曾住 content.ts 的散文/注释）
  assert.deepEqual([...templateVersionsOf('// <!-- learnhub:prompt/v9 -->\n    键: `\\\n<!-- learnhub:prompt/v2 -->').unkeyed], [9])
})

test('#220 登记门：bump 不补条目/合规/标记挪位三类样本的判定', () => {
  assert.deepEqual(bumpViolations([]), [], '零 bump 零违规')
  const bad = bumpViolations([{ sha: 'a'.repeat(40), subject: 'bump v12', newVersions: [12], registeredVersions: [] }])
  assert.equal(bad.length, 1)
  assert.match(bad[0]!, /v12/)
  assert.deepEqual(
    bumpViolations([{ sha: 'b'.repeat(40), subject: 'bump v12', newVersions: [12], registeredVersions: [11, 12] }]),
    [], '同提交补了条目 = 绿（多余的历史条目不影响）',
  )
  // 标记挪位（版本号没新增）不出现在 bump 记录里 —— `newVersions` 是集合差，不是 diff 行
  assert.deepEqual(parseLogDiff('@@COMMIT cccc3333 fix: 挪模板\n+++ b/x\n+<!-- learnhub:prompt/v11 -->\n')[0]!.addedMarkers, [11])
})

test('#220 登记门（真 git 历史）：当前分支零违规，且扫描面非空（防恒过）', () => {
  const r = cli(['check'])
  assert.equal(r.code, 0, `check 应绿：\n${r.out}`)
  assert.match(r.out, /扫描 [0-9a-f]{8}\.\.HEAD 的 \d+ 个提交/, '扫描面读数必须出现（看不见扫描面就有恒过的可能）')
  assert.match(r.out, /✓ 无违规/)
  const commits = Number(/的 (\d+) 个提交/.exec(r.out)?.[1] ?? '0')
  assert.ok(commits > 0, '纪律起点以来必须至少扫到 1 个触及模板/登记表的提交（扫到 0 个是读数异常）')
})

test('#220 登记门（临时仓库）：bump 不补条目变红 → 补上条目变绿（验收原文两态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-bump-'))
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  const write = (rel: string, body: string): void => {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(dir, rel), body, 'utf8')
  }
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    // 起点：登记面已存在（纪律起点 = PROMPT_CHANGELOG 首次出现的提交，动态发现）
    write(TEMPLATE_FILES[0]!, 'export class Content {\n  // <!-- learnhub:prompt/v11 -->\n}\n')
    write(CHANGELOG_FILE, changelogText([[11, 'x']]))
    git('add', '-A')
    git('commit', '-q', '-m', 'chore: 起点（登记面就位）')
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

    // 违规提交：bump 模板版本但不补条目
    write(TEMPLATE_FILES[0]!, 'export class Content {\n  // <!-- learnhub:prompt/v12 -->\n}\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'feat: bump 模板 v11→v12（无登记）')
    const red = cli(['check', '--since', base], dir)
    assert.equal(red.code, 1, `应红：\n${red.out}`)
    assert.match(red.out, /✗ 1 条违规/)
    assert.match(red.out, /v12 首次出现在本提交/)
    assert.match(red.out, /预期输出增量/)

    // 合规提交：同提交补条目
    write(TEMPLATE_FILES[0]!, 'export class Content {\n  // <!-- learnhub:prompt/v13 -->\n}\n')
    write(CHANGELOG_FILE, changelogText([[11, 'x'], [13, 'bump']]))
    git('add', '-A')
    git('commit', '-q', '-m', 'feat: bump 模板 v12→v13（带登记）')
    const green = cli(['check'], dir)
    assert.equal(green.code, 1, '整体仍红：区间里那个违规提交还在历史里（这正是提交级门的意义）')
    const tail = cli(['check', '--since', execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }).trim()], dir)
    assert.equal(tail.code, 0, `合规提交单独看应绿：\n${tail.out}`)
    assert.match(tail.out, /✓ 无违规/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#237 登记门（临时仓库）：模板面迁移不产生新版本号，且迁移后门仍看得见新路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-bump-move-'))
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  const write = (rel: string, body: string): void => {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(dir, rel), body, 'utf8')
  }
  const OLD = TEMPLATE_FILES[0]!
  const NEW = TEMPLATE_FILES[TEMPLATE_FILES.length - 1]!
  const head = (): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    // 起点：模板在**旧路径**（面里的历史路径），登记面已存在
    write(OLD, 'export class Content {\n  // <!-- learnhub:prompt/v11 -->\n  // <!-- learnhub:prompt/v4 -->\n}\n')
    write(CHANGELOG_FILE, changelogText([[11, 'x']]))
    git('add', '-A')
    git('commit', '-q', '-m', 'chore: 起点（模板在旧路径）')
    const base = head()

    // 搬迁提交：同一批标记从旧路径移到新路径，登记表**一字不动**
    // ——这是本门的核心反样本：面若只列新路径，父提交并集会读成空集、两个老版本号被误判
    // 为「首次出现」而逼人补假增量；父提交没有新路径又必须不崩（refHasPath 的容错）。
    write(OLD, 'export class Content {\n}\n')
    write(NEW, 'export const TEMPLATES = {\n  // <!-- learnhub:prompt/v11 -->\n  // <!-- learnhub:prompt/v4 -->\n}\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'refactor: 模板迁到 prompts/templates.ts（纯搬迁）')
    const moved = cli(['check', '--since', base], dir)
    assert.equal(moved.code, 0, `纯搬迁不得产生新版本号（应绿）：\n${moved.out}`)
    assert.match(moved.out, /✓ 无违规/)

    // 反向：搬迁后在新路径里 bump 不补登记 → 必须红（收集器得看得见新路径，否则是恒过的门）
    write(NEW, 'export const TEMPLATES = {\n  // <!-- learnhub:prompt/v12 -->\n  // <!-- learnhub:prompt/v4 -->\n}\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'feat: 新路径里 bump v11→v12（无登记）')
    const red = cli(['check', '--since', head() + '~1'], dir)
    assert.equal(red.code, 1, `新路径里的 bump 必须被看见：\n${red.out}`)
    assert.match(red.out, /v12 首次出现在本提交/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ② 语料回放

/** 写一件语料文件（格式与 host/corpus.ts 的读侧一致：frontmatter + 提示词 + 原始输出）。 */
function writeCorpus(dir: string, station: string, name: string, outcome: string, output: string): void {
  mkdirSync(join(dir, station), { recursive: true })
  writeFileSync(join(dir, station, name), [
    '---', `station: ${station}`, 'kind: complete', `outcome: ${outcome}`, 'ts: 2026-09-13T00:00:00Z', '---',
    '', '## 提示词', '', '<!-- learnhub:prompt/v11 -->', '# 模板', '', '## 原始输出', '', output, '',
  ].join('\n'), 'utf8')
}

test('#220 语料回放：基线通过 + 回放通过 = 绿；基线通过 + 回放失败 = 回归（合成语料）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-replay-'))
  try {
    writeCorpus(dir, '课程大纲', 'ok-a.md', 'ok', 'node: 甲\nsections:\n  - id: s1\n    title: 概念：甲\n    type: 概念\n    points: 一点。')
    writeCorpus(dir, '课程大纲', 'tol-b.md', 'tolerated', 'node: 乙\nsections:\n  - id: s1\n    title: 概念：乙\n    type: 概念\n    points: 二点。')
    const clean = replayCorpus(dir)
    assert.equal(clean.length, 2)
    assert.deepEqual(replayViolations(clean), [], '合法大纲输出不得误判为回归（回放的假阳性会挡住每一次 bump）')
    assert.ok(clean.every(r => r.replay === 'passed'))

    // 回归样本：基线 ok、输出坏掉（sections 缺 title → parseOutline 抛）
    writeCorpus(dir, '课程大纲', 'ok-c.md', 'ok', 'node: 丙\nsections:\n  - id: s1\n    type: 概念')
    const dirty = replayCorpus(dir)
    const v = replayViolations(dirty)
    assert.equal(v.length, 1)
    assert.match(v[0]!, /ok-c\.md/)

    // 基线本就 failed 的件不算回归（不然每件历史失败都会挡住门）
    writeCorpus(dir, '课程大纲', 'bad-d.md', 'failed', '不是 YAML at all: [')
    assert.deepEqual(replayViolations(replayCorpus(dir)).filter(x => x.includes('bad-d')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#220 语料回放：对**真实模型输出**的判定与 #216 spike 语料记录一致（回放面忠实性实测链）', () => {
  // 装置只认「解析面」：spike control 臂的原始应答（多轮文件取第 1 轮）就是真语料，
  // 其 delivered/schema_ok 是当时生产的判定——回放必须逐件复现同一个真伪。
  const base = join(ROOT, 'docs', 'research', 'spike-216-corpus')
  const stations: Array<[string, string]> = [['课程大纲', '课程大纲'], ['题目生成', '题目生成']]
  let checked = 0
  let failed = 0
  for (const [dirName, station] of stations) {
    let files: string[]
    try {
      files = readdirSync(join(base, dirName)).filter(f => f.endsWith('.md')).sort()
    } catch {
      continue
    }
    const dir = mkdtempSync(join(tmpdir(), 'prompt-replay-real-'))
    try {
      for (const f of files) {
        const lines = readFileSync(join(base, dirName, f), 'utf8').split('\n')
        const fmEnd = lines.indexOf('---', 1)
        const fm: Record<string, string> = {}
        for (const l of lines.slice(1, fmEnd)) {
          const i = l.indexOf(':')
          if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim()
        }
        if (fm.tool_called !== 'false') continue // 工具臂的「输出」是 submit 参数（JSON），不是本站 YAML 面
        const at = lines.findIndex(l => l.trim().startsWith('## 原始应答'))
        const turn1 = lines.findIndex((l, i) => i > at && l.trim() === '### 第 1 轮')
        if (turn1 < 0) continue
        const nextTurn = lines.findIndex((l, i) => i > turn1 + 1 && /^### 第 \d+ 轮/.test(l.trim()))
        const output = lines.slice(turn1 + 1, nextTurn > 0 ? nextTurn : undefined).join('\n').trim()
        if (!output) continue
        const recorded = fm.schema_ok === 'true' && fm.delivered === 'true'
        writeCorpus(dir, station, f, recorded ? 'ok' : 'failed', output)
        checked++
      }
      const readings = replayCorpus(dir)
      for (const r of readings) {
        const recorded = readFileSync(join(base, dirName, r.ref.split('/')[1]!), 'utf8').includes('schema_ok: true')
        assert.equal(r.replay === 'passed', recorded,
          `${r.ref}：回放判定 ${r.replay} 与当时生产的记录（schema_ok=${recorded}）不一致——回放面与站解析链已漂移${r.errors[0] ? `（${r.errors[0]}）` : ''}`)
        if (!recorded) failed++
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  assert.ok(checked >= 20, `真实输出样本太少（${checked} 件）——该门会恒过`)
  assert.ok(failed > 0, '样本里必须有当时被拒的件（否则「回放能看见失败」这件事没被测到）')
})

test('#220 语料回放：零样本按失败处理（回放装置不接受空语料目录）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-replay-empty-'))
  try {
    const r = cli(['replay', '--corpus', dir])
    assert.equal(r.code, 1)
    assert.match(r.out, /没有可回放的样本/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#220 语料回放 CLI：夹具语料走通全链（含「不在回放面」的显式清单）', () => {
  // 用合成语料跑一次 CLI（夹具语料 quality-corpus 的产物是评审器测试用的装饰件，
  // 从未过站解析链——不可作回放源，故这里自造一件真合规的大纲语料）
  const dir = mkdtempSync(join(tmpdir(), 'prompt-replay-cli-'))
  try {
    writeCorpus(dir, '课程大纲', 'ok-a.md', 'ok', 'node: 甲\nsections:\n  - id: s1\n    title: 概念：甲\n    type: 概念\n    points: 一点。')
    writeCorpus(dir, '课程节生成', 'ok-b.md', 'ok', '# 正文\n\n随便什么正文（该站不在回放面）。')
    const r = cli(['replay', '--corpus', dir])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /✓ 无解析回归/)
    assert.match(r.out, /课程节生成：正文 markdown \+ 机器块的解析面要引擎\/课程上下文/, '不在回放面的站必须显式给出理由')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#220 语料回放：语料里的站在回放面与缺席清单都无说法 = 新站漏登，按失败处理（防静默不覆盖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-replay-undeclared-'))
  try {
    writeCorpus(dir, '课程大纲', 'ok-a.md', 'ok', 'node: 甲\nsections:\n  - id: s1\n    title: 概念：甲\n    type: 概念\n    points: 一点。')
    writeCorpus(dir, '未登记新站', 'ok-b.md', 'ok', '管它是什么。')
    const r = cli(['replay', '--corpus', dir])
    assert.equal(r.code, 1, `漏登必须红：
${r.out}`)
    assert.match(r.out, /未登记新站.*既不在回放面.*也不在缺席清单/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ③ 评审对照

const stat = (station: string, dimension: string, dimensionName: string, counts: number[]): Record<string, unknown> =>
  ({ station, dimension, dimensionName, counts, na: 0, scored: counts.reduce((a, b) => a + b, 0) })
const report = (stats: Array<Record<string, unknown>>, refs: string[]): Record<string, unknown> =>
  ({ stats, reviews: refs.map(ref => ({ ref, station: String((stats[0] as { station: string })?.station ?? '站') })) })

test('#220 评审对照：同源样本 + 均值不降 = 绿；下降 = 违规；维度集合变化 = 拒绝比对', () => {
  const before = report([stat('教练生长', 'growth', '生长纪律', [0, 1, 1, 0])], ['教练生长/a.md', '教练生长/b.md'])
  const same = report([stat('教练生长', 'growth', '生长纪律', [0, 0, 2, 0])], ['教练生长/a.md', '教练生长/b.md'])
  const flat = compareReviewReports(before as never, same as never)
  assert.deepEqual(flat.problems, [])
  assert.equal(flat.rows.length, 1)
  assert.ok(flat.rows[0]!.delta > 0)

  const worse = report([stat('教练生长', 'growth', '生长纪律', [1, 1, 0, 0])], ['教练生长/a.md', '教练生长/b.md'])
  const drop = compareReviewReports(before as never, worse as never)
  assert.equal(drop.problems.length, 1)
  assert.match(drop.problems[0]!, /均值下降/)

  const otherRefs = report([stat('教练生长', 'growth', '生长纪律', [0, 0, 2, 0])], ['教练生长/c.md'])
  assert.match(compareReviewReports(before as never, otherRefs as never).problems.join('\n'), /非同源样本/)

  const newDim = report([stat('教练生长', 'growth', '生长纪律', [0, 0, 2, 0]), stat('教练生长', 'new', '新维度', [0, 1, 0, 0])], ['教练生长/a.md', '教练生长/b.md'])
  assert.match(compareReviewReports(before as never, newDim as never).problems.join('\n'), /有一侧无可判档读数/, '维度集合变化 → 该维度不可比（拒绝，而不是当 0 分）')
})

test('#220 评审对照：零样本恒过闸（空报告不是「不降」）', () => {
  const empty = { stats: [], reviews: [] }
  const r = compareReviewReports(empty as never, empty as never)
  assert.ok(r.problems.length >= 1)
  assert.match(r.problems.join('\n'), /零样本对照会恒过/)
  assert.deepEqual(r.rows, [])
})

test('#220 评审对照 CLI：合成两份报告，降则红、不降则绿', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-compare-'))
  try {
    const before = join(dir, 'before.json')
    const after = join(dir, 'after.json')
    const write = (p: string, counts: number[]): void => writeFileSync(p, JSON.stringify({
      stats: [stat('教练生长', 'growth', '生长纪律', counts)],
      reviews: [{ ref: '教练生长/a.md', station: '教练生长' }],
    }), 'utf8')
    write(before, [0, 1, 1, 0])
    write(after, [0, 0, 2, 0])
    const green = cli(['compare', before, after])
    assert.equal(green.code, 0, green.out)
    assert.match(green.out, /✓ 同源样本上逐（站 × 维度）均值不降/)
    write(after, [2, 0, 0, 0])
    const red = cli(['compare', before, after])
    assert.equal(red.code, 1)
    assert.match(red.out, /均值下降/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
