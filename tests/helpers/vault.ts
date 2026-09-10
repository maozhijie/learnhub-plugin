/**
 * 共享 vault 测试工厂（ADR-0013）：声明式 options 生成临时 vault + LearnhubEngine。
 *
 * - 默认基线 = 单课程「数学」（root=math）/ 单区域「基础」/ 单节点「入门」（ready、fsrs null）。
 * - 结构化种子只覆盖常用字段（stage/fsrs/content/practice）；`notes`/`banks` 值给原始
 *   字符串则逐字落盘（覆盖损坏档、sections、特殊 frontmatter 等重载荷场景）。
 * - `registry: null` / `graph: null` 表示不写该文件（registry-only、空 vault 用）。
 * - `files` 是逃生口：vault 相对路径任意落盘（中心外个人笔记、故意损坏等）。
 * - 断言/播种走 `engine.store`（正式测试缝，见 tests/README）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LearnhubEngine } from '../../src/engine/index.ts'
import type { Paths } from '../../src/engine/paths.ts'
import type { Store } from '../../src/engine/store.ts'

export const DEFAULT_REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
].join('\n')

export const DEFAULT_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
].join('\n')

/** 节点笔记种子；不满足时给原始字符串逐字落盘。 */
export interface NoteSeed {
  stage?: string
  fsrs?: Record<string, string | number> | null
  content?: { version?: number; generatedAt?: string | null; status?: string; sections?: string[] }
  practice?: { attempts?: number; correct?: number; ema?: number }
  /** 追加在 practice 之后的 frontmatter 行（mastery / user_note / enc_candidates 注释放正文用 body）。 */
  fmExtra?: string[]
  /** 正文行（默认 `# <node>`）。 */
  body?: string[]
}

export interface VaultOptions {
  /** mkdtemp 前缀（调试定位用）。 */
  tag?: string
  /** 引擎 centerRel（默认「学习中心」，与引擎缺省一致）。 */
  centerRel?: string
  /** 课程注册表原文；undefined = 默认单课程，null = 不写。 */
  registry?: string | null
  /** 课程图原文；undefined = 默认单节点图，null = 不写（不建课程目录）。 */
  graph?: string | null
  /** 图数据文件名（默认 基础.yaml）。 */
  graphFile?: string
  /** 节名 → 笔记原文或种子；未列出的节点不写。键含「/」时按课程目录下相对路径整段解析（多区域用）。 */
  notes?: Record<string, string | NoteSeed>
  /** 节名 → 题库原文或题目 YAML 行数组；未列出的节点不写题库文件。 */
  banks?: Record<string, string | string[][]>
  /** 预置 state/review-log.jsonl（每元素一行 JSON）。 */
  reviewLog?: string[]
  /** schema 版本戳覆盖（#138 硬门）：undefined = 盖当前 v2；给 version 可伪造旧/新
   * 版本测门。门本身的负路径（拒载文案）直接裸构造引擎测——工厂总是构造引擎。 */
  schema?: { version?: number; breaks?: unknown[] }
  /** 逃生口：vault 相对路径任意文件。 */
  files?: Array<{ path: string; content: string }>
}

export interface VaultHandle {
  engine: LearnhubEngine
  root: string
  paths: Paths
  store: Store
}

