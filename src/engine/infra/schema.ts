import type { VaultFs } from './io.ts'
/**
 * schema 版本门（#138 / ADR-0034 宣告式断裂）：引擎只认当前主版本，旧库拒载并
 * 指引一次性迁移脚本——零兼容代码（不迁移、无双读、不降级，断裂语义见 ADR）。
 *
 * 版本标记住在 `学习中心/state/learnhub.json` 的 `schema` 对象：
 *   schema: { version: 3, breaks: [...断裂史·纯档案], formats: {...子格式独立演变} }
 * - version：启动硬门，非当前版本（含缺失/损坏）即拒载。
 * - breaks：断裂史追加档案，引擎零消费；一次性迁移脚本落笔。
 * - formats：子格式版本表，主版本内自由演变；子格式的破坏性变更仍走主版本断裂。
 *
 * 硬门用同步读：LearnhubEngine 构造函数没有 await，而门必须封死一切取用引擎的
 * 路径（宿主 apply、测试工厂、脚本直连）——单个小 JSON 的同步读成本可接受。
 */

/** 当前引擎唯一认许的 schema 主版本。 */
export const CURRENT_SCHEMA_VERSION = 4

/** 一次断裂的档案条目（迁移脚本落笔；引擎零消费）。 */
export interface SchemaBreak {
  /** 断裂前的来源主版本；无版本标记的史前库记 null。 */
  from: number | null
  /** 断裂日期（本地日历日 YYYY-MM-DD）。 */
  date: string
  /** 本次移入存档区的课程 root 清单。 */
  archived?: string[]
  /** 备注（哪个脚本执行的迁移等）。 */
  note?: string
}

export interface SchemaBlock {
  version: number
  breaks?: SchemaBreak[]
  formats?: Record<string, number>
}

/** 从 learnhub.json 原文提取 schema 块；损坏/缺失返回 null（拒因由 assertSchemaVersion
 * 按文件是否在处分流：损坏 vs 史前库，#295）。 */
export function parseSchemaBlock(raw: string | null): SchemaBlock | null {
  if (raw === null) return null
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof doc !== 'object' || doc === null) return null
  const schema = (doc as Record<string, unknown>).schema
  if (typeof schema !== 'object' || schema === null) return null
  const s = schema as Record<string, unknown>
  if (typeof s.version !== 'number') return null
  return {
    version: s.version,
    ...(Array.isArray(s.breaks) ? { breaks: s.breaks as SchemaBreak[] } : {}),
    ...(typeof s.formats === 'object' && s.formats !== null
      ? { formats: s.formats as Record<string, number> } : {}),
  }
}

/** 启动硬门（同步）：learnhub.json 的 schema.version 非当前版本即抛错并指引迁移
 * 脚本。版本判定口径：有 version 数字按数字比；文件缺失 = 史前库（v1 时代没有版本
 * 标记）；JSON.parse 失败 = 损坏拒因（#295：与史前库分开——损坏档可能仍可抢救，
 * 指引备份 + 人工检查，不给删库建议；可解析但无 schema 块仍视为史前库形态）。
 * v2 起出生的库由工厂/脚本盖版本戳，不存在「合法的没版本」状态。 */
export function assertSchemaVersion(configPath: string, fs: VaultFs): SchemaBlock {
  let raw: string | null = null
  try {
    raw = fs.readFileSync(configPath)
  } catch {
    // 无文件 = 史前库，走统一拒载文案
  }
  const schema = parseSchemaBlock(raw)
  if (schema && schema.version === CURRENT_SCHEMA_VERSION) return schema
  if (raw !== null && schema === null) {
    // 拒因分流（#295）：JSON.parse 本身失败 = 损坏档（可能仍可抢救，指引备份 + 人工
    // 检查，不给删库建议）；可解析但缺/坏 schema 块 = v1 史前库形态，走重建文案。
    let damaged = false
    try {
      JSON.parse(raw)
    } catch {
      damaged = true
    }
    if (damaged) {
      throw new Error(
        `[learnhub] schema 硬门：learnhub.json 存在但 JSON 解析失败（损坏）。\n`
        + `  先备份该文件再人工检查修复（档案可能仍可抢救）；不要直接删库重建。`)
    }
  }
  const found = schema ? `v${schema.version}` : '无 schema.version（v1 库）'
  throw new Error(
    `[learnhub] schema 版本硬门：learnhub.json 为 ${found}，引擎只认 v${CURRENT_SCHEMA_VERSION}`
    + `（宣告式断裂：存储塌缩，图谱改为一课程一文件 data/图.yaml，零迁移脚本）。\n`
    + `  旧课程库不再支持、由用户自删：删除旧课程目录（或整个学习中心数据目录）后重建；`
    + `跨断裂存活的档案（概念登记表等）随重建课程重新落盘。`)
}
