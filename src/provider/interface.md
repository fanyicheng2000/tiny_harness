# `interface.js` 详细讲解：Provider 的统一契约

`src/provider/interface.js` 定义 `BaseProvider`，它是 `AgentEngine` 与具体模型协议之间的边界。引擎只知道“给定消息和工具，Provider 返回一条内部 Message”，而不需要知道底层是 OpenAI、Claude 还是离线 Mock。

## 核心契约

```js
export class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  async generate(messages, availableTools) {
    throw new Error('子类必须实现 generate 方法');
  }
}
```

### `name`

用于日志、调试和装饰器识别。`OpenAIProvider` 传入 `openai`，`ClaudeProvider` 传入 `claude`，`MockProvider` 传入 `mock`。

### `generate(messages, availableTools)`

这是唯一必须实现的动作：

- `messages`：内部统一的 `Message[]`，包括 system、user、assistant，以及通过 `toolCallId` 标记的工具结果；
- `availableTools`：`ToolDefinition[]`；为 `null` 时表示调用方希望模型纯思考，不应提供工具；
- 返回值：`Promise<Message>`，必须是内部 assistant Message，包含文本、`toolCalls` 和可选 `usage`。

`async` 方法默认抛错，能在错误地直接使用 BaseProvider 时尽早暴露问题。

## 为什么需要这个层

OpenAI 和 Claude 的工具调用结构明显不同，但 `loop.js` 只调用：

```js
const response = await this.provider.generate(contextHistory, availableTools);
```

协议转换全部封装在 Provider 内。这样新增厂商只需新增一个继承 BaseProvider 的适配器，不需要修改 ReAct 循环、Session 或工具系统。

## JavaScript 中的“接口”

JS 没有 TypeScript 的 `interface`，此处通过基类、JSDoc 和运行时约定表达契约。优势是零编译配置；代价是返回类型错误可能到运行时才发现。若项目扩大，可迁移 TS 或添加运行时 schema 校验。

## 与 CostTracker 的关系

`CostTracker` 也继承 BaseProvider，并在内部代理另一个 Provider。这说明该接口不仅服务真实协议，也支持装饰器：调用方仍只依赖 `generate()`，而追踪、缓存、重试、限流可叠加在外层。

## 总结

`interface.js` 虽小，却建立了最重要的隔离边界：Agent Engine 面向稳定的内部消息模型编程，Provider 专门承担外部模型协议的双向翻译。