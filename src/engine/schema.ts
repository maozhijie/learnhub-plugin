/**
 * schema 版本门（#138 / ADR-0034 宣告式断裂）：引擎只认当前主版本，旧库拒载并
 * 指引一次性迁移脚本——零兼容代码（不迁移、无双读、不降级，断裂语义见 ADR）。
 *
 * 版本标记住在 `学习中心/state/learnhub.json` 的 `schema` 对象：
 *   schema: { version: 2, breaks: [...断裂史·纯档案], formats: {...子格式独立演变} }
 * - version：启动硬门，非当前版本（含缺失/损坏）即拒载。
 * - breaks：断裂史追加档案，引擎零消费；一次性迁移脚本落笔。
 * - formats：子格式版本表，主版本内自由演变；子格式的破坏性变更仍走主版本断裂。
 *
 * 硬门用同步读：LearnhubEngine 构造函数没有 await，而门必须封死一切取用引擎的
 * 路径（宿主 apply、测试工厂、脚本直连）——单个小 JSON 的同步读成本可接受。
 */
import { readFileSync } from 'node:fs'

/** 当前引擎唯一认许的 schema 主版本。 */
export const CURRENT_SCHEMA_VERSION = 2

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

/** 从 learnhub.json 原文提取 schema 块；损坏/缺失返回 null（判定为史前库）。 */
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
 * 脚本。版本判定口径：有 version 数字按数字比；无 schema 块/文件缺失/JSON 损坏
 * 一律视为史前库（v1 时代没有版本标记），同样拒载——v2 起出生的库由工厂/脚本
 * 盖版本戳，不存在「合法的没版本」状态。 */
export function assertSchemaVersion(configPath: string): SchemaBlock {
  let raw: string | null = null
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    // 无文件 = 史前库，走统一拒载文案
  }
  const schema = parseSchemaBlock(raw)
  if (schema && schema.version === CURRENT_SCHEMA_VERSION) return schema
  const found = schema ? `v${schema.version}` : '无 schema.version（v1 库）'
  throw new Error(
    `[learnhub] schema 版本硬门：learnhub.json 为 ${found}，引擎只认 v${CURRENT_SCHEMA_VERSION}`
    + `（宣告式断裂，ADR-0034：旧课程树整体入存档、零兼容代码）。\n`
    + `  请先运行一次性迁移脚本：node scripts/migrate-v1.mjs "<vault根目录>"\n`
    + `  （脚本已在 cutover 完成后退役为存根——本机库应已迁移；在其他机器遇到旧 v1 库时，`
    + `脚本实现见 git 历史，存根文件头部有说明。）`)
}
