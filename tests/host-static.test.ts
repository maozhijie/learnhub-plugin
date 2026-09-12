/**
 * 静态伺服文件路由的报错卫生（#155）：文件名无扩展名（或目录名带点）的请求，
 * 报错只报扩展名判定、不回显请求路径——旧实现 `rel.slice(rel.lastIndexOf('.'))`
 * 在目录名带点时把「.b 目录/插图」整段回显进错误消息。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { serveVaultFile } from '../src/host/static.ts'
import type { ServerResponse } from 'node:http'

const rt = { vault: '«vault»' } as unknown as Parameters<typeof serveVaultFile>[0]

/** 打一发 /file 请求：返回 {status, body}（抛错按 handleApi 同款折成 500 JSON）。 */
async function probeFile(path: string): Promise<{ status: number; body: unknown }> {
  const out = { status: 200, body: undefined as unknown }
  const res = {
    writeHead: (code: number, _h?: unknown) => { out.status = code },
    end: (data?: unknown) => {
      const text = data === undefined ? '' : String(data)
      try { out.body = text ? JSON.parse(text) : null } catch { out.body = text }
    },
  } as unknown as ServerResponse
  try {
    await serveVaultFile(rt, new URL(`http://x/file?path=${encodeURIComponent(path)}`), res)
  } catch (err) {
    out.status = 500
    out.body = { error: err instanceof Error ? err.message : String(err) }
  }
  return out
}

test('无扩展名请求：报错说明缺扩展名，不回显请求路径', async () => {
  const out = await probeFile('学习中心/数学/交互/hello')
  assert.equal(out.status, 500)
  assert.match((out.body as { error: string }).error, /无扩展名/)
  assert.equal((out.body as { error: string }).error.includes('/'), false, '错误消息不含路径片段')
})

test('目录名带点、文件名无扩展名：不再把目录名误判为扩展名回显（旧实现的路径泄露）', async () => {
  const out = await probeFile('v1.2 课程/插图')
  assert.equal(out.status, 500)
  const msg = (out.body as { error: string }).error
  assert.match(msg, /无扩展名/)
  assert.equal(msg.includes('v1.2'), false, '目录名不进错误消息')
})

test('白名单扩展名正常放行判定（文件缺失 = 404 相对路径回显，非 500 扩展名错）', async () => {
  const out = await probeFile('sub/dir/x.png')
  assert.equal(out.status, 404, 'png 在白名单：走到读文件，缺失 404')
  assert.match((out.body as { error: string }).error, /file not found/)
})

after(() => undefined)
