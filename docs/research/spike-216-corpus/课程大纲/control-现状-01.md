---
station: 课程大纲
arm: control
variant: 现状
run: 1
tool_called: false
delivered: true
schema_ok: true
input_tokens: 134
output_tokens: 2337
duration_ms: 12465
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 4303 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
sections:
  - id: s1
    title: 概念：变量是给数据贴上名字的盒子
    type: 概念
    points: 变量就是一个带名字的存储位置——名字用来找到它，格子用来装当前的值；先建立「名字—位置—值」三件套的直觉。
    tier: 低
    visual: 示意图
  - id: s2
    title: 概念：名字不变，盒子里的东西可以换
    type: 概念
    points: 变量的「变」指值可变而非名字可变——同一名字先后装着不同的值；与一次性写死的数据对比，看清它为什么值得存在。
    tier: 低
    visual: 示意图
  - id: s3
    title: 交互：亲手把一个变量的值换掉
    type: 交互
    points: 用一个盒子模拟器：写入新值、读回旧值，亲眼看到「同一个名字、两次读出不同结果」，把直觉变成手感。
    tier: 中
    visual: 交互
  - id: s4
    title: 思维：看到「会变的数」就抽成变量
    type: 思维
    points: 跟着高手的判断过程走一遍：哪些数据应该写死、哪些应该起个名字存起来——用一条判断链替代死记规则，收尾一句带过下一课的赋值与读取。
    tier: 中
    visual: mermaid
