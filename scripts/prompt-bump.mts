/**
 * 提示词变更过门装置（#220 / ADR-0072）：改模板＝改生产行为，一条命令回答「这次改模板能不能落地」。
 *
 * 三个子命令对应票面的三条过门（`docs/agents/architecture.md` §8 章程条款）：
 *
 *   check                            ① 登记门（提交级）：模板版本 bump 的提交必须同提交补
 *                                        `PROMPT_CHANGELOG` 条目（version/date/changeType/
 *                                        **预期输出增量**）。走 git 历史，不是在 HEAD 状态上看
 *                                        ——状态级完备性由 output-contract.test.ts 的登记门执法。
 *   replay --corpus <dir>            ② 语料回放（#213 语料 fixture 过解析回归）：把存下来的
 *                                        原始输出重新过一遍本站解析面，**基线通过 → 回放失败**
 *                                        即回归（解析容忍被改坏的机器判据）。零模型、确定性。
 *   compare <before.json> <after.json> ③ 评审对照（#222 报告对照）：**同源样本**上逐（站 × 维度）
 *                                        均值不降（改模板的预期输出增量要能兑现，不能把内容
 *                                        质量改差）。需要真模型跑出来的两份报告（`npm run
 *                                        quality-review -- --out <json>` 各一次，改前/改后）。
 *
 * 为什么三件住同一脚本：它们是**同一次变更的同一张门**，分开住会让「过门」变成三次手工对齐
 * 路径的记忆负担；三条都读同一个「模板版本」概念（`<!-- learnhub:prompt/vN -->`），也就该由
 * 同一处解释。
 *
 * 判读效力（分层法庭）：本装置只回答「回放没坏、评分没降」这类**机械读数**；内容质量是否变
 * 好仍归人审（AI 评分是提议，人审是终审——ADR-0070 的分层法庭）。装置不进 `npm test` 的必
 * 跑集（check/replay 有自检与夹具，见 tests/prompt-changelog.test.ts），它是**变更当下**跑的
 * 手工门：真实语料目录、真模型报告都取不到时，如实登记「未过门」而不是假装过了。
 *
 * 覆盖面是**双向清单**：语料里出现的站必须在 `REPLAY_FACE`（回放）或 `REPLAY_OUT_OF_SCOPE`
 * （明示不在回放面 + 理由）里有说法——两处都不在即「新站漏登」，按失败处理（静默不覆盖
 * 比没有回放更坏；与输出契约注册表的站表双向对账同款纪律）。
 *
 * 单跑：
 *   node --experimental-transform-types scripts/prompt-bump.mts check
 *   node --experimental-transform-types scripts/prompt-bump.mts replay --corpus tests/fixtures/quality-corpus
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stripFences } from '../src/engine/infra/agent.ts'
import { stripWrappingFence } from '../src/engine/coach/compass.ts'
import { Content } from '../src/engine/content/content.ts'
import { YAML } from '../src/engine/infra/yaml.ts'
import { validateBank } from '../src/engine/content/question-bank.ts'
import { validateEditProposal } from '../src/engine/coach/proposals.ts'
import { splitDecompileDoc, validatePlanArtifact } from '../src/engine/practice/project-decompile.ts'
import { validateErrorCards } from '../src/engine/content/error-cards.ts'
import { validateRouteBody } from '../src/engine/coach/compass.ts'
import { parseReceiptReview } from '../src/engine/practice/receipts.ts'
import { corpusLayoutOf, parseCorpusFile, readCallRecords } from '../src/host/corpus-read.ts'

/** 模板版本标记（每条模板头；与 PROMPT_CHANGELOG 的版本号同源）。 */
export const MARKER_RE = /<!-- learnhub:prompt\/v(\d+) -->/g

/**
 * **模板面**（提交级门的受控路径集；路径相对仓库根）。是清单不是单文件：#237 / ADR-0075 把
 * 模板从 `content.ts` 迁到 `prompts/templates.ts`，而门的判据是「版本号**集合差**」——面里
 * 只留新路径的话，搬迁那一提交的父提交版本集合会读成空集，15 条老标记全被误判成「首次出现」，
 * 门就会逼人给一次纯搬迁补 15 条假增量。历史路径因此**留在面里**（搬迁后它贡献空集、无害），
 * 一次搬迁于是在门眼里是零 diff——这正是「标记挪位不算 bump」的原话（ADR-0072 §裁决 2）。
 *
 * #305（ADR-0093 刀③）把 `content.ts` 从 `engine/` 顶层搬进 `engine/content/`：本条目的
 * **当前路径**随之追加（`src/engine/content/content.ts`），历史路径照上段纪律留在面里。
 */
