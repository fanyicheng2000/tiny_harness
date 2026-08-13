# `message.js` 详细讲解：Agent 内部的统一数据语言

`src/schema/message.js` 定义了 Harness 最基础的五类数据结构：`Role`、`Usage`、`Message`、`ToolCall`、`ToolResult`、`ToolDefinition`。它们不是业务逻辑，却是所有模块可以协作的共同语言。

如果没有统一 schema，Engine 会直接依赖 OpenAI 的 `tool_calls`，工具层又自己定义结果格式，Claude Provider 还要处理 content blocks；切换模型或新增工具时，复杂度会扩散到全项目。当前设计把外部协议都翻译成内部对象，再由各层按约定消费。

## 1. `Role`：消息角色常量

```js
export const Role = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
};
```

角色字符串与主流 LLM API 的概念一致，但项目不直接把它等同于任何一家协议。

| 角色 | 在项目中的含义 |
|---|---|
| `SYSTEM` | PromptComposer 生成的身份、规则、技能和 Plan Mode 指令 |
| `USER` | 人类任务；或通过 `toolCallId` 标识的工具观察结果 |
| `ASSISTANT` | 模型回复的文本、工具调用请求及 usage |

使用常量可避免散落 `'assistant'` 等字符串时拼写错误，也让 role 判断更清晰。

## 2. `Usage`：统一 Token 用量

```js
export class Usage {
  constructor(promptTokens = 0, completionTokens = 0) {
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
  }
}
```

不同厂商的字段不同：OpenAI 返回 `prompt_tokens`、`completion_tokens`，Claude 返回 `input_tokens`、`output_tokens`。Provider 统一转换为 `Usage`，`CostTracker` 只需读取 `promptTokens` 和 `completionTokens`，无需知道底层协议。

默认值为 0 方便构造，但“0”与“未返回 usage”语义不同：Tracker 通过 `respMsg.usage` 是否存在区分是否有可靠用量数据。

## 3. `Message`：会话与模型调用的核心单元

```js
new Message({
  role,
  content = '',
  toolCalls = [],
  toolCallId = '',
  usage = null,
  isError = false,
});
```

字段含义：

| 字段 | 作用 |
|---|---|
| `role` | system / user / assistant |
| `content` | 文本内容，默认空串 |
| `toolCalls` | assistant 请求的 `ToolCall[]` |
| `toolCallId` | 工具结果对应的调用 ID |
| `usage` | 模型响应的 Token 用量 |
| `isError` | 工具观察是否失败 |

### 工具结果为什么也是 Message

模型调用是“assistant 请求工具 → 工具结果回到模型”的对话循环。项目将工具结果表示为：

```js
new Message({
  role: Role.USER,
  content: finalOutput,
  toolCallId: call.id,
  isError: result.isError,
});
```

内部统一为 user role，Provider 再做协议适配：OpenAI 转为 `role: tool`，Claude 转为 user content 内的 `tool_result` block。这样 `loop.js` 不被厂商格式绑死。

`toolCallId` 是关联键：一轮多个并发工具时，模型和 Provider 需要知道哪份结果对应哪次调用。

## 4. `ToolCall`：模型的动作请求

```js
export class ToolCall {
  constructor({ id, name, arguments: args = {} }) {
    this.id = id;
    this.name = name;
    this.arguments = args;
  }
}
```

- `id`：唯一调用标识，用于后续 tool result 配对；
- `name`：工具名，如 `read_file`、`bash`；
- `arguments`：对象形式的参数。

内部保持对象而不是 JSON 字符串很关键：Registry 可以直接 `tool.execute(call.arguments)`。OpenAI Provider 出站时将对象 stringify，入站时再 parse；Claude 的 `tool_use.input` 本来就是对象。

## 5. `ToolResult`：工具层返回给引擎的结果

```js
export class ToolResult {
  constructor({ toolCallId, output, isError = false }) {
    this.toolCallId = toolCallId;
    this.output = output;
    this.isError = isError;
  }
}
```

Registry 无论工具成功、未知工具、审批拒绝还是执行异常，都返回 ToolResult，而不是让异常直接终止 Engine。

`isError` 会触发两套机制：

1. `RecoveryManager` 为原始错误添加修复建议；
2. `ReminderInjector` 统计重复失败，必要时插入强制纠偏消息。

因此 `isError` 不只是日志标记，而是 Agent 自愈和防死循环的控制信号。

## 6. `ToolDefinition`：模型可见的工具契约

```js
export class ToolDefinition {
  constructor({ name, description, inputSchema }) {
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
  }
}
```

每个工具通过 `definition()` 返回 ToolDefinition。Registry 汇总后交给 Provider；OpenAI Provider 将它变为 `tools[].function.parameters`，Claude Provider 变为 `tools[].input_schema`。

`description` 和 `inputSchema` 是模型理解如何调用工具的主要信息。真实本地实现不会直接暴露给模型，保持了声明与执行的分离。

## 7. 一次完整工具调用的数据流

```text
ToolDefinition
  → Provider 发送给模型
  → Provider 响应解析为 ToolCall
  → Registry.execute(ToolCall)
  → ToolResult
  → loop.js 包装为带 toolCallId 的 Message
  → Provider 在下一轮转换为目标协议的工具结果
```

这条链覆盖了本项目最重要的闭环：模型提出动作，Harness 执行，观察再反馈给模型。

## 8. JavaScript schema 的边界

这些类只负责赋值，不做运行时类型校验。例如 Message 可被构造为未知 role，ToolCall.arguments 也可能不是对象。教学项目依赖 Provider、Registry 与工具实现之间的约定。

生产系统可增加：

- role 枚举校验；
- JSON Schema 参数验证；
- toolCallId 非空和唯一性校验；
- 不可变对象或 TypeScript 类型；
- 对外部 Provider 响应的 schema 校验。

## 总结

`message.js` 是 tiny-harness 的协议核心。它把用户消息、模型回复、工具调用、工具结果和 Token 用量标准化，使 Engine、Provider、Tools、Context、Observability 能够独立演进而仍共享同一条 ReAct 数据链路。
