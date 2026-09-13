---
station: 题目生成
arm: control
variant: 现状
run: 3
tool_called: false
delivered: true
schema_ok: true
input_tokens: 176
output_tokens: 19416
duration_ms: 79432
---

## 提示词（生产拼装 + 变体后缀）

（每格每轮提示词同构：站模板 + 上下文包；逐轮实测 5207 字符，变体后缀=无）

## 原始应答（含修复轮，逐轮）

### 第 1 轮

node: 变量是什么
questions:
  - id: q1
    kind: single_choice
    q: '关于变量，下列说法正确的是？'
    options: ['变量的名字和值都固定不变', '变量是给会变的值起的名字，名字稳定、值可以改变', '变量一旦被赋值，值就永远不能再变', '变量只能被读取一次，之后名字就失效']
    answer: B
    explanation: '变量是给会变的值起的名字，名字稳定、值随时可变。关键步骤： $$\text{余额} = 50$$ 与 $$\text{余额} = 20$$ 是同一个变量在不同时刻的取值。最易错点：把“名字不变”误当成“值也不变”。'
    difficulty: 1
    section: 概念：变量是什么
    invokes: 变量
  - id: q2
    kind: fill_in_blank
    q: '把某个值写进一个名字里（例如让变量 $\text{余额}$ 取 $50$，即 $\text{余额} = 50$），这个动作叫做______。'
    answer: ["赋值"]
    explanation: '把值写进名字的动作叫赋值，读取则是拿名字换回当前的值。关键步骤： $$\text{余额} = 50$$ 表示把 50 写进变量，是赋值；查看 $\text{余额}$ 现在是多少是读取。最易错点：把“赋值”误叫成“读取”，两者方向相反。'
    difficulty: 2
    section: 概念：赋值与读取
    invokes: 变量
  - id: q3
    kind: matching
    q: '将左边的记录或操作与右边最恰当的描述配对。'
    options: ['$\text{余额} = 50$', '读取 $\text{余额}$', '早上 $\text{余额}$ 为 $50$', '晚上 $\text{余额}$ 为 $20$']
    answer: ['把 50 写进 $\text{余额}$，这是赋值', '拿 $\text{余额}$ 换回此刻的值，这是读取', '变量在早上的取值', '变量在晚上的取值']
    explanation: '赋值是把值写进变量，读取是拿变量换回当前值；不同时刻的取值属于同一个变量的不同状态。关键步骤： $$\text{余额} = 50$$ 这是赋值；读取 $\text{余额}$ 则是读取。早上和晚上的记录是同一变量在两个时刻的取值。最易错点：把赋值记录当成读取结果。'
    difficulty: 2
    section: 练习：两个时刻
    invokes: 变量
  - id: q4
    kind: true_false
    q: '先让变量 $\text{余额}$ 取 $50$（即 $\text{余额} = 50$），过一会儿再让 $\text{余额}$ 取 $20$（即 $\text{余额} = 20$）。此时读取 $\text{余额}$，得到的值是 $50$。'
    answer: 错
    explanation: '读取变量拿到的永远是此刻的值，此刻 $\text{余额}$ 已被重新赋值为 $20$。关键步骤： $$\text{余额} = 50$$ 与 $$\text{余额} = 20$$ 是两次赋值，读取发生在晚上赋值之后。最易错点：以为读取会拿回最早写下的 $50$。'
    difficulty: 3
    section: 概念：赋值与读取
    invokes: 变量