export const TEMPLATE_FILES: readonly string[] = [
  'src/engine/content.ts', 'src/engine/prompts/templates.ts', 'src/engine/content/content.ts',
]

/** 登记表**当前路径**（写盘/夹具用；git 历史探测见 `CHANGELOG_FILES`）。 */
export const CHANGELOG_FILE = 'src/engine/content/output-contracts.ts'
/** 登记表的历史路径 + 当前路径。与 `TEMPLATE_FILES` 同款「面是清单」纪律，理由更硬一层：
 * ① `disciplineStartRef` 用 `git log -S ... -- <路径>` 动态发现纪律起点，只给当前路径的话
 * git 的历史简化会在搬迁提交处截断，起点会**静默漂到搬迁提交**、覆盖窗口悄悄变窄；
 * ② `scanBumps` 的 `git log -p` 面若只给当前路径，搬迁之前那些提交的登记 diff（`+version: N`）
 * 读不到，历史里的合规 bump 会被误判成「无登记」而假红。 */
export const CHANGELOG_FILES: readonly string[] = ['src/engine/output-contracts.ts', CHANGELOG_FILE]

// ---------------------------------------------------------------- ① 提交级登记门

/** 一个提交的 diff 面读数（`parseLogDiff` 的产物；纯数据，测试直造）。 */
export interface CommitDiffReading {
  sha: string
  subject: string
  /** 本提交 diff 里**新增**的模板版本标记（`+<!-- learnhub:prompt/vN -->`）。 */
  addedMarkers: number[]
  /** 本提交 diff 里**新增**的登记条目版本行（`+    version: N,`）。 */
  addedChangelogVersions: number[]
}

/** bump 提交的判定结果（`scanBumps` 的产物）。 */
export interface BumpCommit {
  sha: string
  subject: string
  /** 相对父提交**新出现在**模板面里的版本号（集合差，不是 diff 行——标记挪位/新增一份同
   * 版本模板都不算 bump，理由见 ADR-0072 §裁决 2；面内的路径迁移按 ADR-0075 §2 也不产生
   * 新版本号）。 */
  newVersions: number[]
  /** 同一提交新增的登记条目版本号（diff 行）。 */
  registeredVersions: number[]
}

/** 解析 `git log -p -U0` 的输出为逐提交读数（纯函数：测试直造 diff 文本，不需要 git）。 */
export function parseLogDiff(log: string): CommitDiffReading[] {
  const out: CommitDiffReading[] = []
  let cur: CommitDiffReading | null = null
  for (const line of log.split('\n')) {
    if (line.startsWith('@@COMMIT ')) {
      const rest = line.slice('@@COMMIT '.length)
      const sha = rest.split(' ')[0] ?? ''
      cur = { sha, subject: rest.slice(sha.length + 1).trim(), addedMarkers: [], addedChangelogVersions: [] }
      out.push(cur)
      continue
    }
    if (!cur || !line.startsWith('+') || line.startsWith('+++')) continue
    for (const m of line.matchAll(MARKER_RE)) cur.addedMarkers.push(Number(m[1]))
    const v = /^\+\s*version:\s*(\d+)\s*,/.exec(line)
    if (v) cur.addedChangelogVersions.push(Number(v[1]))
  }
  return out
}

/** 一份模板文件里出现过的全部版本号（集合）。 */
export function markerVersionsOf(templateText: string): Set<number> {
  return new Set([...templateText.matchAll(MARKER_RE)].map(m => Number(m[1])))
}

