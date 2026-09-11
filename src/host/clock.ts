/**
 * 宿主时钟/随机适配层（#175 阶段① / ADR-0044）：Clock／Rng 端口的真实现——
 * 真实系统时钟与 Math.random。engine 侧的端口类型、宿主侧的实现、投递层
 * （createHostRuntime）的装配，三段归属照 llm 缝同款。
 */
import type { Clock, Rng } from '../engine/index.ts'

/** 真实系统时钟（引擎的缺省注入）。 */
export const systemClock: Clock = { nowMs: () => Date.now() }

/** 默认随机源（引擎的缺省注入）。 */
export const mathRng: Rng = Math.random
