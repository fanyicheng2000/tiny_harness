# `claude.js` 详细讲解：Anthropic Claude 协议适配器

`src/provider/claude.js` 将 tiny-harness 的统一消息格式转换为 Anthropic Messages API 格式，并将 Claude 的 content blocks 还原为内部 `Message` 与 `ToolCall`。它与 `openai.js` 一起证明：引擎可以保持不变，协议差异由 Provider 吸收。

## 1. Claude 与内部模型的关键差异

Claude API 与 OpenAI 兼容协议的差异主要是：

1. system prompt 是请求体顶级 `system`，不在 `messages` 数组；
2. assistant 工具调用是 content 数组中的 `tool_use` block；
3. 工具结果是 user content 中的 `tool_result` block；
4. 同一轮多个工具结果通常合并在一条 user message；
5. 失败结果需要标记 `is_error: true`。

`toClaudeMessages()` 专门处理这些差异。

## 2. `toClaudeMessages()`：出站消息转换

函数返回：

```js
{ systemPrompt, messages: claudeMessages }
```

### 2.1 汇总 system 消息

```js
if (msg.role === 'system') {
  systemPrompt += (systemPrompt ? '\n' : '') + msg.content;
  continue;
}
```

内部可能有多条 system Message；Claude 协议此处将它们拼接成顶级字符串。当前 Engine 通常只有一条由 PromptComposer 创建的 system prompt。

### 2.2 合并连续工具结果

```js
if (msg.role === 'user' && msg.toolCallId) {
  const blocks = [];
  while (/* 连续 user + toolCallId */) {
    blocks.push({
      type: 'tool_result',
      tool_use_id: result.toolCallId,
      content: result.content,
      is_error: result.isError || undefined,
    });
  }
  claudeMessages.push({ role: 'user', content: blocks });
}
```

Engine 一轮并发工具完成后，会连续 append 多条带 toolCallId 的内部 user Message。这里的 while 将它们合为一条 Claude user 消息，正确表达“这些结果共同回应上一轮多个 tool_use”。

`index--` 是 for 循环控制技巧：while 已经推进到第一条非工具结果，循环末尾再减一，随后外层 for 的自增正好重新处理该消息。

### 2.3 普通 user 与 assistant

普通 user 文本必须包装为 content block：

```js
{ role: 'user', content: [{ type: 'text', text: msg.content }] }
```

assistant 文本与工具请求同样进入 block 数组：

```js
{ type: 'text', text: msg.content }
{ type: 'tool_use', id, name, input: toolCall.arguments }
```

若 assistant 既无文本也无工具，代码放入一个空格 text block，避免发送空 content 数组造成协议错误。

## 3. `ClaudeProvider.generate()`：请求与响应

请求体固定包含模型、`max_tokens: 4096` 和转换后的 messages；有 system prompt 时加 `body.system`，有工具时映射为：

```js
{
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
}
```

请求使用 `POST /v1/messages`，认证头是 `x-api-key`，并声明 `anthropic-version`。

响应遍历 `data.content`：

- `text` block 追加到 `result.content`；
- `tool_use` block 转为内部 `ToolCall`，其 `input` 已是对象，无需 JSON.parse。

usage 从 Claude 的 `input_tokens`、`output_tokens` 转换为内部 `Usage`，让 CostTracker 无需知道字段差异。

## 4. 配置工厂

`createClaudeProviderFromEnv()` 从 `CLAUDE_API_KEY`、`CLAUDE_MODEL`、`CLAUDE_BASE_URL` 构造实例。没有 key 会立即抛错。base URL 去尾斜杠，避免 endpoint 拼接问题。

## 5. 当前边界与改进方向

- `max_tokens` 固定为 4096，生产场景应支持环境变量或构造参数；
- 无流式输出、重试、超时和速率限制；
- 默认假定 `data.content` 可迭代，异常响应结构可增加校验；
- system message 被拼接为字符串，若协议支持结构化 system blocks 可进一步扩展；
- 多轮工具配对仍依赖 Engine/Session 保持正确消息顺序。

## 总结

Claude Provider 最复杂的部分不在 HTTP，而在 content-block 编排：提取 system、合并并发工具结果、映射 tool_use/tool_result。它将协议复杂度隔离在单一文件，让 `loop.js` 继续只面对统一的 Message 与 ToolCall。