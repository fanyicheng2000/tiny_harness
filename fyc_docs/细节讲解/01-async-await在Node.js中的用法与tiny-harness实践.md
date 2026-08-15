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

### `await`：不是“把异步变同步”，而是“异步地等结果，再继续写后续逻辑”

先记一句最实用的话：

> `await promise` 的结果是 Promise 成功后的值；在结果到来前，**当前 async 函数**停在这一行，但 Node.js 主线程并没有被卡死。

以本项目的代码为例：

```js
const resp = await fetch(url, options);
console.log(resp.status);
```

可以按下面的时间线理解：

1. `fetch(url, options)` **立刻发起** HTTP 请求，并立刻返回一个 Promise（此时还没有 `resp`）。
2. `await` 发现 Promise 未完成，于是保存“`fetch` 完成后，从 `console.log` 前继续执行”的位置，先退出当前 `generate()` 的执行。
3. Node.js 在等待网络期间可以继续处理其他 I/O、定时器和其他请求。
4. HTTP 响应到达后，Promise 成功完成；Node.js 回来继续执行这一函数，`resp` 才被赋值为响应对象，再执行下一行。

所以它有两个看似矛盾、实际同时成立的特征：

- 对**这段业务流程**而言是顺序的：没有响应就不能执行 `resp.status`，因此下一行会等。
- 对**Node.js 进程**而言仍是异步的：等网络时不会像同步读取那样占住主线程。

### 与 Java `Future` / `CompletableFuture` 的类比

下面两段的意图很接近：先发请求，拿到结果后打印状态。

```java
// Java：requestAsync 返回 CompletableFuture<Response>
CompletableFuture<Response> future = client.requestAsync(request);
Response response = future.get(); // 等待结果
System.out.println(response.status());
```

```js
// JavaScript：fetch 返回 Promise<Response>
const response = await fetch(url, options); // 等待结果
console.log(response.status);
```

`Promise` 类似 `CompletableFuture`：都是“将来才有的结果容器”。但等待方式的关键区别是：

| 写法 | 等待期间发生什么 |
| --- | --- |
| Java `future.get()` / `future.join()` | 通常阻塞**调用它的线程**；该线程不能继续干别的 Java 代码。 |
| JavaScript `await promise` | 暂停**当前 async 函数的后续语句**，把主线程还给事件循环；其他已就绪任务可以继续执行。 |

注意：Java 中也可以不用 `get()`，而用 `future.thenApply(...)` 注册后续回调，达到非阻塞组合效果；这在概念上更接近 JavaScript 的 `promise.then(...)`。`await` 只是把这种“完成后再继续”的回调链写成了从上到下的样子。

### `await` 应该怎么用：先判断有没有数据依赖

**后一步依赖前一步结果：使用顺序 `await`。** 本项目必须先收到模型回复，才能读取它要求调用哪个工具：

```js
const modelMessage = await provider.generate(messages, tools);
const toolResults = await Promise.all(
  modelMessage.toolCalls.map((call) => registry.execute(call))
);
```

这不是性能问题，而是逻辑上确实不能并行。

**彼此独立：先同时启动，再一起等待。**

```js
// 错误理解：两次 await 会让 B 在 A 完成后才开始，属于串行。
const a = await taskA();
const b = await taskB();

// 若 A、B 没有依赖关系：先发起两个任务，再等待它们都完成。
const aPromise = taskA();
const bPromise = taskB();
const [a, b] = await Promise.all([aPromise, bPromise]);
```

因此，`await` 本身不决定程序“同步还是异步”：`fetch`、文件读取等操作本来就是异步的，`await` 只是声明“此处后续逻辑必须等它的结果”。只有 `fs.readSync()` 这类同步 API 才会真正阻塞 Node.js 主线程。

当 Promise 失败时，`await` 会在当前位置像 Java 的 `get()` 抛异常一样抛出错误，可用 `try/catch` 处理：

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

## 10. Promise 是什么？和 Java `Future` 像吗？

可以把 `Promise` 理解成 Java 中 `Future` / `CompletableFuture` 的近亲：它们都代表一个**现在还没有、未来会得到的异步结果**。

例如本项目的 Provider 发起 HTTP 请求：

```js
const pendingMessage = provider.generate(messages, tools);
```

网络响应尚未到达时，`pendingMessage` 不是模型回复 `Message`，而是一个 Promise。等结果时写：

```js
const message = await provider.generate(messages, tools);
```

Promise 有三种状态：

| 状态 | 含义 | Java 的近似概念 |
| --- | --- | --- |
| `pending` | 任务仍在进行，结果尚未产生 | 未完成的 `Future` |
| `fulfilled` | 任务成功，携带一个结果值 | 正常完成的 `Future` |
| `rejected` | 任务失败，携带一个错误原因 | 异常完成的 `Future` |

状态只能从 `pending` 变为成功或失败一次，不能再改回等待状态，也不能用第二个结果覆盖第一个结果。此前审批代码中的 `resolve(answer)`，就是将等待输入的 Promise 从 `pending` 变为 `fulfilled`，并把用户输入的 `answer` 作为结果交给 `await`。

### 与 Java 的关键区别

- **相似点**：两者都可先启动任务、后等待结果，并能传播成功值或异常；`await promise` 的阅读体验很接近 `future.get()` / `future.join()`。
- **不完全相同**：Java 的 `Future.get()` 通常会阻塞当前线程；JavaScript 的 `await` 只暂停当前 `async` 函数的后续代码，不阻塞 Node.js 事件循环。
- **更接近的 Java API**：Promise 的 `then` / `catch` 更像 `CompletableFuture.thenApply` / `exceptionally`；`Promise.all([...])` 则近似 `CompletableFuture.allOf(...)` 后再汇聚各任务结果。

因此可以这样记忆：**Promise 是 JavaScript 对“未来结果”的标准表示；`async` 函数负责返回 Promise，`await` 负责在逻辑上等待它完成。**

## 11. 一句话总结

在 tiny-harness 中，`async` 表示“该能力的完成时间不确定，结果会以 Promise 返回”；`await` 表示“后续逻辑依赖它，必须等它完成”。ReAct 的轮次靠串行 await 保证因果顺序，同轮工具靠 `Promise.all + await` 获得并发性能，Registry 与 Trace 则借助 await 把异步错误和生命周期纳入可控的 Agent 系统。
