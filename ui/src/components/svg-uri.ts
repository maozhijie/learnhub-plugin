/**
 * SVG 清洗的 URI 白名单（visual-blocks SvgBlock 用）——零依赖独立模块，node:test 可直接消费。
 *
 * 注意：DOMPurify 的 ALLOWED_URI_REGEXP 不是只查 href/src，而是筛查**每一个**属性值
 * （_isValidAttribute：值不匹配正则 → 连属性一起剥掉）。因此这里必须沿用默认正则的
 * 宽松结构（放行一切"非协议形态"的值，如 x=10、viewBox="0 0 460 200"），
 * 只把协议分支收紧到 data:——写成严格锚定的 /^(?:data:|#)/ 会把几何属性全剥光，
 * SVG 渲染成空白。`#锚点` 由 [^a-z] 分支放行，javascript:/https: 等外链被拒。
 */
export const SVG_URI = /^(?:(?:data:|#)|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
