# async / await 在 Node.js 中的用法与 tiny-harness 实践

> 当前项目语言为 **JavaScript（Node.js ≥ 18，ES Module）**。`async` / `await` 是 JavaScript 基于 Promise 的异步控制流语法，用来表达“发起异步操作 → 等待结果 → 再继续”。

## 1. 为什么 Coding Agent 离不开异步

项目的大量工作都需等待外部事件：

- Provider 通过 HTTP 请求调用大模型；
- 文件工具读取、写入文件；
- `bash` 工具启动子进程并等待命令完成；
- 审批中间件等待终端用户输入；
- 同一轮可能同时执行多个工具。

若采用回调，ReAct 循环的顺序、错误处理和并发汇聚会很难理解。项目用 `async` / `await` 让这些流程近似同步代码的写法。

## 2. 基础语义

### `async`：函数总是返回 Promise

```js
async function getValue() {
  return 'done';
}

const promise = getValue();
```

`promise` 是 `Promise`，而非字符串。`async` 函数内 `return value` 会得到成功状态的 Promise；`throw error` 会得到失败状态的 Promise。

### `await`：等待 Promise 的最终结果

```js
async function main() {
  const value = await getValue();
  console.log(value); // done
}
```

`await` 暂停的是当前 `async` 函数后续语句，并不阻塞整个 Node.js 事件循环。网络、文件 I/O 和其他已调度任务仍可运行。

当 Promise 失败时，`await` 会在当前位置抛错，可用 `try/catch` 处理：

```js
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  console.error(error.message);
}
```

## 3. 项目实践一：串行等待 ReAct 的每一轮

`src/engine/loop.js` 的 `AgentEngine.run()` 是最典型的顺序 await：

```js
while (true) {
  turnCount++;
  const shouldStop = await this._runOneTurn(session, reporter, systemMsg, turnCount);
  if (shouldStop) break;
}
```

每轮都必须等 `_runOneTurn()` 完整结束，才可进入下一轮。因为下一轮需要读取本轮写入的 `session` 历史、工具观察结果和 Reminder 注入信息。

如果遗漏 `await`，`shouldStop` 会是 Promise 对象而不是布尔值；更严重的是多轮可能并发读写同一 Session，导致历史消息顺序损坏。

## 4. 项目实践二：有依赖的异步任务必须串行

慢思考模式下，`src/engine/loop.js` 先调用不带工具的 Thinking 阶段，再将结果加入上下文，最后调用带工具的 Action 阶段：

```js
const thinkResp = await this.provider.generate(contextHistory, null);
contextHistory.push(thinkResp);

const actionResp = await this.provider.generate(contextHistory, availableTools);
```

第二次调用依赖第一次的输出，因此必须使用两个顺序的 `await`。这不是“性能差”，而是正确表达数据依赖。

Provider 内部也使用 await 等待 HTTP 生命周期：

```js
const resp = await fetch(url, options);
if (!resp.ok) {
  const text = await resp.text();
  throw new Error(text);
}
const data = await resp.json();
```

`fetch()`、`resp.text()`、`resp.json()` 都是 Promise。Provider 把网络/解析错误继续抛出，交由更高层决定如何处理。

## 5. 项目实践三：await 兼容同步与异步中间件

`src/tools/registry.js` 的 middleware 调用为：

```js
const { allowed, rejectReason } = await mw(call);
```

这里的 `mw` 可以直接返回普通对象，也可返回 Promise：

- 同步安全策略可立即返回 `{ allowed: true }`；
- 人工审批可异步等待 `readline` 用户输入。

JavaScript 中 `await 普通值` 会立即得到该值，所以这一写法让 Registry 用同一接口兼容同步和异步中间件。

工具执行也用 `try/catch + await`：

```js
try {
  const output = await tool.execute(call.arguments);
  return new ToolResult({ toolCallId: call.id, output, isError: false });
} catch (err) {
  return new ToolResult({ toolCallId: call.id, output: err.message, isError: true });
}
```

这使工具失败不会直接摧毁 Agent 循环，而会转换为 `ToolResult.isError`，后续由 Recovery 和 Reminder 引导模型修正。

