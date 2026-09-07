import test from 'node:test'
import assert from 'node:assert/strict'
import { SVG_URI } from '../ui/src/components/svg-uri.ts'

// ---- SVG_URI 白名单（DOMPurify ALLOWED_URI_REGEXP 语义）----
// 该正则被 DOMPurify 用来筛查**每一个**属性值：值不匹配 → 属性被整体剥掉。
// 回归背景：写成严格锚定的 /^(?:data:|#)/ 后，x/viewBox/font-size 等几何属性
// 全被剥光，SVG 渲染成空白块（2026-09-07 学习页示意图空白 bug）。

const admits = (v: string) => SVG_URI.test(v)

test('SVG_URI: 几何/样式属性值必须放行（否则属性被 DOMPurify 剥光 → 空白图）', () => {
  for (const v of [
    '10', '0', // x/y
    '36', // width/height
    '0 0 460 200', // viewBox
    '3', // rx
    '16', '12', // font-size
    '#e8f3ff', '#165dff', // fill/stroke 颜色
    'M10 100 Q80 10 200 40', // path d
    '2', // stroke-width
  ]) {
    assert.ok(admits(v), `应放行属性值 ${JSON.stringify(v)}`)
  }
})

test('SVG_URI: 文档内锚点与 data: 放行，javascript:/外链拒绝', () => {
  assert.ok(admits('#p1'))
  assert.ok(admits('data:image/png;base64,AAAA'))
  assert.ok(!admits('javascript:alert(1)'))
  assert.ok(!admits('https://evil.example/x'))
  assert.ok(!admits('http://evil.example/x'))
})
