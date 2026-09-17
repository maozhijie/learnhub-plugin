/** 模型面引用门（#316 收尾加门）：模型面文本禁止出现内部文档引用——
 * `ADR-NNNN` 与 `#NNN`（票据号）。这些字符串原样进 LLM 上下文与学习者可见文件，
 * 出处与施工史只对人与注释有意义（注释归代码）。执法面：
 * ① src/commands/*.ts 的 summary / description 字面量（业务 LLM 工具描述）；
 * ② src/engine/prompts/*.ts 的模板体（剥整行注释后逐行扫——提示词是惰性字符串，
 *   注释全是整行 // 或块注释，模板体内不该有代码注释形态）。
 * 判据与边界登记在 tests/README.md；自检含必然违规样本（ADR-0047 惯例）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REF = /ADR-\d{3,4}|#\d{2,3}\b/

/** 提取 `key: "…"` 双引号字面量（summary/description 的声明形态）。 */
function literalsAfter(source: string, key: string): string[] {
  const out: string[] = []
  const re = new RegExp(key + ':\\s*"((?:\\\\.|[^"\\\\])*)"', 'g')
  let m
  while ((m = re.exec(source))) out.push(m[1]!)
  return out
}

/** 非注释部分：剥整行注释（//、*、/*开头）与「 // 」行尾注释（URL 的 // 不带前导空格）。 */
function nonCommentLines(source: string): string[] {
  return source.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map(l => {
      const c = l.indexOf(' // ')
      return c >= 0 ? l.slice(0, c) : l
    })
}

test('模型面引用门·命令注册表 summary/description 无 ADR/# 引用', () => {
  const dir = join(ROOT, 'src', 'commands')
  const hits: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue
    const src = readFileSync(join(dir, f), 'utf8')
    for (const key of ['summary', 'description']) {
      for (const lit of literalsAfter(src, key)) {
        if (REF.test(lit)) hits.push(`${f} ${key}: ${lit.slice(0, 80)}`)
      }
    }
  }
  assert.deepEqual(hits, [])
})

test('模型面引用门·提示词模板体无 ADR/# 引用', () => {
  const dir = join(ROOT, 'src', 'engine', 'prompts')
  const hits: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue
    const body = nonCommentLines(readFileSync(join(dir, f), 'utf8')).join('\n')
    let m: RegExpExecArray | null
    const re = new RegExp(REF.source, 'g')
    while ((m = re.exec(body))) hits.push(`${f}: …${body.slice(Math.max(0, m.index - 40), m.index + 20)}…`)
  }
  assert.deepEqual(hits, [])
})

// ---- 自检（ADR-0047 惯例：构造必然违规样本，断言判据真的会咬）----
test('模型面引用门·自检：判据咬得住违规样本、放得过正常散文', () => {
  assert.ok(REF.test('见 ADR-0033'))
  assert.ok(REF.test('写权反转（#316）'))
  assert.ok(REF.test('随 Region/Block 退役 #275'))
  assert.ok(!REF.test('这是一句正常散文，无任何出处'))
  assert.ok(!REF.test('# 罗盘 · 课程名')) // markdown 标题不误咬
  assert.ok(!REF.test('learnhub_compass_paint 初画'))
})
