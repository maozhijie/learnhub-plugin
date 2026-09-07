# 行业实践扫描笔记(2026-09-07)

对应最终报告 §5。

## Duolingo
- LLM 一次生成**一课 10 道练习**("In a matter of seconds, the AI model outputs ten exercises"),数量其实也是固定的——但配多阶段人工专家审校流水线后才上架;[官方博客](https://blog.duolingo.com/large-language-model-duolingo-lessons/)、[人机协作流水线](https://blog.duolingo.com/how-duolingo-experts-work-with-ai/)、第三方解读 [Hardman](https://drphilippahardman.substack.com/p/duolingos-ai-revolution)。
- Birdbrain 模型同时估计题目难度与学习者水平,把每课维持在"挑战甜点";[官方](https://blog.duolingo.com/learning-how-to-help-you-learn-introducing-birdbrain/)、[IEEE Spectrum](https://spectrum.ieee.org/duolingo)。间隔重复用 HLR([ACL 2016 论文](https://research.duolingo.com/papers/settles.acl16.pdf))。
- 启示:**AI 生成 + 人审锚点 + 学习者数据驱动的难度自适应**三件套;难度自适应不是生成期决定,而是作答期从题池里选——与我们"生成弹性"是互补的两层。

## Khan Academy / Khanmigo
- Khanmigo 靠"grounding 在人审内容库"保准确率,不从零生成课程;约 **31% 的 AI 生成项需人工修改或直接弃用**([The Learning Standard 报道](https://thelearningstandard.org/news/khan-academy-upgrades-ai-tutor-with-visual-tools-and-teacher-controls));官方明确要求教师复核 AI 输出([usage guidelines](https://support.khanacademy.org/hc/en-us/articles/25358718125837-Khanmigo-usage-guidelines-for-educators))。
- 启示:(a) 高失败率是行业常态,不必以 100% 首过为目标;(b) "锚点人审"与 ADR-0003 的思路一致;(c) grounding(上下文包、前置已教概念)方向正确。

## Brilliant
- 问题先行(problem-first):从最简版本的概念出发,每道交互题即时定制反馈;[about](https://brilliant.org/about/)、[faq](https://brilliant.org/faq/)。
- AI 用法:学习设计师**描述要出的题**→AI 生成→人审("Hand-crafted, machine-made");[官方博客](https://blog.brilliant.org/hand-crafted-machine-made/)。
- 启示:"例题先行、讲解后置"是可评估的节段编排变体;AI 定位为"把设计师意图展开成内容",而非"自主决定内容"。

## 对本系统的综合对照

1. 成熟产品没有一家把"数量/形式完全交给模型"——都用**结构模板+人工锚点**;我们要的弹性应是"模板按复杂度选档",不是"无模板"。
2. 质量控制的公认形态是**流水线**(生成→程序校验→人审→学习者数据反馈),不是单点门禁;我们的门禁应前移程序性修复、后接人审锚点。
3. 难度/练习自适应的消费端(Birdbrain 式)是比生成端弹性更成熟的方向,依赖作答数据——支持把闭环列为远期单独立项。
4. 31% 弃改率 + Duolingo 固定 10 题:固定数量不是原罪,与内容无关的固定才是;数量模板按 est/difficulty 分档即可达到行业水准。
