import { Content } from '../src/engine/content.ts'

let bad = 0
for (const [kind, tpl] of Object.entries(Content.PROMPT_KINDS)) {
  const { head, contract } = Content.splitContractSection(tpl)
  const v = Content.promptVersionOf(tpl)
  const ok = contract.length > 0
  if (!ok) bad++
  console.log(`${ok ? 'OK  ' : 'MISS'} v${String(v).padStart(2)} ${kind}  head=${head.length} contract=${contract.length}`)
}
console.log(`no-contract templates: ${bad}`)
