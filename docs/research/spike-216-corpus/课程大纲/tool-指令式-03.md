---
station: 课程大纲
arm: tool
variant: 指令式
run: 3
tool_called: true
delivered: true
schema_ok: true
input_tokens: 140
output_tokens: 2259
duration_ms: 12043
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4366 字符，变体后缀=有）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

{"node": "变量是什么", "sections": [{"id": "s1", "title": "概念：变量是给值取的名字", "type": "概念", "points": "用一个名字代表一个值，之后提到这个名字就等于提到那个值。", "tier": "低", "visual": "示意图"}, {"id": "s2", "title": "演示：名字不变，值可以换", "type": "演示", "points": "同一个名字在不同时刻可以对应不同的值，而名字本身始终不变。", "tier": "低", "visual": "交互"}, {"id": "s3", "title": "例题：从一句话里认出名字与值", "type": "例题", "points": "在具体表述中区分「名字」与「名字指的那个值」，并顺着名字读出当前的值。", "tier": "中", "visual": "示意图"}, {"id": "s4", "title": "概念：一次命名，多处使用", "type": "概念", "points": "同一个名字可以在多处被引用，数值改动只发生在一处，这是变量省力的根源。", "tier": "中", "visual": "mermaid"}, {"id": "s5", "title": "练习：认出变量并读出它的值", "type": "练习", "points": "综合辨认变量名与值，判断名字当前对应什么值，并说明同一名字能否换值。", "tier": "高", "visual": "无"}]}
