/**
 * 学习产物输出区（V-3 #107）：复盘稿/讲解稿/错误卡/周复盘等学习产物统一落
 * 学习中心/我的产出/<类>/——引擎专属输出区。只出链、不进个人笔记：产物内以
 * Obsidian 链接（[[<vault 相对路径>|别名]]）指向个人笔记，被指向的文件零字节
 * 改动（ADR-0010 只读纪律）。
 *
 * 注册通道豁免（V-3 × V-1 交叉，ADR-0026「复盘对象可被调度走既有 V-1 注册通道」）：
 * 我的产出/ 整区与 projects/<id>/日志.md（V-5 #113）是学习者可读可编辑的文档区，
 * 允许经既有笔记源注册通道注册为复习源；学习中心其余内部路径维持拒绝（引擎契约
 * 文件的 Broken 纪律不得被注册语义架空）。引擎写这些文件后刷新已注册源指纹
 * （门面 refreshSourceFingerprints）——引擎自己的写不算内容漂移，漂移只留给
 * 引擎之外的手改。
 */
import { mkdir } from 'node:fs/promises'
import { OUTPUT_DIR_NAME, safeFilename } from './paths.ts'
import { atomicWrite } from './io.ts'
import { YAML } from './yaml.ts'
import type { Paths } from './paths.ts'

/** 输出区产品类（→ 我的产出/<类>/ 子目录；需求池 V-3 点名三类 + 周复盘 U-4）。 */
export const OUTPUT_KINDS = ['周复盘', '讲解稿', '错误卡'] as const
export type OutputKind = (typeof OUTPUT_KINDS)[number]

export function isOutputKind(v: unknown): v is OutputKind {
  return (OUTPUT_KINDS as readonly string[]).includes(v as string)
}

/** Obsidian 出链：vault 相对路径 → [[<去 .md 的 posix 路径>|别名]]（全路径防重名歧义）。 */
export function obsidianLink(vaultRel: string, alias?: string): string {
  const p = vaultRel.replace(/\\/g, '/').trim().replace(/\.md$/i, '')
  if (!p) throw new Error('[output] 出链目标路径不能为空。')
  return alias ? `[[${p}|${alias}]]` : `[[${p}]]`
}

/** 产物文件名安全化：不得含路径分隔与 ..（kind 已白名单，file 再设防）。 */
export function outputArtifactFile(file: string): string {
  const stem = safeFilename(file.replace(/\.md$/i, ''))
  if (!stem || stem.includes('..')) throw new Error(`[output] 产物文件名非法：${file}`)
  return `${stem}.md`
}

/** 写一份学习产物（学习中心/我的产出/<类>/<file>；原子替换——覆盖语义归各消费方，
 * 如周复盘的「现状引擎段重填、四问保留」。返回产物绝对路径）。 */
export async function writeOutputArtifact(
  paths: Paths,
  artifact: { kind: OutputKind; file: string; fm: Record<string, string | number | string[]>; body: string },
): Promise<string> {
  if (!isOutputKind(artifact.kind)) {
    throw new Error(`[output] 产物类非法：${String(artifact.kind)}（允许 ${OUTPUT_KINDS.join('/')}）`)
  }
  const file = outputArtifactFile(artifact.file)
  const dir = paths.outputKindDir(artifact.kind)
  await mkdir(dir, { recursive: true })
  const md = `---\n${YAML.stringify(artifact.fm).trimEnd()}\n---\n\n${artifact.body.trimEnd()}\n`
  const path = `${dir}/${file}`
  await atomicWrite(path, md)
  return path
}

// ---- 注册通道豁免区（note-source.normalizeSourcePath 消费）----

/** rel 是否落在注册豁免区（我的产出/ 整区含其自身 = 批量入口；项目日志单文件）。
 * 仅对学习中心内部 rel 调用；centerRel 为学习中心相对 vault 的 posix 路径。 */
export function isRegistrableCenterRel(centerRel: string, rel: string): boolean {
  const c = centerRel.replace(/\/+$/, '')
  if (rel === `${c}/${OUTPUT_DIR_NAME}` || rel.startsWith(`${c}/${OUTPUT_DIR_NAME}/`)) return true
  return /^projects\/[^/]+\/日志\.md$/.test(rel.slice(c.length + 1))
}
