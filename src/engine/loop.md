# `loop.js` 详细讲解：tiny-harness 的 ReAct 调度核心

`src/engine/loop.js` 定义 `AgentEngine`，它是项目的调度中心：从 Session 获取上下文，调用模型获得下一步动作，执行工具，再将工具观察结果写回 Session；如此反复，直到模型不再要求调用工具。

## 1. 在架构中的位置

```text
src/index.js
  → AgentEngine.run(session, reporter)
    → Provider.generate()：模型回答或请求工具
    → Registry.execute()：执行工具
    → Session.append()：保存回复和观察结果
    → 下一轮
```

此文件不处理 OpenAI/Claude 的具体 HTTP 格式，也不直接读写文件或运行 Shell。它只依赖接口：

- `provider.generate(messages, availableTools)`：向模型请求下一步；
- `registry.getAvailableTools()` / `registry.execute(call)`：声明并执行工具；
- `session`：提供工作记忆与消息历史；
- `reporter`：向终端、网页或测试替身发送事件。

这就是 Harness 的依赖倒置：替换模型、工具和 UI 时，引擎循环无需改动。

## 2. 导入项与职责

```js
import { Message, Role, ToolResult } from '../schema/message.js';
import { Compactor } from '../context/compactor.js';
import { RecoveryManager } from '../context/recovery.js';
import { PromptComposer } from '../context/composer.js';
import { ReminderInjector } from './reminder.js';
import { startSpan, exportTraceToFile } from '../observability/trace.js';
```

- `Message` / `Role`：内部统一消息数据结构；
- `PromptComposer`：构造 system prompt；
- `Compactor`：压缩模型输入上下文；
- `RecoveryManager`：把工具报错转换成带修复建议的观察结果；
- `ReminderInjector`：阻止相同参数反复失败；
- `startSpan` / `exportTraceToFile`：记录并导出调用树。

`ToolResult` 在当前文件没有被使用，是可删除的冗余导入。

## 3. 构造函数：跨轮复用的运行策略

```js
constructor(provider, registry, enableThinking = false, planMode = false) {
  this.provider = provider;
  this.registry = registry;
  this.enableThinking = enableThinking;
  this.planMode = planMode;
  this.compactor = new Compactor(200000, 6);
  this.recovery = new RecoveryManager();
  this.injector = new ReminderInjector();
}
```

`provider`、`registry` 从外部注入，便于使用 OpenAI、Claude 或 Mock Provider，也便于测试。

`enableThinking` 启用“先思考、后行动”的两阶段调用；`planMode` 交给 PromptComposer，从而要求模型维护 `PLAN.md` / `TODO.md`。

`ReminderInjector` 必须跨轮复用：它保存失败指纹计数。如果每轮重新创建，就无法检测连续三次相同失败。`Compactor(200000, 6)` 表示上下文超 200000 字符时压缩，优先保护最后 6 条消息。

## 4. `run()`：一次正式 Agent 任务

```js
async run(session, reporter) {
  await startSpan('Agent.Run', async (rootSpan) => {
    const composer = new PromptComposer(session.workDir, this.planMode);
    const systemMsg = composer.build();

    let turnCount = 0;
    while (true) {
      turnCount++;
      const shouldStop = await this._runOneTurn(session, reporter, systemMsg, turnCount);
      if (shouldStop) break;
    }

    await exportTraceToFile(rootSpan, session.workDir, session.id);
  });
}
```

System Prompt 在循环前构造一次：身份、项目规则和技能说明在整个任务中固定；Compactor 也会保证 system 消息不被压缩。

`while (true)` 并非无条件死循环。每轮 `_runOneTurn()` 返回布尔值；模型没有返回 `toolCalls` 时，说明它已经给出最终文本回答，循环退出。

当前实现未限制最大 Turn 数，依赖工具超时、Recovery 和 Reminder 约束异常循环。生产环境建议额外设置轮数、总时长、Token 和预算上限。

`Agent.Run` 是根 Span，所有 Turn、模型调用、工具调用都成为它的子节点。任务结束后 Trace 导出至 `.tiny-harness/traces/`。如果中间抛出未处理异常，当前代码不会执行导出；可在未来用 `finally` 改进。

## 5. `_runOneTurn()`：一轮 ReAct

### 5.1 工具定义与工作记忆

```js
const availableTools = this.registry.getAvailableTools();
let workingMemory = session.getWorkingMemory(20);
```

模型收到的是工具的 JSON Schema，而非工具实例。Session 仅提供最近 20 条工作记忆，避免每轮携带全量历史。

### 5.2 消息边界兼容

```js
if (workingMemory.length > 0 && workingMemory[0].role !== Role.USER) {
  workingMemory = [new Message({ role: Role.USER, content: '...' }), ...workingMemory];
}
```

截断历史后，第一条可能是 assistant 或工具结果。部分 Provider 对消息序列有严格要求，因此插入 user 占位消息来保持会话语义连续；Session 内部还会清除开头的无主工具结果，两者一起提高协议兼容性。

### 5.3 拼装并压缩上下文

```js
let contextHistory = [systemMsg, ...workingMemory];
contextHistory = this.compactor.compact(contextHistory);
turnSpan.addAttribute('contextMessageCount', contextHistory.length);
```

