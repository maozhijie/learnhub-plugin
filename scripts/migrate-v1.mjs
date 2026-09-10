#!/usr/bin/env node
/**
 * ── 退役存根（#138 cutover 完成后按裁决废弃：用完即弃，git 留存根）──────────
 *
 * 本脚本是 v1→v2 一次性迁移脚本（宣告式断裂，ADR-0034）的存根。完整实现与其
 * 端到端测试在本文件路径下的 git 历史：
 *
 *     git log --follow -- scripts/migrate-v1.mjs
 *
 * 本机 vault 已于 2026-09-10 完成 cutover（存档区 存档/pre-v1/2026-09-10/），
 * 引擎版本硬门（src/engine/schema.ts）只认 v2。若在**另一台机器**遇到未迁移的
 * v1 旧库，两条路：
 *   1. 从 git 历史恢复本脚本后跑 `node scripts/migrate-v1.mjs <vault根目录>`；
 *   2. 按下列四步手工迁移（全部只增不删）：
 *      ① 旧课程根整树 rename 进 学习中心/存档/pre-v1/<本地日期>/<root>/
 *        （我的卡/错误卡/fsrs参数.json 随课；行为流水 practice.jsonl 原地不动——
 *        报表只查现课，无界域 streak 不连坐）；
 *      ② 概念登记表豁免：<root>/概念登记表.yaml 若存在，放回原位（跨断裂存活）；
 *      ③ 课程注册表重写 courses: []（note_sources 保留），原文拷进存档区留档；
 *      ④ learnhub.json 盖戳：{ schema: { version: 2,
 *          breaks: [{ from: 1, date, archived: [...roots] }], formats: {} } }。
 */
console.error('[migrate-v1] 本脚本已退役（cutover 一次性工具，用完即弃）。')
console.error('  本机库应已迁移；其他机器的 v1 旧库见本文件头注的恢复/手工迁移说明。')
process.exit(1)
