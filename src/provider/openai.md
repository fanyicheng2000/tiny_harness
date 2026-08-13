# `openai.js` 详细讲解：OpenAI 兼容协议适配器

`src/provider/openai.js` 将 tiny-harness 内部 `Message`、`ToolCall`、`ToolDefinition` 翻译为 OpenAI Chat Completions 协议，再将响应翻译回内部 Message。它是 Provider 反腐层：引擎无需理解 `tool_calls`、`role: tool`、JSON 参数字符串等协议细节。

## 1. 构造与配置

```js
constructor({ apiKey, model, baseUrl = 'https://api.openai.com/v1' }) {
  super('openai');
  this.apiKey = apiKey;
  this.model = model;
  this.baseUrl = baseUrl.replace(/\/$/, '');
}
```

`replace(/\/$/, '')` 去除 base URL 尾部斜杠，避免拼接 endpoint 时出现双斜杠。工厂 `createOpenAIProviderFromEnv()` 读取 `OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_BASE_URL`，缺少 key 时立即报错。

`DEFAULT_OPENAI_MODEL` 是默认模型名；实际部署可通过环境变量覆盖，而无需改代码。

## 2. 内部消息如何转为 OpenAI 消息

`toOpenAIMessage()` 逐个转换：

| 内部消息 | OpenAI 表达 |
|---|---|
| `role: system` | `{ role: 'system', content }` |
| 普通 `role: user` | `{ role: 'user', content }` |
| 带 `toolCallId` 的 user 消息 | `{ role: 'tool', tool_call_id, content }` |
| assistant 文本与调用 | `{ role: 'assistant', content, tool_calls }` |

工具结果在项目内部仍用 user Message 表示，但 `toolCallId` 表明它实际是对之前工具调用的观察；OpenAI Provider 将其改成协议要求的 `role: tool`。

assistant 的每个内部 ToolCall 被转换为：

```js
{
  id: toolCall.id,
  type: 'function',
  function: {
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.arguments),
  },
}
```

OpenAI 要求 arguments 是 JSON 字符串，而项目内部保持对象，方便工具直接消费。

## 3. 工具定义如何进入请求

```js
body.tools = availableTools.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
}));
```

`Registry.getAvailableTools()` 返回内部 ToolDefinition，Provider 将其包装为 OpenAI function tool schema。若 `availableTools` 是 `null` 或空数组，完全不传 `tools` 字段；这正是慢思考 Phase 1 不让模型调用工具的实现基础。

## 4. 网络请求与错误

```js
const resp = await fetch(`${this.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${this.apiKey}`,
  },
  body: JSON.stringify(body),
});
```

使用 Node 18 原生 fetch，项目无需引入 SDK。非 2xx 响应会读取文本并抛错，保留 HTTP 状态和服务端错误正文，方便 CLI 展示或上层诊断。

## 5. 响应如何还原

Provider 只取 `data.choices[0].message`。其文本成为内部 `Message.content`；`choice.tool_calls` 过滤 function 类型后转换为内部 `ToolCall`。

```js
arguments: parseToolArguments(tc.function.arguments)
```

`parseToolArguments()` 解析失败时返回 `{}`，避免模型返回非法 JSON 时直接让引擎崩溃。代价是坏参数会延后到工具执行阶段才暴露；生产环境可保留解析错误并显式回馈模型。

usage 字段也从 OpenAI 的 `prompt_tokens`、`completion_tokens` 转成内部 `Usage`，供 `CostTracker` 统一计费。

## 6. 设计边界

- 固定使用 Chat Completions endpoint，不覆盖 Responses API 或流式输出；
- 仅选择第一条 choice；
- 没有超时、重试、速率限制，这些适合放在 Provider 装饰器或 HTTP 层；
- `_toOpenAIMessage()` 暴露单条转换，便于测试；
- API key 从环境变量注入，不应写入日志或 Session。

## 总结

`openai.js` 的核心价值是双向序列化：内部的稳定消息契约与 OpenAI 兼容协议互相转换。上层 Engine 因此能切换模型，而无需修改 ReAct、工具或会话逻辑。