/** 一次性维护脚本：为全部启用课程缺笔记的节点补骨架文件（幂等）。
 * 用途：修复早期版本 apply 不落笔记骨架的存量课程。
 * 用法：node scripts/ensure-notes.mjs <vault> [course]
 */
import { LearnhubEngine } from '../lib/engine.js'

const vault = process.argv[2]
if (!vault) {
  console.error('usage: node scripts/ensure-notes.mjs <vault> [course]')
  process.exit(1)
}
const engine = new LearnhubEngine({ vault })
const r = await engine.ensureAllNotes(process.argv[3])
for (const c of r.courses) console.log(`${c.course}: created ${c.created}`)
console.log('done')