export async function withVault<T>(options: VaultOptions, run: (h: VaultHandle) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), options.tag ?? 'learnhub-'))
  try {
    const centerRel = options.centerRel ?? '学习中心'
    const center = join(root, centerRel)
    const registry = options.registry === undefined ? DEFAULT_REGISTRY : options.registry
    const graph = options.graph === undefined ? DEFAULT_GRAPH : options.graph
    const course = join(center, 'math')

    await mkdir(center, { recursive: true })
    if (registry !== null) await writeFile(join(center, '课程注册表.yaml'), `${registry}\n`, 'utf8')

    if (graph !== null) {
      const graphFile = options.graphFile ?? '基础.yaml'
      await mkdir(join(course, 'data'), { recursive: true })
      await mkdir(join(course, '课程', '基础'), { recursive: true })
      await mkdir(join(course, '题库'), { recursive: true })
      await writeFile(join(course, 'data', graphFile), `${graph}\n`, 'utf8')
    }

    for (const [key, seed] of Object.entries(options.notes ?? {})) {
      const rel = key.includes('/') ? key : join('基础', key)
      const node = key.split('/').at(-1)!
      const text = typeof seed === 'string' ? seed : noteText(node, seed) + '\n'
      const path = join(course, '课程', `${rel}.md`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text, 'utf8')
    }

    for (const [node, seed] of Object.entries(options.banks ?? {})) {
      const text = typeof seed === 'string'
        ? seed
        : ['node: ' + node, 'questions:', ...seed.flat()].join('\n') + '\n'
      await writeFile(join(course, '题库', `${node}.yaml`), text, 'utf8')
    }

    // schema 版本戳与日界基线都在引擎构造**前**落盘：版本硬门在构造函数同步读盘
    // （#138），构造后再写就来不及了。日界固定 00:00（ADR-0020 回归基线 = 旧午夜口径）：
    // 引擎默认 02:00 会让真实时钟测试在 0-2 点窗口内不确定；日界专项测试用 files 覆盖。
    const configPath = join(center, 'state', 'learnhub.json')
    await mkdir(join(center, 'state'), { recursive: true })
    const schema = options.schema ?? {}
    await writeFile(configPath, JSON.stringify({
      schema: { version: schema.version ?? 2, ...(schema.breaks ? { breaks: schema.breaks } : {}) },
      day_cutoff: '00:00',
    }, null, 1) + '\n', 'utf8')

    const engine = new LearnhubEngine(centerRel === '学习中心' ? { vault: root } : { vault: root, centerRel })

    if (options.reviewLog?.length) {
      await writeFile(engine.paths.reviewLogPath, options.reviewLog.join('\n') + '\n', 'utf8')
    }

    for (const f of options.files ?? []) {
      const path = join(root, f.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, f.content, 'utf8')
    }

    return await run({ engine, root, paths: engine.paths, store: engine.store })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 节点笔记 frontmatter + 正文（缺省 = ready / fsrs null / content v0 draft / practice 0-0）。 */
export function noteText(node: string, seed: NoteSeed = {}): string {
  const fsrs = seed.fsrs
  const content = seed.content ?? {}
  const practice = seed.practice ?? {}
  return [
    '---',
    `node: ${node}`,
    `stage: ${seed.stage ?? 'ready'}`,
    ...(fsrs === undefined || fsrs === null
      ? ['fsrs: null']
      : ['fsrs:', ...Object.entries(fsrs).map(([k, v]) => `  ${k}: ${v}`)]),
    'content:',
    `  version: ${content.version ?? 0}`,
    `  generated_at: ${content.generatedAt === undefined ? 'null' : JSON.stringify(content.generatedAt)}`,
    `  status: ${content.status ?? 'draft'}`,
    ...(content.sections ? ['  sections:', ...content.sections] : []),
    'practice:',
    `  attempts: ${practice.attempts ?? 0}`,
    `  correct: ${practice.correct ?? 0}`,
    // 引擎契约里 practice_ema 是顶层 frontmatter 键（srs.ts 读 fm.practice_ema），不嵌在 practice 块内
    ...(practice.ema !== undefined ? [`practice_ema: ${practice.ema}`] : []),
    ...(seed.fmExtra ?? []),
    '---',
    '',
    ...(seed.body ?? [`# ${node}`]),
  ].join('\n')
}

/** 单个 true_false 题目的 YAML 行（可选种子 fsrs 块 = 已入复习循环的题卡）。 */
export function tfQuestion(id: string, opts: {
  fsrs?: Record<string, string | number>
  difficulty?: number | string
  archived?: boolean
  section?: string
  stats?: { attempts: number; correct: number; last?: string; last_correct?: boolean }
} = {}): string[] {
  return [
    `  - id: ${id}`,
    '    kind: true_false',
    `    q: ${id} 题干：说法是否成立。`,
    '    answer: true',
    ...(opts.difficulty !== undefined ? [`    difficulty: ${opts.difficulty}`] : []),
    ...(opts.section !== undefined ? [`    section: ${opts.section}`] : []),
    ...(opts.archived ? ['    archived: true'] : []),
    ...(opts.stats ? [`    stats: { attempts: ${opts.stats.attempts}, correct: ${opts.stats.correct}${opts.stats.last !== undefined ? `, last: ${opts.stats.last}` : ''}${opts.stats.last_correct !== undefined ? `, last_correct: ${opts.stats.last_correct}` : ''} }`] : []),
    ...(opts.fsrs ? ['    fsrs:', ...Object.entries(opts.fsrs).map(([k, v]) => `      ${k}: ${v}`)] : []),
  ]
}

/** 本地日历日偏移助手（学习日口径）：引擎的学习日按本地时区折算（ADR-0020），
 * 测试种子不得用 toISOString/setUTCDate 做「今天±n」——那是 UTC 日，本地 0 点到
 * 日界之间与引擎的「今天」错位一天（streak-grace/skills-lane 隔夜翻车即此因）。
 * 纯日期字符串整日偏移（memory-health/thermostat 的 day()）不受此累。 */
export function localDay(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 练习流作答包装：不调模型、默认课程「数学」/节点「入门」/耗时 30s。 */
export function answer(
  engine: LearnhubEngine,
  qid: string, response: string,
  opts: { node?: string; elapsedS?: number | null; deferSchedule?: boolean } = {},
): Promise<Record<string, unknown>> {
  return engine.questionAnswer(
    async () => 'unused', '数学', opts.node ?? '入门', qid, response,
    opts.elapsedS === undefined ? 30 : opts.elapsedS,
    opts.deferSchedule ? { deferSchedule: true } : undefined,
  )
}
