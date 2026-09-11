/**
 * 宿主 HTTP 技术层（#152 刀 12 自 src/index.ts 抽出）：面板静态产物目录/MIME 表、
 * 请求解析与响应序列化、markdown 数学注入。无状态纯工具层——不碰 engine、不碰队列。
 */
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const PAGE_DIST = fileURLToPath(new URL('../web/dist/', import.meta.url))
/** vendored 库目录（交互件沙箱 CSP 放开 'self' 后的唯一取库途径；build.mjs copyVendor 落盘）。 */
export const VENDOR_DIST = fileURLToPath(new URL('../web/vendor/', import.meta.url))
/** /file 路由允许伺服的二进制媒体扩展名 → MIME（课程插图等）。 */
export const FILE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}

/** 面板 SPA 资产扩展名 → MIME。 */
export const ASSET_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
}

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 读取并解析 POST JSON 请求体。 */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** 字符串参数取值；缺失即抛 400 语义错误。 */
export function need(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`missing required field: ${key}`)
  return v.trim()
}

/** 交互件伺服时注入 vendored KaTeX 自动渲染（检测到公式定界符且未自带 katex 才注入；
 * 存量交互件免重生成即获得公式渲染）。定界符与正文一致：$…$/$$…$$。 */
export function injectKatexIfMathed(html: string): string {
  if (!/\$\$|\\\(|\\\[/.test(html) || /katex/i.test(html)) return html
  const inject = [
    '<link rel="stylesheet" href="/learnhub/api/vendor/katex/katex.min.css">',
    '<script src="/learnhub/api/vendor/katex/katex.min.js"></script>',
    '<script src="/learnhub/api/vendor/katex/contrib/auto-render.min.js"></script>',
    '<script>document.addEventListener("DOMContentLoaded",function(){window.renderMathInElement(document.body,{delimiters:[{left:"$$",right:"$$",display:true},{left:"$",right:"$",display:false}],throwOnError:false})})</script>',
  ].join('\n')
  const head = html.toLowerCase().indexOf('</head>')
  return head === -1 ? html + inject : html.slice(0, head) + inject + '\n' + html.slice(head)
}
