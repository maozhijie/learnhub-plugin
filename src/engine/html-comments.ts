/**
 * HTML 注释剥除（引号感知、支持跨行）：解析边界与注入面的共享原语。
 *
 * 两类消费方（策略见各自调用点，本模块只管机制）：
 * - 模型 YAML 输出（yaml.ts parseModel）：串入的任何 HTML 注释都是噪音，全剥；
 * - vault 先验正文（vault-prior.ts）：只剥机器块（enc_candidates，CONTEXT.md「机器块」
 *   词条），个人笔记手写的其它 HTML 注释原样保留——经 matching 过滤声明。
 */

/** 行内引号配对判定：引号计数为偶（不在引号内）遇到的 `<!--` 才算注释起点；散撇号
 * （英文 it's 之类）按行隔离，不跨行污染配对判定。matching 缺席 = 全剥。 */
export function stripHtmlComments(src: string, matching?: (comment: string) => boolean): string {
  let out = ''
  let sq = 0
  let dq = 0
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === '\n') {
      sq = 0
      dq = 0
      out += ch
      i++
      continue
    }
    if (ch === "'") {
      sq++
      out += ch
      i++
      continue
    }
    if (ch === '"') {
      dq++
      out += ch
      i++
      continue
    }
    if (ch === '<' && src[i + 1] === '!' && src[i + 2] === '-' && src[i + 3] === '-' && sq % 2 === 0 && dq % 2 === 0) {
      // 跨行找闭合 -->；未闭合剥到串尾（截断在块中间的机器块/残注释）
      const close = src.indexOf('-->', i + 4)
      const stop = close < 0 ? n : close + 3
      const body = src.slice(i + 4, close < 0 ? n : close)
      if (matching && !matching(body)) out += src.slice(i, stop) // 非目标注释原样保留；注释体内引号不参与配对
      i = stop
      continue
    }
    out += ch
    i++
  }
  return out
}
