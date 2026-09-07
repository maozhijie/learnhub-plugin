/**
 * 只读冒烟测试：真实 vault 数据过一遍引擎的读路径（不写任何文件）。
 * 用法：node scripts/smoke.mjs <vault 路径>
 */
import { LearnhubEngine } from '../lib/engine.js'

const vault = process.argv[2]
if (!vault) {
  console.error('usage: node scripts/smoke.mjs <vault>')
  process.exit(1)
}

const engine = new LearnhubEngine({ vault })
let failed = 0
const step = async (name, fn) => {
  try {
    const out = await fn()
    // skipIfEmptyState 可能返回 undefined；JSON.stringify(undefined) 也是 undefined
    const size = typeof out === 'string' ? out.length : out === undefined ? 0 : JSON.stringify(out)?.length ?? 0
    console.log(`OK  ${name} (${size} bytes)`)
  } catch (err) {
    failed++
    console.error(`FAIL ${name}: ${err.message}`)
  }
}

await step('statusJson', () => engine.statusJson())
await step('xpStatus（预算制 ETA）', () => engine.xpStatus())
await step('promptKinds（含风格变体）', async () => {
  const kinds = await engine.promptKinds()
  for (const k of ['课程大纲', '课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼', '题目生成']) {
    if (!kinds.includes(k)) throw new Error(`missing prompt kind: ${k}`)
  }
  return kinds
})
await step('recommend', () => engine.recommend(5))
await step('doctor', () => engine.doctor())
await step('queueItemsAll', () => engine.queueItemsAll())
await step('graphAnalyze', () => engine.graphAnalyze(undefined, false))
await step('graphAnalyze.elements', () => engine.graphAnalyze(undefined, true))
await step('coursesTree', () => engine.coursesTree())
const courses = await engine.enabledCourses()
console.log(`courses: ${courses.map(c => c.name).join(', ')}`)
if (courses.length) {
  const c = courses[0]
  const { graph } = await engine.loadView(c)
  const node = graph.names[0]
  // 骨架节点（正文未生成）的 lesson/discussionPack 是合法空态，跳过而非 FAIL。
  // 注：老 Python 引擎的 exercises 读路径已随纯 TS 引擎移除（练习区并入题库刷卡流 questions/questionAnswer）。
  const skipIfEmptyState = e => {
    if (/没有练习区|课程文件不存在|没有练习/.test(e.message)) {
      console.log(`SKIP ${node}: 骨架节点（${e.message}）`)
      return undefined
    }
    throw e
  }
  await step(`lesson(${node})`, () => engine.lesson(c.name, node).catch(skipIfEmptyState))
  await step(`contentPack(${node})`, () => engine.contentPack(c.name, node))
  await step(`contentVersion(${node})`, () => engine.contentVersion(c.name, node))
  await step(`discussionPack(${node})`, () => engine.discussionPack(c.name, node).catch(skipIfEmptyState))
  await step(`questions(${node})`, () => engine.questions(c.name, node))
}
console.log(failed ? `\n${failed} step(s) FAILED` : '\nall smoke steps OK')
process.exit(failed ? 1 : 0)
