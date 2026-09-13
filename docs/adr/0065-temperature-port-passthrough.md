# ADR-0065: temperature 端口贯通（默认值不动）

日期：2026-09-13 ｜ 票：#219 ｜ 总纲：#212

## 背景与问题

dsh-llm 有 `temperature` 旋钮，但引擎端口 `LlmComplete`／`LlmStream` 没有这个参数、宿主适配器（`src/host/llm.ts`）也不透传——按站调节采样温度在当前分层下**没有手柄**：任何想调温度的调用点只能绕过端口直连 dsh，那会同时绕过档位翻译、截断重试、语料捕获与 usage 计量四条缝纪律。

#212 §五 的结构化路线把「格式敏感度」写进按站治理：创意/推理敏感站默认不迁 JSON 的判据之一就是「格式约束会收窄答案空间」（arXiv:2607.18476：一句「Reply with JSON only」使众数答案占比 41%→64%）。工具调用通道 spike（#216）是第一个需要**显式设值**的消费方——双臂实验要在同提示词下比较给值与否，端口没有这个参数就没法做。

## 裁决

### 1. 端口加可选 `temperature`，缺省 = 不传

- `LlmComplete(prompt, system, opts)`：`opts.temperature?: number`；
- `LlmStream(req)`：`req.temperature?: number`；
- 适配器三处直通 provider：`llmSeam`（补全缝）、`llmStreamSeam`（工具回路缝）、`llmStreamOnce`；`streamDshTurn` 只在**有值**时才把键放进 `ctx.llm.stream` 请求——`undefined` 时整键缺席，与今天逐字等价。

**不传 = 宿主/部署默认档**：本票不动任何默认值，也**不动任何调用点**——「多样性证据下创意站不追低温度」是 #212 的既定立场，评审/机械站的低温度留票外裁决。端口只提供手柄，谁用、用多少由后续票各自决策并留痕。

### 2. 重试路径原样携带

`streamWithPolicies` 的两次重放（max-tokens 截断提高上限重试一次、`UNSUPPORTED_REASONING_EFFORT` 降级为部署默认重试一次）都是**同一调用意图的重放**，采样旋钮不中途变：temperature 住在 `run` 闭包里随两次尝试原样进请求。

### 3. 证据：探针证明「无调用点设值」

`tests/llm-temperature.test.ts` 两条断言各守一半：

- **无调用点行为变化**：真实生成管线（临时 vault + 生产入队/执行路径，走 `enqueueGeneration` → 大纲 → 逐节 → 出题）跑在「捕获每个 dsh 流请求」的假 ctx 上，**全程每一次调用**的请求面都不得出现 `temperature` 键（`'temperature' in req === false`）——这是「默认值不动」的机器证据，不是通读代码后的相信。
- **适配器透传**：给值原样进 provider 请求（含 `0` 值不被 falsy 吞）、不给则整键缺席；补全缝与工具回路缝各测一遍。

两条行为快照（`host-routes-snapshot.json`／`host-tools-behavior.json`）里的 `llmSeam` 闭包**源码文本**随本票逐字迁移（探针把注入的闭包 stringify 进快照，加一行 spread 即文本漂移）：diff 逐条人审确认为「仅新增 temperature 行」，`status` 漂移 0。

## 影响

- 端口消费者仍可整体忽略新键（测试假端口零改动）；#216 spike 是首个显式设值调用点。
- 若未来要按站调温度：改调用点并在票面留痕（本票明确不预设任何档位）。
