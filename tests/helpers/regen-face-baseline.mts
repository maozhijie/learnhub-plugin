// host-face-baseline.json 再生成（#182 终态口径）：入口名 = 注册表点路径 / hub 裸名，不归一。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { COMMAND_LIST } from '../../src/commands/index.ts'

const ROOT = process.cwd()
const faceOf = code => new Set([...code.matchAll(/\.engine\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)].map(m => m[1]))
const read = rel => readFileSync(join(ROOT, rel), 'utf8')
const hostFiles = readdirSync(join(ROOT, 'src', 'host'))
  .filter(f => f.endsWith('.ts') && f !== 'tools.ts' && f !== 'tool-handlers.ts').sort()
const agentDeclared = new Set(COMMAND_LIST.filter(c => c.channels.some(ch => ch.tool))
  .map(c => c.engine).filter(e => !!e))
const toolFace = new Set([...faceOf(read('src/host/tools.ts') + read('src/host/tool-handlers.ts')), ...agentDeclared])
const declared = new Set(COMMAND_LIST.filter(c => c.channels.some(ch => ch.route))
  .map(c => c.engine).filter(e => !!e))
const routeFace = new Set([...faceOf([...hostFiles.map(f => `src/host/${f}`), 'src/index.ts'].map(read).join('\n')), ...declared])
const shared = [...toolFace].filter(x => routeFace.has(x)).sort()
const toolOnly = [...toolFace].filter(x => !routeFace.has(x)).sort()
const routeOnly = [...routeFace].filter(x => !toolFace.has(x)).sort()
writeFileSync(join(ROOT, 'tests', 'fixtures', 'host-face-baseline.json'), JSON.stringify({ shared, toolOnly, routeOnly }, null, 1) + '\n')
console.log('shared', shared.length, '/ toolOnly', toolOnly.length, '/ routeOnly', routeOnly.length)
