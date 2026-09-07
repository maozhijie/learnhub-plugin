# 测试

`node --experimental-transform-types --test tests/`（Node >=24 原生 TS；facade 测试需要
transform 模式处理注入类的 constructor parameter properties。纯模块测试仍零运行时依赖）。

接缝（2026-09-07 与用户确认）：

- S1 `quality.ts::jumpCandidates` —— 认知跨步候选（|Δdifficulty|≥2 或 depth 跨度 ≥3）
- S2 `quality.ts::floatNodes` —— 空降节点（region 序后 3/4 且 pre 空）
- S3 `health.ts::graphHealthScore` —— 前置完备项基于 S2
- S4 `quality.ts::scaleReport` —— 规模底线对照

`analyzeGraph`/`runAudit` 只做薄接线，不在接缝清单内。
