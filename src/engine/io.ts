/**
 * 通用 IO 原语（#152 刀 1 从 store.ts 迁出）：vault 存储端口、原子写、learnhub.json
 * 配置读写、JSONL 只读。零领域依赖叶子——只准依赖 node 内置模块与 npm 包的类型、
 * 不准任何相对导入之外……本文件自 #175 阶段②起是 **VaultFs 端口的形状家**：端口
 * 住应用层、实现住适配器（host/vault-fs.ts 的 nodeVaultFs）、装配住投递层
 * （EngineConfig.fs 必填注入）。engine 内零 node:fs 导入（G8 门棘轮）。
 */

/** vault 存储端口：engine 侧一切落盘/读盘的唯一通道。语义固化：
 * 读恒 utf8 文本、mkdir 恒 recursive、readdirTypes = withFileTypes 投影。 */
export interface VaultFs {
  readFile(path: string): Promise<string>
  /** 构造期同步硬门专用（schema 版本门）；其余一律 readFile。 */
  readFileSync(path: string): string
  exists(path: string): boolean
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  readdirTypes(path: string): Promise<Array<{ name: string; directory: boolean }>>
  appendFile(path: string, data: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  /** note-source 的递归 walk 只消费 isFile 判定，端口按最小面给。 */
  statIsFile(path: string): Promise<boolean>
}

/** 临时文件 + rename 原子写。tmp 名含 `Date.now()` 是**显式登记的例外**（#175 阶段①
 * 适配器面门的基线钉住这一处）：tmp 命名属适配器关注点（ADR-0046 边界段），而 io.ts
 * 是 R5 零相对导入叶子——不能反向 import clock 端口类型，故保留直读；engine 内唯一
 * 有理由的时钟直读，除此之外 clockReads 目标归零。 */
export async function atomicWrite(path: string, data: string, fs: VaultFs): Promise<void> {
  await fs.mkdir(path.replace(/[/\\][^/\\]+$/, ''))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, path)
}

/** state/learnhub.json 整档读取：无文件/损坏 → 空档。键级缺省与非法值回落
 * 默认的语义归各消费方（ADR-0004 的 fail loud 针对学习者数据损坏，不是配置笔误）。 */
export async function readLearnhubConfig(path: string, fs: VaultFs): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** state/learnhub.json 整档原子写回（保留未触及字段；1 空格缩进 + 尾换行的统一落盘口径）。 */
export async function writeLearnhubConfig(path: string, doc: Record<string, unknown>, fs: VaultFs): Promise<void> {
  await atomicWrite(path, JSON.stringify(doc, null, 1) + '\n', fs)
}

/** jsonl 只读详报（#195）：readJsonlLines 的详报形态，判据同一实现——额外回报撕裂
 * 尾行的 1 起行号（无则 null）。dataCheck evidence_streams 靠它把撕裂尾行以 hint
 * 浮出；豁免语义见 readJsonlLines。 */
export interface JsonlReadReport<T> {
  lines: T[]
  /** 撕裂尾行（末行无换行且非法 JSON）的行号，1 起；无撕裂尾行 = null。 */
  tornTailLine: number | null
}

/** jsonl 只读原语（ADR-0053：全流水读侧唯一实现，流读取路径的 JSON.parse 只存在于
 * 本函数）：换行结尾的行解析失败 = 中段损坏，抛 Broken（文案带流标签 + 路径 + 行号，
 * 沿用「（Broken）：修复或删除该行后再试」口径，label 由调用方传入）；文件末行不以
 * \n 结尾且解析失败 = 撕裂尾行，跳过——appendFile 一次写「整行+\n」，进程中断最多
 * 烂在末行、且必然不带换行，物理特征可机械判定（豁免只认末行）；文件缺失 =
 * Missing 合法空态（返回 []）；空行照旧跳过。 */
export async function readJsonlLinesReport<T>(path: string, fs: VaultFs, label: string): Promise<JsonlReadReport<T>> {
  let raw: string
  try {
    raw = await fs.readFile(path)
  } catch {
    return { lines: [], tornTailLine: null }
  }
  const out: T[] = []
  const lines = raw.split('\n')
  const tornTail = !raw.endsWith('\n')
  let tailLine: number | null = null
  for (const [i, line] of lines.entries()) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as T)
    } catch {
      if (tornTail && i === lines.length - 1) { // 撕裂尾行：进程中断的物理残留，合法可规范化
        tailLine = i + 1
        continue
      }
      throw new Error(`[${label}] ${path} 第 ${i + 1} 行不是合法 JSON（Broken）：修复或删除该行后再试。`)
    }
  }
  return { lines: out, tornTailLine: tailLine }
}

/** jsonl 只读（静默投影）：绝大多数消费方只吃合法行，撕裂尾行豁免即可；详报形态
 * readJsonlLinesReport 供 dataCheck evidence_streams 回报尾行（#195）。 */
export async function readJsonlLines<T>(path: string, fs: VaultFs, label: string): Promise<T[]> {
  return (await readJsonlLinesReport<T>(path, fs, label)).lines
}
