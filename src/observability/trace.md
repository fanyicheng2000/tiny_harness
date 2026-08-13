# `trace.js` 详细讲解：用 Span 树回放一次 Agent 运行

`src/observability/trace.js` 实现轻量调用链追踪。它将一次 Agent Run 组织成树：根节点是 `Agent.Run`，其子节点是每个 `Turn-N`，Turn 下再包含 `LLM.Thinking`、`LLM.Action` 和 `Tool.<name>`。这让开发者能复盘每一步耗时、上下文规模、工具参数摘要及费用属性。

## 1. `Span` 数据结构

```js
class Span {
  constructor(name) {
    this.name = name;
    this.startTime = Date.now();
    this.endTime = null;
    this.durationMs = 0;
    this.attributes = {};
    this.children = [];
  }
}
```

每个 Span 有：

- `name`：操作名称，如 `Agent.Run`、`LLM.Action`；
- 起止时间与 `durationMs`：以毫秒统计耗时；
- `attributes`：额外元信息，如模型、Token、费用、工具参数预览；
- `children`：嵌套子操作。

`end()` 在 finally 中调用，保证回调抛错时也会记录结束时间。`addAttribute()` / `addChild()` 是最小的树构建 API。

## 2. 为什么使用 `AsyncLocalStorage`

```js
const traceStorage = new AsyncLocalStorage();
```

Agent 调模型、读文件、执行子进程都是异步操作。若靠函数参数手动传 `parentSpan`，每层 API 都要改签名，异步并发时也容易串错父节点。

AsyncLocalStorage 将“当前 Span”绑定到异步执行链：在一个 Turn 内启动 LLM 调用或多个并发工具时，每项都可通过 `getCurrentSpan()` 取到正确上下文。它类似 Node.js 版本的请求上下文/线程本地存储，但适用于 async/await。

## 3. `startSpan()`：自动建树的包装器

```js
export async function startSpan(name, fn) {
  const parent = traceStorage.getStore();
  const span = new Span(name);
  if (parent) parent.addChild(span);

  try {
    return await traceStorage.run(span, () => fn(span));
  } finally {
    span.end();
  }
}
```

执行步骤：

1. 从当前异步上下文拿父 Span；
2. 创建新 Span，若有父节点则挂到 `children`；
3. 在新 Span 上下文中运行回调；
4. `await` 等待回调的完整异步生命周期；
5. 无论成功还是失败，finally 都结束 Span；
6. 将回调原本的返回值或异常继续传递给调用方。

`return await` 在这里很重要：若直接不等待回调 Promise，finally 会过早执行，duration 只记录“启动操作”的瞬间而非真实耗时。

## 4. 在 Engine 中如何形成树

`loop.js` 的调用大致是：

```text
Agent.Run
 ├─ Turn-1
 │   ├─ LLM.Thinking（可选）
 │   ├─ LLM.Action
 │   ├─ Tool.read_file
 │   └─ Tool.bash
 └─ Turn-2
     └─ LLM.Action
```

同轮 `Promise.all` 并发工具均在同一个 Turn Span 上下文里创建，因此会并列成为 Turn 的 children；每个 Span 自己记录独立耗时。

## 5. Trace 导出

```js
export async function exportTraceToFile(rootSpan, workDir, sessionId) {
  const traceDir = path.join(workDir, '.tiny-harness', 'traces');
  await fs.mkdir(traceDir, { recursive: true });
  const fullPath = path.join(traceDir, `trace_${sessionId}_${Date.now()}.json`);
  await fs.writeFile(fullPath, JSON.stringify(rootSpan, null, 2), 'utf8');
  return fullPath;
}
```

每次 Run 创建一个带 sessionId 与时间戳的 JSON 文件。使用 `fs/promises` 异步创建目录和写文件，不阻塞事件循环。输出是直接序列化 Span 树，便于网页演示、后处理或人工查看。

文件名中的 sessionId 来自 CLI 参数；Session 自身会限制合法字符，避免常规路径穿越。若单独调用导出函数，应同样确保 sessionId 可信。

## 6. `getCurrentSpan()`

```js
export function getCurrentSpan() {
  return traceStorage.getStore();
}
```

CostTracker 在 Provider 调用完成后用它获取当前 LLM Span，并添加 model、promptTokens、completionTokens、estimatedCost 等属性。工具实现也可调用它记录输出长度或业务标签，而无需把 Span 参数层层传递。

## 7. 边界与改进

- Span 只有时间与属性，没有 status、error、traceId/spanId、采样策略或跨进程传播；它是教学级追踪，而非 OpenTelemetry 完整实现。
- `attributes` 可能包含工具参数，应避免写入密钥或敏感内容；当前 loop.js 会截断参数到 200 字符，但仍需注意。
- Agent 异常时 `startSpan` 会结束 Span，但 Engine 当前不一定导出根 Trace；可用 finally 改进。
- `Date.now()` 精度适合毫秒级分析，不适合微基准。

## 总结

`trace.js` 通过 AsyncLocalStorage 与嵌套 Span 包装器，把分散的 async 调用自动组织为可导出的树。它让 Agent 不再是黑盒循环，而成为能定位慢点、失败位置与费用来源的可回放执行链。