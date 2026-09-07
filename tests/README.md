# 测试

`node --test tests/`（Node >=24 原生 TS，零依赖；被测模块只做 `import type` 引图类型）。

接缝（2026-09-07 与用户确认）：

- S1 `quality.ts::jumpCandidates` —— 认知跨步候选（|Δdifficulty|≥2 或 depth 跨度 ≥3）
- S2 `quality.ts::floatNodes` —— 空降节点（region 序后 3/4 且 pre 空）
- S3 `health.ts::graphHealthScore` —— 前置完备项基于 S2
- S4 `quality.ts::scaleReport` —— 规模底线对照

`analyzeGraph`/`runAudit` 只做薄接线，不在接缝清单内。
