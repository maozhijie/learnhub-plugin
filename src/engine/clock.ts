/**
 * 时钟与随机端口（#175 阶段① / ADR-0044 归属）：应用层声明形状，实现住适配器
 * （host/clock.ts 的 systemClock／mathRng），装配住投递层（createHostRuntime 构造
 * 引擎时经 EngineConfig 注入）。纯类型零导入——llm.ts 同款形状。
 *
 * 域层的纪律（ADR-0044 四层表）：纯日历运算（输入时间戳）住 dates.ts；读「当前
 * 时刻」与随机数属适配器关注点，engine 内不再直读——测试注入固定时钟与定长随机
 * 流后，「同一输入同一输出」可断言，而不是靠碰运气。
 */

/** 时钟端口：只给原始时间戳，日历语义（学习日/ISO 格式化）归 dates.ts 纯函数。 */
export interface Clock {
  /** 当前 Unix 毫秒时间戳。 */
  nowMs(): number
}

/** 随机源端口：[0,1) 均匀分布（Math.random 同约）。既有可注入先例（jolRng／
 * project-recall 的 rng 参数）的推广形状。 */
export type Rng = () => number
