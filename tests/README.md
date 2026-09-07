# 测试

`npm test`（Node >=24 原生 TS + `--experimental-transform-types`，零测试框架依赖；引擎门面测试直接实例化 `LearnhubEngine`）。

接缝（2026-09-07 与用户确认）：

- S1 `quality.ts::jumpCandidates` —— 认知跨步候选（|Δdifficulty|≥2 或 depth 跨度 ≥3）
- S2 `quality.ts::floatNodes` —— 空降节点（region 序后 3/4 且 pre 空）
- S3 `health.ts::graphHealthScore` —— 前置完备项基于 S2
- S4 `quality.ts::scaleReport` —— 规模底线对照
- Data Check `engine.index.ts::dataCheck` —— Missing/Broken 只读盘点（临时 Vault fixtures）

`analyzeGraph`/`runAudit` 只做薄接线，不在接缝清单内。
