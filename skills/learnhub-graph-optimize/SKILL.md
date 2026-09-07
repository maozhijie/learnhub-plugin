---
name: learnhub-graph-optimize
description: 优化 learnhub 既有课程知识图谱（改名/调前置/增删节点/换区块），走 propose-edit 门禁后 apply 入库并自动联动笔记与引用。用于用户要求调整课程结构时。
---

# learnhub 图谱优化

对既有课程做结构化变更。铁律同生成：只产 YAML，过门禁，apply 才入库；rename/del_node 的联动（笔记文件改名、pre/enc 引用、题库文件随迁）由 apply 自动完成，绝不手工改文件。

## 工作流

1. **分析**：调用 `learnhub_graph_analyze`（`course` 指定课程）——返回结构统计、遗忘热点、不可达节点、瓶颈节点、图谱健康分（health）与下一批建议（suggestions），这是优化的依据；优化提案应引用具体条目。
2. **产出 EditProposal YAML**：

```yaml
course: 课程名
reason: 为什么改（一句话）
ops:
  - { op: add_node, node: 新节点名, region: 区名, block: 块名, pre: [前置], note: 说明 }
  - { op: del_node, node: 节点名 }            # 自动摘除所有指向它的引用
  - { op: set_pre, node: 节点名, pre: [新前置全集] }   # 整体替换
  - { op: set_enc, node: 节点名, enc: [成分技能, {node: 另一技能, w: 0.5}] }   # 成分技能边整体替换
  - { op: rename, node: 旧名, new: 新名 }      # 联动笔记文件名/正文/全部引用/db
  - { op: move, node: 节点名, region: 新区, block: 新块 }
  - { op: set_note, node: 节点名, note: 新说明 }
```

3. **提交门禁**：`learnhub_graph_propose`，`kind: "edit"`。结构检查会把 ops 代入模拟图验证：引用断边、enc 断边、改名冲突、环都会被拒；按报错修正重交。pending 提案清单用 `learnhub_graph_proposals` 查看。
4. **人工确认后 apply**：`learnhub_graph_apply`（`kind: "edit"`）。成功后向用户汇报变更清单；快照与 journal 自动留痕。

## 准则

- 一次提案聚焦一类问题，别把改名、删节点、调前置混成几十条大杂烩。
- rename 只改真正命名不当的节点：联动面广，代价不低。
- 删除节点前确认它没有学习笔记沉淀；有则优先 set_note 标记或 move 归档。
- 复盘驱动的优化可委派 `subagent_reviewer`：它读历史出结论并直接提交 edit 提案。