/** 一次遍历取两个读数：逐键版本号（键 → 版本；同键多标记取最后一个）+ 无法归属到键的
 * 版本号集合（键的开行之前出现的标记——历史形态：标记曾住 `content.ts` 的散文/注释；
 * 临时仓库夹具也照这个形态造）。**一趟解析，两份读数**——两个口径各走一遍同样的
 * 「找开行 → 记住 lastKey → 扫标记」循环，必然有一天漂移成两套归属规则。
 *
 * 为什么必须逐键而不是全face集合并集：每个模板键的版本号是**各自独立**的计数（罗盘初画
 * v3 与 题目生成 v14 可以并存），所以「版本号 X」在不同键之间天然撞车。集合差的判据在这种
 * 撞车下把一次真实 bump 判成零变化——实测（#250）：把 教练回合 由 v7 bump 到 v8 时，
 * 「错误对比卡」与「项目里程碑计划」已经是 v8，`newVersions` 为空，该 bump 对提交级门
 * **完全隐形**（门报「无违规」，但它根本没看见这次 bump）。这是集合并集语义的洞，不是策略变化：
 * 键集合与版本号都照旧，只有比对粒度从「面的版本号集合」换成「键的版本号」。
 *
 * 搬迁不变式照旧成立：模板从旧路径挪到新路径时键与版本都不变 → 逐键比对同样判零变化。 */
export function templateVersionsOf(templateText: string): { keys: Map<string, number>; unkeyed: Set<number> } {
  const keys = new Map<string, number>()
  const unkeyed = new Set<number>()
  let lastKey: string | null = null
  for (const line of templateText.split('\n')) {
    // 模板值的开行：`    键: \`` 或 `    '键': \``（Markdown/纯文本键都可能带引号）
    const open = /^\s+(?:'([^']+)'|([^\s:'`]+)):\s*`/.exec(line)
    if (open) lastKey = open[1] ?? open[2]!
    for (const m of line.matchAll(MARKER_RE)) {
      // 标记可能在开行同行（``错误对比卡: `<!-- … -->``）或紧随其后一行
      if (lastKey) keys.set(lastKey, Number(m[1]))
      else unkeyed.add(Number(m[1]))
    }
  }
  return { keys, unkeyed }
}

/** 判定：每个新出现的版本号都必须在同一提交里有登记条目。违规行给出 sha/subject/版本。 */
export function bumpViolations(bumps: readonly BumpCommit[]): string[] {
  const out: string[] = []
  for (const b of bumps) {
    const registered = new Set(b.registeredVersions)
    const missing = b.newVersions.filter(v => !registered.has(v)).sort((a, b2) => a - b2)
    if (missing.length) {
      out.push(`${b.sha.slice(0, 8)} ${b.subject}：模板版本 ${missing.map(v => `v${v}`).join('、')} 首次出现在本提交，`
        + '但同提交没有对应版本的 PROMPT_CHANGELOG 登记条目——改模板必须带「预期输出增量」（version/date/changeType/expectedDelta）')
    }
  }
  return out
}

/** 纪律起点（动态发现，不写死 sha）：`PROMPT_CHANGELOG` 首次出现的提交——此前没有登记面，
 * 编不出一份诚实的回溯表（同 PROMPT_CHANGELOG 头注「本表自 #218 起计」）。 */
export function disciplineStartRef(cwd: string): string {
  const root = gitRoot(cwd)
  const shas = git(['log', '-S', 'PROMPT_CHANGELOG', '--format=%H', '--', ...CHANGELOG_FILES], root).trim().split('\n').filter(Boolean)
  const first = shas[shas.length - 1]
  if (!first) throw new Error(`[prompt-bump] 找不到 PROMPT_CHANGELOG 的引入提交（${CHANGELOG_FILE}）——仓库历史里没有登记面？`)
  return first
}

function gitRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd).trim()
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** 路径在给定 ref 下是否存在（`git cat-file -e`）。不存在 = 该路径在此提交尚无内容，**不是
 * 错误**——搬迁提交的父提交里就没有新路径，把它当 git 故障会让门在那一次提交上崩掉。 */