顺序固定为 system message 在前、近期历史在后。Trace 只记录消息数量，不记录完整上下文，降低敏感内容进入追踪文件的风险。

### 5.4 可选 Thinking Phase

```js
const thinkResp = await this.provider.generate(contextHistory, null);
contextHistory.push(thinkResp);
```

启用 `enableThinking` 后，第一阶段不传工具列表，让模型先分析，不被工具选择诱导。思考文本加入当前 Turn 上下文，供下一阶段使用。这是 Harness 自建的两次普通调用，不等同厂商 Extended Thinking API；好处是跨 Provider，代价是更多延迟与 Token。

### 5.5 Action Phase 与退出

```js
const actionResp = await this.provider.generate(contextHistory, availableTools);

session.append(new Message({
  role: Role.ASSISTANT,
  content: (currentTurnThinkingContent + '\n' + (actionResp.content || '')).trim(),
  toolCalls: actionResp.toolCalls || [],
}));

if (!actionResp.toolCalls || actionResp.toolCalls.length === 0) return true;
```

Action 阶段才把工具交给模型。模型可以直接回答，也可返回一个或多个工具调用。思考内容、行动文本、toolCalls 被统一写成 assistant message；这是之后向 Provider 重放完整工具调用关系的基础。

没有工具调用时，模型最终回复已入 Session，也会通过 `reporter.onMessage()` 输出；该 Turn 返回 `true`，外层循环结束。

### 5.6 并发执行工具

```js
const observationEntries = await Promise.all(
  toolCalls.map(async (call) => {
    const result = await this.registry.execute(call);
    return { message, result, call };
  })
);
```

每个工具调用会：通知 Reporter、建立 `Tool.<name>` Span、执行 Registry、必要时注入 Recovery 提示，并构造带 `toolCallId` 的工具结果消息。

同轮工具通过 `Promise.all` 并发执行，以减少多个独立读操作的总耗时。等待全部完成后才执行：

```js
session.append(...observationEntries.map((entry) => entry.message));
```

因此下一轮模型会看到一组完整、按原调用顺序组织的观察结果。注意：并发写同一文件仍可能产生竞争；这是教学版未处理的边界。

### 5.7 Recovery 与 Reminder

```js
if (result.isError) {
  finalOutput = this.recovery.analyzeAndInject(call.name, result.output);
}
```

Registry 将工具异常转为 `ToolResult.isError`，引擎不崩溃，而是把原始错误及修复建议写回模型上下文。

随后：

```js
const first = observationEntries[0];
const reminderMsg = this.injector.checkAndInject(first.call, first.result);
if (reminderMsg) session.append(reminderMsg);
```

Reminder 根据工具名和参数的指纹统计连续失败。达到阈值时追加强制提示，要求模型停止原样重试、切换策略。当前实现只检查并发结果中的第一项，生产实现可扩展为逐项检测。

最后返回 `false`，表示还有工具动作已完成、需要下一轮让模型阅读观察结果。

## 6. `runSub()`：只读探索子智能体

`runSub(taskPrompt, readOnlyRegistry, reporter)` 创建临时 `contextHistory`，不使用外部 Session，完成即丢弃。它的 system prompt 强制子 Agent 使用工具寻找证据，而不是猜测。

关键约束：

- `readOnlyRegistry` 应只注册读取型工具；
- `MAX_SUB_TURNS = 10`，超过即抛错召回；
- 强制关闭慢思考，减少侦察任务成本与延迟；
- 子 Agent 不再请求工具时，直接返回文本报告；
- 同样使用 `Promise.all` 并发执行工具，失败时复用 Recovery。

子 Agent 与主 Agent 的区别在于：主 Agent 需要持久化、多轮面向用户；子 Agent 是一次性信息收集器，受更严格的工具与轮数限制。

## 7. Reporter 是如何解耦 UI 的

文件中所有 UI 调用均是可选的：

```js
if (reporter) reporter.onThinking();
if (reporter) reporter.onToolCall(...);
if (reporter) reporter.onToolResult(...);
if (reporter) reporter.onMessage(...);
```

`src/engine/reporter.js` 提供接口，`TerminalReporter` 打印终端，测试可使用 `NoopReporter`。因此 Engine 不需要知道输出长什么样，也不会因无 UI 环境而失败。

## 8. 一次最小运行示例

Mock Provider 第一轮请求 `read_file`、第二轮返回普通文本时，流程是：

1. `run()` 生成 system prompt；
2. Turn 1 调 Action，拿到 `read_file` toolCall；
3. Registry 执行读文件，工具结果写入 Session；
4. `_runOneTurn()` 返回 `false`；
5. Turn 2 携带之前的 assistant toolCall 与 tool result 再调模型；
6. 模型不再请求工具，结果写入 Session；
7. `_runOneTurn()` 返回 `true`，导出 Trace。

可运行：

```bash
node src/index.js --provider mock --script read-file
```

## 9. 总结

`loop.js` 的价值不在于一个 `while(true)`，而在于它把多项工程约束固定到每个 Turn：上下文可控、协议抽象、工具并发、错误可回馈、重复失败可干预、状态可追踪、UI 可替换。

ReAct 的本质是一个闭环：模型提出行动 → Harness 获得真实观察 → 模型依据观察决定下一步。`AgentEngine` 正是维持这个闭环顺序、边界和可观测性的核心。
