/**
 * 宿主技术层·静态伺服（#167 自 src/index.ts 分装；ADR-0048）：
 * 独立面板页（web/dist Vite SPA 前缀伺服）与三段伺服类路由（vault 媒体 /file、
 * vendored 库 /vendor、交互件 /interactive）。响应字节与缓存头逐字不变；
 * 路由面（api.ts）按原分支位置调用。
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve as resolvePath, sep } from 'node:path'
import type { HostRuntime } from './runtime.ts'
import { ASSET_MIME, FILE_MIME, PAGE_DIST, VENDOR_DIST, injectKatexIfMathed, sendJson } from './http.ts'
import { needQuery } from './params.ts'

/** 独立面板页面路由（伺服 web/dist）。 */
export const PAGE = '/learnhub'

/** 文件名段（最后一个 / 之后）的扩展名（含点、小写）；无扩展名返回空串。
 * 只看文件名段：目录名里的点（「v1.2 课程/插图」）不是扩展名（#155）。 */
function extOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

/** /learnhub 前缀伺服 SPA：index.html + assets/*，子路径全部伺服（命中失败回落 index.html）。 */
export async function panelPageHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // 无尾斜杠的 /learnhub 会把 base './' 的资产解析到根路径（/assets/* 404）→ 统一重定向
    if (url.pathname === PAGE) {
      res.writeHead(301, { location: `${PAGE}/` })
      res.end()
      return
    }
    const rel = decodeURIComponent(url.pathname.slice(PAGE.length).replace(/^\/+/, '')) || 'index.html'
    // 子路径限制在 dist 目录内（防 ../ 逃逸）；命中失败回落 index.html（SPA 语义）
    let file = resolvePath(PAGE_DIST, rel)
    if (!(file + sep).startsWith(PAGE_DIST)) file = join(PAGE_DIST, 'index.html')
    let data: Buffer
    try {
      data = await readFile(file)
    } catch {
      file = join(PAGE_DIST, 'index.html')
      data = await readFile(file)
    }
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
    const mime = ASSET_MIME[ext] ?? 'application/octet-stream'
    // assets 带 hash 可永久缓存；index.html no-store 保证发布后刷新即生效
    const immutable = rel.startsWith('assets/')
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    })
    res.end(data)
  } catch {
    // 报错不回显 err.message（ENOENT 带绝对 dist 路径，#155）——可行动的部分是构建指引
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('learnhub panel missing (build ui/ first: npm run build)')
  }
}

/** GET /file：伺服 vault 内媒体文件（课程插图）；路径必须是 vault 相对且白名单扩展名。 */
export async function serveVaultFile(rt: HostRuntime, url: URL, res: ServerResponse): Promise<void> {
  const [p] = needQuery(url, 'path')
  const rel = p.replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel.includes('..')) throw new Error('path traversal rejected')
  const ext = extOf(rel)
  const mime = FILE_MIME[ext]
  // 报错只报扩展名判定，不回显请求路径（#155）
  if (!mime) throw new Error(ext ? `unsupported file type: ${ext}` : 'unsupported file type: 文件名无扩展名（仅限媒体文件）')
  let buf: Buffer
  try {
    buf = await readFile(`${rt.vault}/${rel}`)
  } catch {
    sendJson(res, 404, { error: `file not found: ${rel}` })
    return
  }
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=3600' })
  res.end(buf)
}

/** GET /vendor/*：vendored 库同源伺服（katex/three）；路径限制在 web/vendor 内，
 * MIME 白名单复用面板资产表。 */
export async function serveVendor(res: ServerResponse, route: string): Promise<void> {
  const rel = decodeURIComponent(route.slice('/vendor/'.length)).replace(/\\/g, '/')
  if (!rel || rel.includes('..')) throw new Error('path traversal rejected')
  const ext = extOf(rel)
  const mime = ASSET_MIME[ext]
  // 报错只报扩展名判定，不回显请求路径（#155）
  if (!mime) throw new Error(ext ? `unsupported vendor file type: ${ext}` : 'unsupported vendor file type: 文件名无扩展名（仅限静态资产）')
  const file = resolvePath(VENDOR_DIST, rel)
  if (!(file + sep).startsWith(VENDOR_DIST)) throw new Error('path traversal rejected')
  let buf: Buffer
  try {
    buf = await readFile(file)
  } catch {
    sendJson(res, 404, { error: `vendor file not found: ${rel}` })
    return
  }
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=86400' })
  res.end(buf)
}

/** GET /interactive：交互件伺服，限启用课程根内 .html；CSP 禁外联（connect-src 由
 * default-src 'none' 封死），放开 'self' 后可从 /vendor 取 vendored katex/three、
 * 经 /file 引 vault 图片。 */
export async function serveInteractive(rt: HostRuntime, url: URL, res: ServerResponse): Promise<void> {
  const [p] = needQuery(url, 'path')
  const raw = p.replace(/\\/g, '/').replace(/^\/+/, '')
  if (raw.includes('..')) throw new Error('path traversal rejected')
  // 引用块存「学习中心相对路径」（<课程根>/交互/x.html），兼容 vault 相对（学习中心/…）——归一后再校验
  const rel = raw.startsWith(`${rt.centerRel}/`) ? raw : `${rt.centerRel}/${raw}`
  const courseRoot = rel.slice(rt.centerRel.length + 1).split('/')[0]
  if (!(await rt.engine.registry.enabled()).some(c => c.root === courseRoot)) {
    throw new Error(`interactive 不在任何启用课程的根内: ${courseRoot}`)
  }
  if (!rel.toLowerCase().endsWith('.html')) throw new Error('interactive 只允许 .html')
  let buf: Buffer
  try {
    buf = await readFile(`${rt.vault}/${rel}`)
  } catch {
    sendJson(res, 404, { error: `file not found: ${rel}` })
    return
  }
  // CSP 放开 'self'：交互件可从 /vendor 取库、经 /file 引图；connect-src 仍封死，外联面不变
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src data: 'self'",
    'cache-control': 'no-store',
  })
  res.end(injectKatexIfMathed(buf.toString('utf8')))
}
