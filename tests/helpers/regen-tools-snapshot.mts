// host-tools-snapshot.json 再生成（工具名/描述/schema 契约快照，tests/host-runtime.test.ts
// 与 tests/commands.test.ts 的门⑧消费）：加工具/改描述后重录，diff 必须逐条人审——描述与
// schema 是受管制面（产品契约），漂移要有票面依据。
//
// 按**名**合并不按全量重写：文件序不是注册序（消费者全部按名索引），全量重写会把无关
// 工具全部搬动、diff 不可审。规则：原序保持；同名条目原位更新；新增工具按注册序插在
// 「注册序里前后两个旧工具」之间；旧文件里有而本次没注册到的工具 = 退役，删除并在输出
// 里点名（逐条人审）。
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerTools } from '../../src/host/tools.ts'

const ROOT = process.cwd()
const FILE = join(ROOT, 'tests', 'fixtures', 'host-tools-snapshot.json')

function fakeCtx(captured: unknown[]): unknown {
  return {
    tools: { register: (t: unknown) => { captured.push(t); return () => undefined } },
    effect: () => undefined,
    webServer: { register: () => undefined },
  }
}

const { createHostRuntime } = await import('../../src/host/runtime.ts')
const { memLogger } = await import('./logger.ts')
const vault = mkdtempSync(join(tmpdir(), 'learnhub-tools-snap-'))
mkdirSync(join(vault, '学习中心'), { recursive: true })
const captured: Array<{ name: string; description: string; parameters: unknown }> = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rt = createHostRuntime(fakeCtx(captured) as any, { vault, centerRel: '学习中心', logger: memLogger() } as any)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerTools(fakeCtx(captured) as any, rt as any)
rmSync(vault, { recursive: true, force: true })

const now = new Map(captured.map(t => [t.name, t]))
const before = JSON.parse(readFileSync(FILE, 'utf8')) as Array<{ name: string }>
const beforeNames = new Set(before.map(t => t.name))
const retired = [...beforeNames].filter(n => !now.has(n))
if (retired.length) console.log('退役（旧有今无）:', retired.join('、'))

// 新工具的插入位：注册序里前一个「旧文件也有的工具」之后（前一个不存在则取后一个之前）
const order = captured.map(t => t.name)
const insertAfter = new Map<string, string>()
for (let i = 0; i < order.length; i++) {
  if (beforeNames.has(order[i]!)) continue
  const prev = [...order.slice(0, i)].reverse().find(n => beforeNames.has(n))
  insertAfter.set(order[i]!, prev ?? '')
}
const out: Array<{ name: string; description: string; parameters: unknown }> = []
for (const old of before) {
  const hit = now.get(old.name)
  if (!hit) continue
  out.push({ name: hit.name, description: hit.description, parameters: hit.parameters })
  for (const [name, prev] of insertAfter) {
    if (prev === old.name) {
      const t = now.get(name)!
      out.push({ name: t.name, description: t.description, parameters: t.parameters })
      insertAfter.delete(name)
    }
  }
}
for (const [name] of insertAfter) {
  const t = now.get(name)!
  out.push({ name: t.name, description: t.description, parameters: t.parameters })
}
writeFileSync(FILE, JSON.stringify(out, null, 1) + '\n')
let changed = 0
for (let i = 0; i < before.length && i < out.length; i++) {
  if (JSON.stringify(before[i]) !== JSON.stringify(out[i])) changed++
}
console.log('tools snapshot:', out.length, 'entries；前缀位变化', changed, '；新增', out.length - (before.length - retired.length))