function refHasPath(ref: string, path: string, root: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 某提交下**模板面**的逐键版本号（键 → 版本；旧路径与新路径同键时后者覆盖——搬迁不变式
 * 由「键与版本都没变」保证，与并集口径同源）+ 无法归属键的版本号集合。 */
function faceVersionsAt(ref: string, root: string): { keys: Map<string, number>; unkeyed: Set<number> } {
  const keys = new Map<string, number>()
  const unkeyed = new Set<number>()
  for (const f of TEMPLATE_FILES) {
    if (!refHasPath(ref, f, root)) continue
    const read = templateVersionsOf(git(['show', `${ref}:${f}`], root))
    for (const [key, v] of read.keys) keys.set(key, v)
    for (const v of read.unkeyed) unkeyed.add(v)
  }
  return { keys, unkeyed }
}

/** 扫 git 历史取 bump 提交（`since..until`，缺省 since = 纪律起点、until = HEAD）。
 * 两段式：先一次 `git log -p` 找出**候选提交**（diff 里出现版本标记），再对候选逐一看
 * 模板面的**逐键**版本差——候选很少，故 `git show` 的开销可控。判据是「某个键的版本号
 * 变了」（不是面的版本号集合差了谁——见 versionsByKeyOf 的撞车说明）。 */
export function scanBumps(opts: { cwd: string; since?: string; until?: string }): { commits: number; bumps: BumpCommit[] } {
  const root = gitRoot(opts.cwd)
  const since = opts.since ?? disciplineStartRef(root)
  const range = `${since}..${opts.until ?? 'HEAD'}`
  const log = git(['log', '-p', '-U0', '--format=@@COMMIT %H %s', range, '--', ...TEMPLATE_FILES, ...CHANGELOG_FILES], root)
  const readings = parseLogDiff(log)
  const bumps: BumpCommit[] = []
  for (const r of readings) {
    if (!r.addedMarkers.length) continue
    const now = faceVersionsAt(r.sha, root)
    const before = faceVersionsAt(`${r.sha}^`, root)
    // 两种口径合流：可归属键的标记按「键的版本变了」判（吃撞车），不可归属的按集合差判
    const changed = [...now.keys.entries()]
      .filter(([key, v]) => before.keys.get(key) !== v)
      .map(([, v]) => v)
    const added = [...now.unkeyed].filter(v => !before.unkeyed.has(v))
    const newVersions = [...new Set([...changed, ...added])].sort((a, b) => a - b)
    if (newVersions.length) bumps.push({ sha: r.sha, subject: r.subject, newVersions, registeredVersions: r.addedChangelogVersions })
  }
  return { commits: readings.length, bumps }
}

// ---------------------------------------------------------------- ② 语料回放

/** 回放面：站 → 本站**解析面**（离线可跑的那一半；受理侧的跨产物对账不在回放面，见各条注释）。
 * 返回 null 表示通过，否则是失败原因清单。 */
export const REPLAY_FACE: Record<string, (raw: string) => string[] | null> = {
  // 大纲/拆节：站链 = llmSeamStripped（剥围栏，host/jobs.ts）→ Content.parseOutline(yamlText)。
  // 语料存的是**剥围栏前**的原始输出，故回放照做剥围栏。
  课程大纲: raw => throwsToErrors(() => { Content.parseOutline(stripFences(raw)) }),
  课程节拆分: raw => throwsToErrors(() => { Content.parseSplitOutline(stripFences(raw), 's1') }),
  // 题目批：站链 = 剥围栏 → YAML.parseModel → questions 非空 → 逐题 validateBank（受理门另有
  // invokes/查重在回放面外——回放判**解析/形状**，不判查重与概念对表）
  题目生成: raw => bankShape(raw),
  笔记出题: raw => bankShape(raw),
  // 目标反编译：站链 = AgentSeam.complete（剥围栏）→ YAML.parseModel → splitDecompileDoc。
  // **跨产物一致性按自指口径旁路**：project 名取产物自身；#240/ADR-0076 种子降职后本站
  // 只产计划——splitDecompileDoc 现对 seed 半区即拒（受理侧知识，回放同口径）。
  // 旧语料（含 seed 半区）回放会红：那是降职语义在执法，不是回放面坏。
  目标反编译: raw => yamlThen(stripFences(raw), doc => {
    const project = (doc as { project?: unknown }).project
    return splitDecompileDoc(doc, typeof project === 'string' ? project : '').errors
  }),
  // 计划草案：站链同上（validatePlanArtifact 的 project 一致性同款自指旁路）
  计划草案: raw => yamlThen(stripFences(raw), doc => {
    const project = (doc as { project?: unknown }).project
    return validatePlanArtifact(doc, typeof project === 'string' ? project : '').errors
  }),
  // 错误对比卡：YAML + validateErrorCards（形状门）
  错误对比卡: raw => yamlThen(stripFences(raw), doc => validateErrorCards(doc).errors),
  // 罗盘：站链 = stripWrappingFence → validateRouteBody（无 YAML 层）
  罗盘: raw => { const e = validateRouteBody(stripWrappingFence(raw)); return e.length ? e : null },
  // 回执评审：parseReceiptReview 自带围栏处理（站是机械站，裸 LlmComplete 无剥围栏后处理）
  回执评审: raw => throwsToErrors(() => { parseReceiptReview(raw) }),
}

/** 题目批形状：剥围栏 → 解析 → questions 非空 → validateBank（与 questionGenerate 的解析段同）
 * 注：受理侧的 invokes 对表/查重/answer 形态逐题门不在回放面（回放判解析形状）。 */
function bankShape(raw: string): string[] | null {
  return yamlThen(stripFences(raw), doc => {
    const questions = (doc as { questions?: unknown }).questions
    if (!Array.isArray(questions) || !questions.length) return ['questions 为空——本批没有可用题目']
    return validateBank(doc).errors
  })
}

/** 明确**不在回放面**的站与理由（覆盖面是显式清单，不是漏登；与输出契约注册表的
 * OUT_OF_SCOPE_STATIONS 同款纪律）。 */
export const REPLAY_OUT_OF_SCOPE: Record<string, string> = {
  教练执行: '工具调用承载（tool-calls）：产物在写件（draft_patch/draft_audit/draft_finish/draft_note/draft_arc）的参数里，无独立 YAML/JSON 解析面可回放（解析面 = 草稿门，需引擎上下文）',
  种子起草: '站随种子链整体退役（#256 / ADR-0081）——语料为退场前存量样本，无在役解析面',
  课程节生成: '正文 markdown + 机器块的解析面要引擎/课程上下文（sectionApply 落盘），回放取不到',
  '课程节生成-苏格拉底': '同上（风格变体共享节生成解析面）',
  '课程节生成-费曼': '同上（风格变体共享节生成解析面）',
  里程碑草案: '四块结构门要项目/里程碑上下文（里程碑档位与既有产物对账）',
  独立解题: '第二意见门的解题应答不是产物契约（其结论由答案键对账判定）',
  判卷: '判卷站产出判词 + 调度副作用，无独立产物契约',
  申诉判卷: '同上（申诉复核两段式）',
  质量评审: '评审器自身的判定应答——判读面不是产物面（不然就自己评自己）',
  讲解反馈: '会话式自由文本（E2 档案面），无固定交付契约',
  自注反馈: '会话式自由文本（E1 档案面），无固定交付契约',
  老师辅导: '会话式对话形态，无固定交付契约',
  讲给我听: '会话式费曼回讲，无固定交付契约',
}

function throwsToErrors(fn: () => unknown): string[] | null {
  try {
    fn()
    return null
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)]
  }
}

