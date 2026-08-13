# `reminder.js` 详细讲解：检测 Agent 死循环并注入纠偏指令

`src/engine/reminder.js` 的核心类是 `ReminderInjector`。它解决的是 Agent 常见且昂贵的问题：模型在工具失败后，带着完全相同的工具名和参数反复重试，既不会改变结果，又会继续消耗时间和 Token。

## 1. 它在 ReAct 循环中的位置

`loop.js` 每一轮执行工具后，会调用：

```js
const reminderMsg = this.injector.checkAndInject(first.call, first.result);
if (reminderMsg) {
  session.append(reminderMsg);
}
```

因此完整链路为：

```text
模型请求工具
  → Registry 执行工具
  → 得到 ToolResult（成功 / 失败）
  → ReminderInjector 检查是否为重复失败
  → 达阈值则生成一条 Message
  → 写入 Session
  → 下一轮模型读取这条强制纠偏指令
```

提醒并不直接停止 Agent，也不替模型修复参数。它通过向上下文追加消息，要求模型改变策略。这符合 Agent 的职责边界：Harness 负责发现模式和施加约束，模型负责基于新信息重新决策。

## 2. 状态结构：`Map<fingerprint, failureCount>`

```js
constructor() {
  this.consecutiveFailures = new Map();
}
```

Map 的键是一次调用的指纹，值是同一调用连续失败次数。例如：

```text
md5("read_file" + {"path":"missing.txt"}) → 3
```

同一个工具调用不同参数时，指纹不同，分别计数。这样“读 A 文件失败三次”和“读 B 文件失败一次”不会被误判为同一种死循环。

该 Map 存在于 `AgentEngine` 持有的 ReminderInjector 实例中，因此对一次 Engine 生命周期持续有效；创建新 Engine 或重启进程会清空它。它不是持久化的跨进程防护。

## 3. `checkAndInject()` 的逐步逻辑

```js
checkAndInject(lastToolCall, lastResult) {
  if (!lastToolCall) return null;
```

没有工具调用时无需检测，返回 `null`。

```js
const fingerprint = generateFingerprint(
  lastToolCall.name,
  lastToolCall.arguments
);
```

通过工具名与参数建立“这是不是同一个操作”的稳定标识。

```js
if (!lastResult.isError) {
  this.consecutiveFailures.clear();
  return null;
}
```

任一成功会清空所有失败计数。设计意图是：成功意味着 Agent 已走出当前困境，不需要继续保留历史失败负担。

这是教学版的简单策略。更精细的策略可以只清除当前指纹、给不同工具不同阈值，或设置计数过期时间。

```js
const failCount = (this.consecutiveFailures.get(fingerprint) || 0) + 1;
this.consecutiveFailures.set(fingerprint, failCount);
```

失败时取旧计数加一，并立即写回 Map。

```js
if (failCount >= 3) {
  return new Message({ role: Role.USER, content: '[SYSTEM REMINDER 警告] ...' });
}
```

达到三次后返回一条新的 Message；未达到则返回 `null`。调用方通过是否得到 Message 决定是否追加进 Session。

## 4. 为什么提醒使用 `Role.USER`

代码生成：

```js
new Message({
  role: Role.USER,
  content: '[SYSTEM REMINDER 警告] ...',
});
```

尽管文本带有 SYSTEM REMINDER 字样，实际角色是 user，而非 `Role.SYSTEM`。原因是原本的 system prompt 已定义模型身份和固定纪律；这条提醒是一次运行过程中插入的“最新操作约束”。作为用户消息插入通常更容易跨 Provider 兼容，也能让模型将它理解为当前需要立刻处理的新指令。

代价是它并非协议层不可违背的真正 system message。若要更强制，可让内部消息模型支持动态 system 提醒，并为各 Provider 验证其消息序列规则。

## 5. `generateFingerprint()`：MD5 只用于去重，不用于安全

```js
function generateFingerprint(toolName, args) {
  const hasher = crypto.createHash('md5');
  hasher.update(String(toolName));
  hasher.update(typeof args === 'string' ? args : JSON.stringify(args));
  return hasher.digest('hex');
}
```

MD5 将任意长度的工具名和参数压缩为固定 32 位十六进制字符串，适合作为 Map key。这里不需要密码学安全性，因此 MD5 的碰撞安全缺陷不构成主要问题；它仅用于“近似标识重复调用”。

需要注意的工程细节：普通对象的 `JSON.stringify()` 结果依赖键插入顺序。语义相同但键顺序不同的参数对象可能得到不同指纹，进而绕过计数。更稳健的实现可对对象 key 排序后再序列化。

## 6. 与 RecoveryManager 的区别

两者都与工具失败有关，但作用不同：

| 组件 | 触发条件 | 作用 |
|---|---|---|
| `RecoveryManager` | 单次失败 | 解释错误、给出局部修复建议，例如重新读取文件或检查路径 |
| `ReminderInjector` | 相同调用连续失败 ≥ 3 次 | 阻止原样重试，强制模型跳出局部策略 |

因此在 `loop.js` 中，先由 Recovery 改写工具输出，再由 Reminder 根据原始 `ToolResult.isError` 统计失败。前者是软引导，后者是硬干预。

## 7. 当前实现的边界

1. `loop.js` 目前只检查并发工具结果中的第一项；如果第二个工具重复失败，Reminder 不会看到它。可改为遍历全部 observation entries。
2. 提醒达到阈值后，每次继续失败都会继续注入提醒；可引入“本指纹已提醒”的状态，避免上下文重复膨胀。
3. 成功会清空所有工具的计数，简单但较粗粒度。
4. 指纹不区分工作目录、会话阶段和错误类型；某些场景可能需要更丰富的状态。
5. Reminder 只改变上下文，不能替代最大轮数、预算、超时和人工审批等硬限制。

## 8. 总结

`reminder.js` 用极少代码提供了 Agent 可靠性的关键能力：把“重复失败”从不可见的模型行为转化为可检测状态，再将检测结果反馈给模型。它不与模型竞争决策权，而是用会话消息打断无效模式，让下一轮拥有足够强的理由去换路径、求助或结束任务。
