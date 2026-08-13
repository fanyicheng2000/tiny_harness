# `compactor.js` 详细讲解：控制 Agent 上下文长度

`Compactor` 在每次模型调用前处理消息副本，避免长任务的历史和工具输出超过模型上下文预算。它不会修改 `Session.history`，因此压缩只影响“本轮发给模型的内容”，不会损坏断点续传的完整记录。

## 构造参数

```js
new Compactor(maxChars = 200000, retainLastMsgs = 6)
```

- `maxChars`：按 JavaScript 字符估算的触发阈值；不是严格 Token 计数，但零依赖且足够做教学保护。
- `retainLastMsgs`：最近多少条消息属于工作记忆，保留较多细节。

`loop.js` 构造为 `new Compactor(200000, 6)`，并在每个 Turn 调用 `compact(contextHistory)`。

## `compact()` 的决策流程

1. `_estimateLength()` 统计每条 `content`、每个 tool call 名称及 JSON 参数长度。
2. 未达到阈值则直接返回原数组，零额外处理。
3. 达到阈值后遍历每条消息，生成 `compacted` 新数组。
4. System Message 原样保留；最近 N 条与早期消息采取不同策略。
5. 输出压缩前后长度日志。

## 三档策略

| 消息类型与位置 | 策略 | 原因 |
|---|---|---|
| System Prompt | 永不压缩 | 身份、工具纪律、安全规则不能丢 |
| 早期工具结果，超过 200 字符 | 替换为清理标记与原始长度 | 说明发生过操作，同时大幅节省空间 |
| 最近工具结果，超过 1000 字符 | 保留头 500 + 尾 500 | 头部常含内容概览，尾部常含最终状态/错误 |
| 早期 assistant 文本，超过 200 字符 | 折叠为固定提示 | 早期推理价值通常低于近期观察 |
| 其他消息 | 保持原样 | 避免无谓丢失信息 |

工具结果被识别为 `role === Role.USER && toolCallId`。这是项目内部对“工具观察消息”的表示。

## 为什么创建 `newMsg`

```js
const newMsg = { ...msg, content: msg.content };
```

压缩器不直接修改原 `Message`。这使 Session 中保存的历史仍是完整事实，Provider 调用结束后也不会污染后续持久化；但返回对象是普通对象而非 `Message` 实例，当前 Provider 只依赖字段所以可行。

## 边界与改进

- 字符数不等于各模型真实 Token；生产系统可接入 tokenizer。
- “摘要标记”不保留语义事实，复杂任务可引入 LLM 摘要，但会增加费用与不确定性。
- 仅按消息位置处理，未考虑 tool call 与 tool result 的协议配对；Session 的工作记忆截断已承担一部分保护。
- 压缩只在长度超过阈值后触发，短上下文完全无开销。

## 总结

`compactor.js` 用可预测的启发式降级，在“保留系统规则、保护最近证据、折叠早期噪声”之间取平衡，是 Agent 长任务不爆上下文的第一道保护。