function yamlThen(raw: string, check: (doc: unknown) => string[] | undefined): string[] | null {
  let doc: unknown
  try {
    doc = YAML.parseModel(raw)
  } catch (err) {
    // 解析失败原样带出（parseModel 的容忍面在站侧，回放只判「能不能解析」）
    return [err instanceof Error ? err.message : String(err)]
  }
  const errors = check(doc) ?? []
  return errors.length ? errors : null
}

export interface ReplayReading {
  ref: string
  station: string
  /** 语料记录的判定（ok / tolerated / failed）。 */
  baseline: 'ok' | 'tolerated' | 'failed'
  /** 回放判定：passed / failed（不在回放面的站为 null）。 */
  replay: 'passed' | 'failed' | null
  /** 回归：基线通过（ok/tolerated）而回放失败——**这是要拦的那一类**。 */
  regression: boolean
  errors: string[]
}

/** 读语料目录并按站回放。**双形态读侧**（#330 / ADR-0103）：新目录（`调用记录/`，按
 * 任务成组）走按调用读侧 readCallRecords；旧 `state/生成语料/` 目录（冻结，不迁移）
 * 走旧读侧 parseCorpusFile——历史语料与 fixture 的回放语义保持。基线取档上的 outcome，
 * 回放只判「能不能解析」，逐件一条 ReplayReading。 */
