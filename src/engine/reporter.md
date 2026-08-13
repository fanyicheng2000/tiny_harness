# `reporter.js` 详细讲解：把引擎事件与展示层解耦

`src/engine/reporter.js` 定义了 `Reporter` 和 `NoopReporter`。它不是复杂的业务逻辑，而是 Agent Engine 向外报告运行事件的边界接口。

## 1. 它解决什么问题

引擎运行时会发生许多值得展示的事件：开始思考、请求工具、工具成功或失败、模型输出文本、子智能体活动。如果在 `loop.js` 里直接 `console.log()`：

- 引擎会绑定终端，网页界面无法复用；
- 测试时会产生大量噪声；
- 新增 SSE、WebSocket、日志平台时需要修改核心循环；
- 展示逻辑和调度逻辑相互耦合。

Reporter 用观察者/端口模式解决这个问题：Engine 只发事件，外部实现决定如何展示。

```text
AgentEngine
  ├─ reporter.onThinking()
  ├─ reporter.onToolCall(...)
  ├─ reporter.onToolResult(...)
  └─ reporter.onMessage(...)
          ↓
TerminalReporter / WebReporter / NoopReporter / 测试 Spy
```

## 2. `Reporter`：JavaScript 中的接口契约

```js
export class Reporter {
  onThinking() {}
  onToolCall(toolName, args, toolCallId) {}
  onToolResult(toolName, result, isError, toolCallId) {}
  onMessage(content) {}
  onSubAgentToolCall(toolName, args, toolCallId) {}
  onSubAgentToolResult(toolName, result, isError, toolCallId) {}
}
```

JavaScript 没有 TypeScript 的 `interface` 关键字，因此这里使用带空方法的基类表达契约。子类不需要实现全部方法；未实现时调用空函数也不会出错。

各事件参数的语义：

| 方法 | 调用时机 | 参数 |
|---|---|---|
| `onThinking()` | 启用慢思考并开始 Thinking Phase | 无 |
| `onToolCall()` | 主 Agent 准备执行某个工具 | 工具名、序列化参数、调用 ID |
| `onToolResult()` | 主 Agent 拿到工具结果 | 工具名、展示结果、失败标记、调用 ID |
| `onMessage()` | 模型返回可展示的 Action 文本 | 文本内容 |
| `onSubAgentToolCall()` | 子 Agent 准备执行工具 | 与主 Agent 同类参数 |
| `onSubAgentToolResult()` | 子 Agent 拿到工具结果 | 与主 Agent 同类参数 |

`toolCallId` 很关键：同一轮可能有多个并发工具，UI 不能只按工具名配对。通过 call ID，页面可将“调用中”卡片更新为对应的“成功/失败”状态。

## 3. 引擎如何使用 Reporter

`loop.js` 中以可选方式调用：

```js
if (reporter) reporter.onThinking();
if (reporter) reporter.onToolCall(call.name, JSON.stringify(call.arguments), call.id);
if (reporter) reporter.onToolResult(call.name, display, result.isError, call.id);
if (actionResp.content && reporter) reporter.onMessage(actionResp.content);
```

`if (reporter)` 表示 Reporter 是可选依赖。Engine 可以在无 UI 的批处理场景直接运行；传入 Reporter 时，才获得进度展示。

注意 Reporter 应尽量快速、无副作用。工具执行与模型调用的正确性不能依赖展示层；如果 UI 上报失败，理想情况下也不应阻断 Agent。生产系统可在 Engine 侧包装 reporter 调用，防止展示层异常影响主任务。

## 4. `NoopReporter`：默认的静默实现

```js
export class NoopReporter extends Reporter {}
```

Noop 模式继承所有空方法，适合：

- 单元测试：不污染测试输出；
- 后台任务：不需要实时打印；
- 调用方需要统一传 Reporter、但不希望处理 `null` 分支的场景。

它体现了 Null Object Pattern：用“什么都不做的对象”替代空值判断。当前 Engine 仍支持 `null` Reporter，因此两种方式均可使用。

## 5. 可如何扩展

### 5.1 记录测试事件的 SpyReporter

```js
class SpyReporter extends Reporter {
  events = [];

  onToolCall(name, args, id) {
    this.events.push({ type: 'tool_call', name, args, id });
  }
}
```

测试可验证工具事件顺序和参数，无需截获 stdout。

### 5.2 推送到网页的 SSEReporter

```js
class SSEReporter extends Reporter {
  constructor(send) {
    super();
    this.send = send;
  }

  onMessage(content) {
    this.send({ type: 'message', content });
  }
}
```

核心引擎无需感知 HTTP Response、SSE 格式或浏览器连接。

## 6. 当前接口的注意点

- `TerminalReporter` 的方法签名只接收部分参数，例如 `onToolCall(toolName, args)`；JavaScript 允许多传参数，所以仍能符合该契约。
- 接口没有 `onRunStart`、`onRunEnd`、`onTurnStart`、`onError` 等生命周期事件。若 UI 要展示更完整状态，可以向 Reporter 增加方法，再由 Engine 在对应位置调用。
- 事件目前是同步调用。若未来 Reporter 需要异步落库，需明确是否 `await`，否则可能出现写入丢失或拖慢引擎的取舍。

## 7. 总结

`reporter.js` 用一个很小的空方法基类，把“Agent 做什么”与“用户如何看到它”分开。Engine 保持专注于 ReAct 调度，Terminal、网页、测试和监控则可在不改核心循环的前提下各自实现展示策略。
