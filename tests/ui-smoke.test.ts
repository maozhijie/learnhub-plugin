/**
 * L2 冒烟渲染门（#183 / #187 决议②·ADR-0051 第一层）：react-dom/server 把 ui/src
 * 的页面组件渲染成静态标记——import 崩溃与首渲染崩溃在 npm test 里立刻红，
 * 不再等人工走查才发现（Exhibit A 类缺陷的最低配回归网）。
 *
 * - 全局桩（localStorage/matchMedia/window）：只够 useState 惰性初始化用；
 *   effects 不在 SSR 执行，取数/定时器不发生。document 不桩（arco 检测到无 DOM
 *   自动走服务端形态，桩了反而歪）。
 * - .tsx 加载经 tests/helpers/tsx-loader.mjs（Node 24 原生 TS 直跑不支持 JSX，
 *   2026-09-12 实测 ERR_UNKNOWN_FILE_EXTENSION；用 devDependencies 里已锁版本的
 *   typescript 包内存转译，零新增依赖、零构建步骤）。
 * - 冻结表即棘轮：能渲染的页面必须留在 render 集合里（渲染失败 = 红）；
 *   渲染不了的进 exempt 并登记原因；新页面两表都不在 = 失败（逼迫显式归类）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

register(new URL('./helpers/tsx-loader.mjs', import.meta.url))

// ---- 全局桩（先于任何 ui 模块导入）----
const g = globalThis as unknown as Record<string, unknown>
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
g.window ??= globalThis
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
g.CustomEvent ??= class CustomEvent { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail } }

const uiRequire = (await import('node:module')).createRequire(new URL('../ui/package.json', import.meta.url))
const React = uiRequire('react') as typeof import('react')
const { renderToStaticMarkup } = uiRequire('react-dom/server') as typeof import('react-dom/server')

// ---- 页面发现：pages/XxxPage.tsx 与 pages/<Page>/index.tsx 都是页面条目 ----
const pagesDir = join(ROOT, 'ui', 'src', 'pages')
const entries = readdirSync(pagesDir, { withFileTypes: true }).flatMap(e => {
  if (e.isFile() && /\.tsx$/.test(e.name)) return [{ name: e.name.replace(/\.tsx$/, ''), rel: `pages/${e.name}` }]
  if (e.isDirectory() && readdirSync(join(pagesDir, e.name)).includes('index.tsx')) {
    return [{ name: e.name, rel: `pages/${e.name}/index.tsx` }]
  }
  return []
}).sort((a, b) => a.name.localeCompare(b.name))

/** AppFrame 替身：SSR 不跑 effects，只够渲染路径消费。 */
const fakeFrame = {
  status: null, tree: null, course: null, lesson: null, focusNode: null,
  setCourse: () => {}, goto: () => {}, openLesson: () => {}, closeLesson: () => {},
  locateInGraph: () => {}, reload: async () => {}, loading: false,
}

/** 冻结表（棘轮）：render 的每一项每次必须渲染出非空标记；exempt 必须给出原因。
 * 页面修好后应从 exempt 挪进 render（挪出 render = 红，不许悄悄降级）。 */
const FROZEN: { render: string[]; exempt: Record<string, string> } = {
  render: [
    'App',
    'BankPage',
    'GeneratePage',
    'GraphPage',
    'GuidePage',
    'LabPage',
    'LearnPage',
    'LearnPage@lesson', // 二级视图：frame.lesson 非空 → LessonView + PracticeFlow 空态
    'PracticePage',
    'ProjectsPage',
    'ProposalsPage',
    'StatsPage',
  ],
  exempt: {},
}

const loadEntry = async (rel: string) => import(/* @vite-ignore */ `../ui/src/${rel}`)

test('页面冻结表与 ui/src/pages 实际条目一致（新页面必须显式归类）', () => {
  const names = entries.map(e => e.name)
  const classified = [...FROZEN.render, ...Object.keys(FROZEN.exempt)]
  const unknown = classified.filter(n => !names.includes(n.split('@')[0]!) && n !== 'App')
  assert.deepEqual(unknown, [], `冻结表里有 ui/src/pages 不存在的页面（改名后未同步）：${unknown.join(', ')}`)
  const unclassified = names.filter(n => !classified.includes(n) && !classified.some(c => c.split('@')[0] === n))
  assert.deepEqual(unclassified, [], `新页面未归类（能渲染进 render，渲染不了进 exempt 并写明原因）：${unclassified.join(', ')}`)
})

test(`冻结表里 render 的每个条目都渲染出非空标记（${FROZEN.render.length} 个）`, async () => {
  for (const name of FROZEN.render) {
    const [pageName, variant] = name.split('@')
    const entry = pageName === 'App'
      ? { rel: 'App.tsx' }
      : entries.find(e => e.name === pageName)
    assert.ok(entry, `冻结表条目 ${name} 找不到页面文件`)
    const mod = await loadEntry(entry!.rel)
    const Page = (mod as { default: unknown }).default
    assert.equal(typeof Page, 'function', `${name} 缺默认导出组件`)
    const frame = variant === 'lesson'
      ? { ...fakeFrame, lesson: { course: '数学', node: '入门' } }
      : fakeFrame
    const html = renderToStaticMarkup(React.createElement(Page as React.FC<{ frame?: typeof frame }>, { frame }))
    assert.ok(html.length > 0, `${name} 渲染出空标记`)
  }
})

test('门自检：渲染抛错必须被抓住（探针必然崩溃样本）', async () => {
  const Boom = (_props: unknown): never => { throw new Error('boom') }
  assert.throws(() => renderToStaticMarkup(React.createElement(Boom)),
    /boom/, '渲染异常没有被本门同路径看见')
})
