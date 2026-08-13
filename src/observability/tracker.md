# `tracker.js` 详细讲解：Provider 装饰器、Token 与成本估算

`src/observability/tracker.js` 定义 `CostTracker`，它以装饰器模式包装任何 `BaseProvider`。对 Engine 而言，CostTracker 仍是 Provider；但每次 `generate()` 后会额外记录耗时、Token、费用、Session 累计和 Trace 属性。

## 1. 为什么用装饰器

```text
AgentEngine → CostTracker → OpenAIProvider / ClaudeProvider / MockProvider
```

Engine 只调用 `provider.generate()`，不知道外层是否有成本追踪。这样追踪逻辑不会污染 OpenAI/Claude 协议适配器，也不会给 loop.js 添加分支。

同一模式还能叠加缓存、重试、限流、审计等能力：每一层都遵守 BaseProvider 接口并代理下一个 Provider。

## 2. `PRICE_SNAPSHOTS`：本地价格快照

价格表按模型名定义每百万 Token 的输入、输出单价、币种和验证日期：

```js
{
  inputPrice: 1.25,
  outputPrice: 10.00,
  currency: 'USD',
  verifiedAt: '2026-07-20',
}
```

它是本地估算，不是供应商账单。模型未配置价格时，代码仍会累计 Token，但金额显示“未配置”，不会误报 0 成本。

Mock 价格为 0，适合离线教学；但 Mock Provider 默认不返回 usage，所以实际会进入“未返回 Usage”的日志分支，除非 Mock 被扩展。

## 3. 构造函数

```js
constructor(nextProvider, modelName, session) {
  super(nextProvider.name);
  this.nextProvider = nextProvider;
  this.modelName = modelName;
  this.session = session;
}
```

- `nextProvider`：被包装的真实协议实现；
- `modelName`：查价格表的 key，和协议类型无关；
- `session`：用于累计 Token 和按币种累计金额。

调用 `super(nextProvider.name)` 保持对外 Provider 名称一致，日志和其他装饰器无需知道被包装关系。

## 4. `generate()` 的执行流程

```js
const startTime = Date.now();
const respMsg = await this.nextProvider.generate(messages, availableTools);
const latency = Date.now() - startTime;
```

先透明地代理真实调用，再测量端到端耗时。成功返回后才读取 `respMsg.usage`。

### 4.1 Token 与费用公式

```js
amount = (promptTokens * inputPrice + completionTokens * outputPrice) / 1_000_000;
```

价格以“每百万 Token”存储，因此最后除以一百万。输入与输出价格分开是必要的：多数模型输出 Token 单价更高。

### 4.2 写入 Session

```js
this.session.recordUsage(promptTokens, completionTokens, estimate);
```

Session 维护总输入、总输出和 `estimatedCosts[currency]`。按币种分别统计，不将 USD 与其他币种直接相加。

### 4.3 写入当前 Trace Span

```js
const span = getCurrentSpan();
span.addAttribute('model', this.modelName);
span.addAttribute('promptTokens', promptTokens);
span.addAttribute('completionTokens', completionTokens);
```

由于 Engine 用 `startSpan('LLM.Action', ...)` 包裹 Provider 调用，AsyncLocalStorage 能使 Tracker 找到该 LLM Span。估算金额、币种和价格验证日期也会写入，最终随 Trace JSON 导出。

## 5. 没有 usage 时

某些 Provider 或网关不返回 usage。代码不会猜测 Token，而是打印：

```text
API 完成，但未返回 Usage
```

并原样返回模型消息。这样避免以错误估算误导用户；如果需要估算，可在 Provider 前后加 tokenizer 层，但结果仍只是近似。

## 6. 边界与改进

- 仅统计成功返回的调用；若 Provider 抛错，当前 tracker 不记录失败延迟或错误 Span 属性。可用 try/finally 增强。
- 价格快照需人工更新，应标记生效范围并避免把本地估算当账单。
- 没有缓存 Token、批处理、推理 Token、区域价格等复杂计费维度。
- `console.log` 适合教学 CLI，生产场景宜输出结构化日志/指标。
- 同一 Session 并发调用时 JS 内存累计一般安全，但跨进程会话持久化仍需避免竞争。

## 总结

`tracker.js` 将可观测性以装饰器方式附加到 Provider 调用：不改变 Engine 的接口，却能将时延、Token、金额和 Trace 关联起来。它让使用模型的成本从不可见副作用变成每轮可查看、会话可累计、Trace 可复盘的数据。