## 6. 项目实践四：并发工具——Promise.all 再 await

一轮里多个工具互不依赖时，项目不会逐个等待，而是先同时启动：

```js
const observationEntries = await Promise.all(
  toolCalls.map(async (call) => {
    const result = await this.registry.execute(call);
    return { result, call };
  })
);
```

执行顺序是：

1. `map(async ...)` 对每个调用创建并启动异步任务；
2. 得到 Promise 数组；
3. `Promise.all()` 聚合全部 Promise；
4. 外层 `await` 等所有任务结束，再取得按原调用顺序排列的结果。

之后项目才将所有观察结果一次写入 Session：

```js
session.append(...observationEntries.map((entry) => entry.message));
```

这样下一轮模型看到的是完整的一组工具结果，不会因哪个 I/O 先完成而出现不确定的消息顺序。

**判断准则：**

- 后续任务依赖前一任务结果：串行 `await`；
- 任务相互独立且希望降低总耗时：并发启动，再 `await Promise.all()`。

并发不是没有边界。两个同时写同一个文件的工具调用仍可能竞争；教学项目默认信任模型对同轮独立性的判断，生产实现通常需要资源锁或依赖图。

## 7. async 回调与 Trace 生命周期

`src/observability/trace.js` 的 `startSpan()` 也需要等待回调的完整异步生命周期：

```js
export async function startSpan(name, fn) {
  const span = new Span(name);
  try {
    return await traceStorage.run(span, () => fn(span));
  } finally {
    span.end();
  }
}
```

`return await` 确保 `fn(span)` 完成或失败后才进入 `finally`，所以 `span.end()` 记录的是完整的 LLM 调用或工具调用耗时，而非刚启动时就结束。结合 `AsyncLocalStorage`，`CostTracker` 能在异步 Provider 调用中找到正确的当前 Span 并写入 Token、模型和费用信息。

## 8. 常见误解

### 误解一：await 会阻塞整个程序

不准确。它只暂停当前 async 函数。I/O 操作仍由事件循环推进。项目的一轮多工具并发依赖此特性。

但纯 JavaScript 的 CPU 密集同步计算仍会占住主线程；给函数加 `async` 不会自动让计算多线程。此类工作需 Worker Threads 或子进程。

### 误解二：async 函数天然并发

不准确。下面是串行：

```js
const a = await taskA();
const b = await taskB();
```

下面才是并发汇聚：

```js
const [a, b] = await Promise.all([taskA(), taskB()]);
```

本项目对“思考 → 行动”“一轮 → 下一轮”选择串行；对“同一轮独立工具”选择并发。

### 误解三：忘记 await 不严重

危险。可能导致：

- 将 Promise 当普通值或布尔值使用；
- `try/catch` 捕获不到异步失败；
- 下一轮在本轮 Session 尚未更新前启动；
- 保存会话、导出 trace 或进程退出发生得过早。

例如 `runOneTurn()` 必须 `await engine.run(...)`，然后才进入 `finally` 调用 `session.save()`；否则可能把不完整会话写到 JSONL。

## 9. 在本项目里写异步代码的准则

1. 函数内部要等待网络、文件、子进程或交互输入时，声明为 `async`。
2. 由依赖关系决定 await 的顺序，不要为了“看起来异步”盲目并发。
3. 独立任务使用 `Promise.all` 汇聚；需要容忍部分失败时，可改用 `Promise.allSettled`，或像本项目一样在单项内部转换为 `ToolResult`。
4. 在调用边界处理失败：Provider 可抛网络错误；Registry 将工具错误转换成模型能理解的结构化观察。
5. 不要遗漏关键 await，尤其是 Session 落盘、Trace 导出、Agent 引擎运行和用户输入等待。

## 10. 一句话总结

在 tiny-harness 中，`async` 表示“该能力的完成时间不确定，结果会以 Promise 返回”；`await` 表示“后续逻辑依赖它，必须等它完成”。ReAct 的轮次靠串行 await 保证因果顺序，同轮工具靠 `Promise.all + await` 获得并发性能，Registry 与 Trace 则借助 await 把异步错误和生命周期纳入可控的 Agent 系统。
