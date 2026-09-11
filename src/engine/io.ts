/**
 * 通用 IO 原语（#152 刀 1 从 store.ts 迁出）：原子写、learnhub.json 配置读写、
 * JSONL 只读。零领域依赖叶子——只准依赖 node 内置模块与 npm 包，不准任何相对
 * 导入；engine 任何模块（含 graph 这类低层结构模块）都可安全回引，不构成对存储层
 * 的反向依赖（ADR-0042）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

/** 临时文件 + rename 原子写。 */
export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, path)
}

/** state/learnhub.json 整档读取：无文件/损坏 → 空档。键级缺省与非法值回落
 * 默认的语义归各消费方（ADR-0004 的 fail loud 针对学习者数据损坏，不是配置笔误）。 */
export async function readLearnhubConfig(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** state/learnhub.json 整档原子写回（保留未触及字段；1 空格缩进 + 尾换行的统一落盘口径）。 */
export async function writeLearnhubConfig(path: string, doc: Record<string, unknown>): Promise<void> {
  await atomicWrite(path, JSON.stringify(doc, null, 1) + '\n')
}

/** jsonl 只读（跳过半行损坏——追加写单行原子，中断最多留半行尾；store 与无依赖
 * 读侧扫描器共用的唯一实现，#146 起从私有方法提升为模块函数）。 */
export async function readJsonlLines<T>(path: string): Promise<T[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as T)
    } catch {
      // 跳过半行损坏（进程中断可能留下未写完的尾行）
    }
  }
  return out
}