export function replayCorpus(dir: string, opts: { stations?: readonly string[] } = {}): ReplayReading[] {
  const wanted = opts.stations?.length ? opts.stations : null
  if (corpusLayoutOf(dir) !== '生成语料') return replayCallRecords(readCallRecords(dir), wanted)
  const out: ReplayReading[] = []
  let stations: string[]
  try {
    stations = readdirSync(dir).sort()
  } catch (err) {
    throw new Error(`[prompt-bump] 语料目录读不到：${dir}（${err instanceof Error ? err.message : String(err)}）`)
  }
  for (const station of stations) {
    if (wanted && !wanted.includes(station)) continue
    let files: string[]
    try {
      files = readdirSync(join(dir, station)).filter(f => f.endsWith('.md')).sort()
    } catch {
      continue
    }
    const parse = REPLAY_FACE[station]
    // 覆盖面双向对账（防恒过）：语料里的站在回放面或缺席清单里必须**有说法**——两处都不在
    // = 新站漏登，按失败处理（与输出契约注册表的站表双向对账同款纪律：静默不覆盖比没有回放更坏）。
    const undeclared = !parse && !(station in REPLAY_OUT_OF_SCOPE)
    for (const file of files) {
      const parsed = parseCorpusFile(readFileSync(join(dir, station, file), 'utf8'))
      const fm = parsed.frontmatter
      const baseline = fm.outcome === 'failed' || fm.outcome === 'tolerated' ? fm.outcome : 'ok'
      const ref = `${station}/${file}`
      if (!parse) {
        out.push({
          ref, station, baseline,
          replay: undeclared ? 'failed' : null,
          regression: undeclared,
          errors: undeclared
            ? [`站「${station}」既不在回放面（REPLAY_FACE）也不在缺席清单（REPLAY_OUT_OF_SCOPE）——新站漏登，按回放失败处理`]
            : [],
        })
        continue
      }
      const errors = parse(parsed.output)
      const replay = errors ? 'failed' : 'passed'
      out.push({ ref, station, baseline, replay, regression: replay === 'failed' && baseline !== 'failed', errors: errors ?? [] })
    }
  }
  return out
}

/** 新目录形态（调用记录）的回放：按调用记录逐件过解析面。 */
function replayCallRecords(records: ReturnType<typeof readCallRecords>, wanted: readonly string[] | null): ReplayReading[] {
  const out: ReplayReading[] = []
  for (const call of records) {
    if (wanted && !wanted.includes(call.station)) continue
    const parse = REPLAY_FACE[call.station]
    const undeclared = !parse && !(call.station in REPLAY_OUT_OF_SCOPE)
    if (!parse) {
      out.push({
        ref: call.ref, station: call.station, baseline: call.outcome,
        replay: undeclared ? 'failed' : null,
        regression: undeclared,
        errors: undeclared
          ? [`站「${call.station}」既不在回放面（REPLAY_FACE）也不在缺席清单（REPLAY_OUT_OF_SCOPE）——新站漏登，按回放失败处理`]
          : [],
      })
      continue
    }
    // 回放吃响应文本（各解析面自带剥围栏，与旧路径同口径）；回路轮文本为空而载荷在
    // arguments 里——回放面无此类站（缺席清单挡），防御性拼接保持「受评对象 = 文本 + 载荷」。
    const text = [call.output, ...call.toolCalls.map(c => c.arguments)].filter(Boolean).join('\n')
    const errors = parse(text)
    const replay = errors ? 'failed' : 'passed'
    out.push({ ref: call.ref, station: call.station, baseline: call.outcome, replay, regression: replay === 'failed' && call.outcome !== 'failed', errors: errors ?? [] })
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref))
}

/** 回放违规（回归件）——只有「基线通过 → 回放失败」算，基线本就失败的不重复计入。 */
export function replayViolations(readings: readonly ReplayReading[]): string[] {
  return readings.filter(r => r.regression)
    .map(r => `${r.ref}：基线 ${r.baseline} → 回放 failed（${r.errors[0] ?? '解析面变化'}）`)
}

// ---------------------------------------------------------------- ③ 评审对照

