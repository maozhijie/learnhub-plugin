---
station: 课程大纲
arm: control
variant: 现状
run: 9
tool_called: false
delivered: true
schema_ok: true
input_tokens: 134
output_tokens: 2507
duration_ms: 13899
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4303 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量是一张写着名字的标签
    type: 概念
    points: 用一个具体例子建立直觉——变量由「一个名字」和「一个值」两部分组成，名字贴在值上，以后叫这个名字就能找到那个值。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字归你，值归程序
    type: 概念
    points: 名字是为了让人读得懂、让程序找得到，值才是真正被使用的内容；同一个名字先后可以指向不同的值。
    tier: 低
    visual: mermaid
  - id: s3
    title: 演示：跟着一个变量走三步
    type: 演示
    points: 逐行追踪一小段代码，看清同一个名字下的值如何从这一步到下一步被换掉，而名字始终没变。
    tier: 中
    visual: 示意图
  - id: s4
    title: 练习：亲手把一个变量改三次
    type: 练习
    points: 在交互件里改变值、观察名字仍然有效；做完能说出一句话：变的是值，不是名字。
    tier: 中
    visual: 交互
  - id: s5
    title: 概念：为什么要给值起名字
    type: 概念
    points: 收束到动机——一个值需要多处使用时，靠名字引用；要改，只改绑定的那一处，其余引用自动跟着变。
    tier: 高
    visual: mermaid
