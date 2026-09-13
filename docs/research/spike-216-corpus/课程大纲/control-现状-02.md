---
station: 课程大纲
arm: control
variant: 现状
run: 2
tool_called: false
delivered: true
schema_ok: true
input_tokens: 134
output_tokens: 3130
duration_ms: 16835
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4303 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量是装了值的命名盒子
    type: 概念
    points: 变量 = 一个名字 + 一个装着值的格子，名字是我们给"内存里某块地方"取的称呼，方便之后指着它说话。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字定死，值可以换——它为什么叫"变"量
    type: 概念
    points: 名字一旦取好就固定不变，变的是盒子里装的东西；这正是变量与常量、与一次性字面量的分界线。
    tier: 中
    visual: mermaid
  - id: s3
    title: 演示：盯着一个变量，看它的值一路变化
    type: 演示
    points: 用一个真实场景（分数、温度、倒计时）跟踪同一个名字下的值怎么一步步改变，体会"追踪一个变量"的读法。
    tier: 中
    visual: 图表
  - id: s4
    title: 交互：亲手往盒子里放值，再把它换掉
    type: 交互
    points: 动手把值放进带名字的盒子、观察"名字→当前值"的对应关系随操作变化，形成对变量是"可替换的容器"的身体记忆。
    tier: 中
    visual: 交互
  - id: s5
    title: 练习：分清名字、值与"会变"这三件事
    type: 练习
    points: 判断哪些说法把名字、值、可变性搞混了，并给几个盒子挑出读得懂的名字，检验概念是否真的落地。
    tier: 高
    visual: 无