interface ReportStat { station: string; dimension: string; dimensionName: string; counts: number[]; na: number; scored: number }
interface ReportShape {
  stats?: ReportStat[]
  reviews?: Array<{ ref: string; station: string }>
  sampling?: { corpusDir?: string; selected?: number }
}

export interface CompareRow {
  key: string
  station: string
  dimensionName: string
  before: number
  after: number
  delta: number
}

export interface CompareResult {
  rows: CompareRow[]
  /** 不可比/不通过的硬问题（同源样本不成立、维度集合变化、分数下降）。 */
  problems: string[]
}

function meanOf(s: ReportStat): number | null {
  if (!s.scored) return null
  const sum = s.counts.reduce((acc, c, i) => acc + c * (i + 1), 0)
  return sum / s.scored
}

function refsOf(r: ReportShape): string[] {
  return [...new Set((r.reviews ?? []).map(x => x.ref))].sort()
}

/** 两份评审报告对照（纯函数，测试直造报告）：三条硬前提 + 一条判定。
 * 硬前提（不满足即**拒绝**比对，不是「通过」）：① 同源样本（评审面 ref 集合一致）；
 * ② 两侧都有可判档的（站 × 维度）读数；③ 维度集合一致（改模板不该改量规维度）。
 * 判定：逐（站 × 维度）均值不降（缺读数的一侧 = 该维度不可比，计入问题）。 */
export function compareReviewReports(before: ReportShape, after: ReportShape): CompareResult {
  const problems: string[] = []
  const refsBefore = refsOf(before)
  const refsAfter = refsOf(after)
  if (!refsBefore.length || !refsAfter.length) problems.push('报告没有评审面样本（reviews 为空）——零样本对照会恒过，拒绝比对')
  else if (refsBefore.join('|') !== refsAfter.join('|')) {
    problems.push(`非同源样本：改前 ${refsBefore.length} 件 / 改后 ${refsAfter.length} 件且 ref 集合不同——对照必须落在同一批样本上`)
  }
  const index = (r: ReportShape): Map<string, ReportStat> => new Map((r.stats ?? []).map(s => [`${s.station}\u0000${s.dimension}`, s]))
  const b = index(before)
  const a = index(after)
  if (!b.size || !a.size) problems.push('报告没有维度读数（stats 为空）——对照无对象')
  const keys = [...new Set([...b.keys(), ...a.keys()])].sort()
  const rows: CompareRow[] = []
  for (const key of keys) {
    const [station = '', dimensionName = ''] = key.split('\u0000')
    const bs = b.get(key)
    const as = a.get(key)
    const bm = bs ? meanOf(bs) : null
    const am = as ? meanOf(as) : null
    if (bm === null || am === null) {
      problems.push(`「${station} / ${dimensionName}」有一侧无可判档读数（已判档 ${bs?.scored ?? 0} → ${as?.scored ?? 0}）——不可比`)
      continue
    }
    rows.push({ key, station, dimensionName, before: bm, after: am, delta: am - bm })
    if (am < bm) problems.push(`「${station} / ${dimensionName}」均值下降 ${bm.toFixed(2)} → ${am.toFixed(2)}——改模板不得把内容质量改差（或显式登记例外与回退点）`)
  }
  return { rows, problems }
}

// ---------------------------------------------------------------- CLI

function usage(): string {
  return [
    '提示词变更过门装置（#220 / ADR-0072）',
    '',
    '  node --experimental-transform-types scripts/prompt-bump.mts check [--since <ref>] [--until <ref>]',
    '      ① 登记门：模板版本 bump 的提交必须同提交补 PROMPT_CHANGELOG 条目',
    '  node --experimental-transform-types scripts/prompt-bump.mts replay --corpus <dir> [--stations a,b]',
    '      ② 语料回放：基线通过的语料在回放里不得失败（解析回归）',
    '  node --experimental-transform-types scripts/prompt-bump.mts compare <before.json> <after.json>',
    '      ③ 评审对照：同源样本上逐（站 × 维度）均值不降（需两份 --out 报告）',
  ].join('\n')
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}

