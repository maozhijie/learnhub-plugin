/** 面板伺服冒烟：301 重定向 + 资产可达 + 关键 API 形状。用法：node scripts/smoke-panel.mjs [port] */
const port = process.argv[2] ?? '3214'
const base = `http://localhost:${port}`

const r1 = await fetch(`${base}/learnhub`, { redirect: 'manual' })
console.log('no-slash:', r1.status, 'location:', r1.headers.get('location'))
if (r1.status !== 301 || !r1.headers.get('location')?.endsWith('/learnhub/')) {
  console.error('FAIL: no-slash should 301')
  process.exit(1)
}

const r2 = await fetch(`${base}/learnhub/`)
const html = await r2.text()
console.log('slash page:', r2.status, 'has assets ref:', html.includes('./assets/'))

const asset = html.match(/\.\/assets\/[^"]+/)?.[0]
if (!asset) { console.error('FAIL: no asset ref'); process.exit(1) }
const r3 = await fetch(`${base}/learnhub/${asset.slice(2)}`)
console.log('asset:', r3.status, r3.headers.get('content-type'))

const g = await (await fetch(`${base}/learnhub/api/graph?course=MathForGames`)).json()
console.log('graph nodes:', g.nodes?.length, 'edges:', g.edges?.length)
const s = await (await fetch(`${base}/learnhub/api/status`)).json()
console.log('status courses:', s.courses?.length, 'first keys:', Object.keys(s.courses?.[0] ?? {}).join(','))
const t = await (await fetch(`${base}/learnhub/api/courses/tree`)).json()
console.log('tree courses:', t.courses?.length)

// vendored 库同源伺服（交互件沙箱 CSP 放开 'self' 后的唯一取库途径）
const v = await fetch(`${base}/learnhub/api/vendor/katex/katex.min.js`)
console.log('vendor katex:', v.status, v.headers.get('content-type'))
if (v.status !== 200 || !(v.headers.get('content-type') ?? '').includes('javascript')) {
  console.error('FAIL: vendor katex.js should be served as javascript')
  process.exit(1)
}
const vEsc = await fetch(`${base}/learnhub/api/vendor/%2e%2e/katex/katex.min.js`)
console.log('vendor traversal guard:', vEsc.status)
if (vEsc.status === 200) {
  console.error('FAIL: vendor path traversal must not be served')
  process.exit(1)
}

// 交互件 CSP：放开 'self'（vendored 库/vault 图片）且仍禁外联
const i = await fetch(`${base}/learnhub/api/interactive?path=${encodeURIComponent('学习中心/MathForGames/交互/浮点误差实验台.html')}`)
const csp = i.headers.get('content-security-policy') ?? ''
console.log('interactive:', i.status, 'CSP:', csp)
if (i.status !== 200 || !csp.includes("script-src 'unsafe-inline' 'self'") || !csp.includes("default-src 'none'")) {
  console.error('FAIL: interactive CSP should allow self but keep default-src none')
  process.exit(1)
}
// 课程根相对引用（生成管线 extractInteractive 写 <课程根>/… 形态）也必须可伺服
const iRel = await fetch(`${base}/learnhub/api/interactive?path=${encodeURIComponent('MathForGames/交互/浮点误差实验台.html')}`)
console.log('interactive center-relative:', iRel.status)
if (iRel.status !== 200) {
  console.error('FAIL: center-relative interactive path must be normalized and served')
  process.exit(1)
}
console.log('PANEL SMOKE OK')