function cmdCheck(args: string[]): number {
  const cwd = process.cwd()
  const since = opt(args, 'since')
  const until = opt(args, 'until')
  const { commits, bumps } = scanBumps({ cwd, ...(since ? { since } : {}), ...(until ? { until } : {}) })
  console.log(`登记门（#220）：扫描 ${since ?? disciplineStartRef(cwd).slice(0, 8)}..${until ?? 'HEAD'} 的 ${commits} 个提交（触及模板/登记表的）`)
  if (!commits) {
    console.log('· 区间内没有触及模板或登记表的提交——「扫到 0 个」是读数不是通过：确认 --since/--until 指向你要审的变更')
  }
  console.log(`· 其中模板版本 bump 提交 ${bumps.length} 个`)
  const violations = bumpViolations(bumps)
  if (violations.length) {
    console.log(`✗ ${violations.length} 条违规：`)
    for (const v of violations) console.log(`  · ${v}`)
    return 1
  }
  console.log('✓ 无违规：每个新出现的模板版本号都在同一提交里补了登记条目')
  return 0
}

function cmdReplay(args: string[]): number {
  const corpus = opt(args, 'corpus')
  if (!corpus) {
    console.error('缺少 --corpus <语料目录>（宿主语料默认住 <中心>/state/调用记录；夹具可指向 tests/fixtures/quality-corpus）')
    return 2
  }
  const dir = resolve(corpus)
  const stations = opt(args, 'stations')?.split(',').map(s => s.trim()).filter(Boolean)
  const readings = replayCorpus(dir, { ...(stations ? { stations } : {}) })
  if (!readings.length) {
    console.error(`✗ 语料目录里没有可回放的样本：${dir}——零样本回放会恒过，按失败处理（先跑一轮生成或指向夹具）`)
    return 1
  }
  console.log(`语料回放（#220）：${dir}`)
  for (const r of readings) {
    const mark = r.replay === null ? '不在回放面' : r.regression ? '✗ 回归' : r.replay === 'passed' ? '✓' : '（基线本就失败，不计回归）'
    console.log(`  · ${r.ref}：基线 ${r.baseline} → 回放 ${r.replay ?? '—'} ${mark}`)
    if (r.regression && r.errors[0]) console.log(`      ${r.errors[0]}`)
  }
  const seen = new Set(readings.map(r => r.station))
  for (const [station, reason] of Object.entries(REPLAY_OUT_OF_SCOPE)) {
    if (!seen.has(station)) continue
    console.log(`  · ${station}：${reason}`)
  }
  const violations = replayViolations(readings)
  if (violations.length) {
    console.log(`✗ ${violations.length} 件解析回归：`)
    for (const v of violations) console.log(`  · ${v}`)
    return 1
  }
  console.log('✓ 无解析回归（0 件「基线通过 → 回放失败」）')
  return 0
}

function cmdCompare(args: string[]): number {
  const [beforePath, afterPath] = args.filter(a => !a.startsWith('--'))
  if (!beforePath || !afterPath) {
    console.error('用法：compare <before.json> <after.json>（两份 quality-review --out 报告）')
    return 2
  }
  const read = (p: string): ReportShape => {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as ReportShape
    } catch (err) {
      throw new Error(`报告读不到或不是 JSON：${p}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  const result = compareReviewReports(read(beforePath), read(afterPath))
  console.log(`评审对照（#220）：改前 ${beforePath} ／ 改后 ${afterPath}`)
  for (const row of result.rows) {
    const sign = row.delta >= 0 ? '+' : ''
    console.log(`  · ${row.station} / ${row.dimensionName}：${row.before.toFixed(2)} → ${row.after.toFixed(2)}（${sign}${row.delta.toFixed(2)}）${row.delta < 0 ? ' ✗' : ''}`)
  }
  if (result.problems.length) {
    console.log(`✗ ${result.problems.length} 条问题：`)
    for (const p of result.problems) console.log(`  · ${p}`)
    return 1
  }
  console.log('✓ 同源样本上逐（站 × 维度）均值不降（AI 评分是提议，人审终审——本装置只出机械读数）')
  return 0
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').slice(-2).join('/'))
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2)
  try {
    const code = cmd === 'check' ? cmdCheck(rest)
      : cmd === 'replay' ? cmdReplay(rest)
        : cmd === 'compare' ? cmdCompare(rest)
          : (console.log(usage()), cmd === undefined ? 0 : 2)
    process.exit(code)
  } catch (err) {
    console.error(`[prompt-bump] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
