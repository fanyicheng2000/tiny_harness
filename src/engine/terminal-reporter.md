# `terminal-reporter.js` 详细讲解：在 CLI 中展示 Agent 运行过程

`src/engine/terminal-reporter.js` 实现 `TerminalReporter`，继承 `Reporter`，将 Agent Engine 抛出的事件打印到标准输出。它让用户在命令行中看见 Agent 是否在思考、调用了哪些工具、工具是否失败、模型最后回复了什么。

## 1. 与 Engine 的关系

`src/index.js` 创建：

```js
const reporter = new TerminalReporter();
await engine.run(session, reporter);
```

`loop.js` 不直接格式化终端内容，而是调用 Reporter 接口方法。TerminalReporter 专注于“如何显示”，Engine 专注于“何时发生”。

```text
AgentEngine 产生事件
  → Reporter 接口
    → TerminalReporter
      → console.log(stdout)
```

这使同一 Engine 也可搭配无输出的 `NoopReporter` 或网页 Reporter。

## 2. 继承关系

```js
import { Reporter } from './reporter.js';

export class TerminalReporter extends Reporter {
  // 覆盖需要展示的方法
}
```

Reporter 的默认方法是空实现。TerminalReporter 覆盖其中几个方法，未覆盖的行为仍是空操作。因此将来 Reporter 增加新方法时，旧 TerminalReporter 不会立即因缺少方法而崩溃。

## 3. `onThinking()`：提示慢思考状态

```js
onThinking() {
  console.log('\n[🤔 思考中] 模型正在推理...');
}
```

只有 `AgentEngine.enableThinking` 开启时，`loop.js` 才调用它。这里的换行让一次新的思考阶段和上一段日志隔开；emoji 让用户快速识别状态。

这只是 UI 提示，不代表 Provider 使用了某厂商的原生思考 API。当前 Harness 的慢思考是先调用一次不含 tools 的 `generate()`，再调用带 tools 的 Action 阶段。

## 4. `onToolCall()`：打印工具调用与安全参数预览

```js
onToolCall(toolName, args) {
  console.log(`[🛠️ 调用工具] ${toolName}`);
  let displayArgs = String(args).replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  if (displayArgs.length > 150) {
    displayArgs = displayArgs.slice(0, 150) + '... (已截断)';
  }
  console.log(`   参数: ${displayArgs}`);
}
```

调用方传入的是 `JSON.stringify(call.arguments)`。

### 4.1 为什么替换换行符

工具参数可能包含多行 shell 命令或完整文件内容。如果直接输出，终端日志会被拆成很多行，用户难以区分“调用参数”和普通输出。将真实换行替换为可见的 `\n`、`\r`，可以保留信息同时维持单行日志结构。

### 4.2 为什么只保留 150 个字符

`write_file` 可能携带大段代码，`bash` 也可能有很长命令。TerminalReporter 只用于实时概览，不应把终端刷满。完整参数仍会由 Trace 的 Tool Span 记录截断预览，或可从 Session / 原始任务上下文追溯。

注意：当前仅按 JavaScript 字符串长度截断，对 emoji 等多字节字符不是字节级限制；对于终端展示这是合理的简化。

## 5. `onToolResult()`：区分成功与失败

```js
onToolResult(toolName, result, isError) {
  if (isError) {
    console.log(`[❌ 执行失败] ${toolName}`);
    if (result) console.log(`   错误: ${result}`);
  } else {
    console.log(`[✅ 执行成功] ${toolName}`);
  }
}
```

`loop.js` 会先处理 Recovery，再将最多 200 字符的 `display` 传入该方法。因此失败日志通常包含“原始错误 + 系统救援指南”的缩略版本；成功时只打印状态，避免重复输出大型文件内容或命令输出。

这种设计把“模型使用的完整工具观察”与“人类查看的控制台摘要”区分开：Session 中保留结果给模型，终端只提供可扫读反馈。

## 6. `onMessage()`：打印模型的可见回复

```js
onMessage(content) {
  if (!content) return;
  console.log(`\n🤖 Agent 回复:\n${content}\n`);
}
```

仅当 Action 阶段有文本内容时才被调用。若模型本轮仅发起工具调用、没有文本，Engine 不会输出空回复。

在工具调用前打印模型的计划性文字有助于理解 Agent 为什么采取动作；最后一轮没有 toolCalls 时，这通常就是用户看到的最终答案。

## 7. 子智能体方法

```js
onSubAgentToolCall(toolName, args) { ... }
onSubAgentToolResult(toolName, result, isError) { ... }
```

主 Agent 与 Subagent 的日志前缀不同，例如：

```text
[🛠️ [Subagent] 调用工具] read_file
[✅ [Subagent] 执行成功] read_file
```

它们的参数清理与长度限制逻辑和主 Agent 相同。当前子 Agent 失败时只打印失败状态，不打印 `result` 文本；这是为了减少嵌套探索日志的噪声，但调试子 Agent 时信息会不足。可考虑与主 Agent 一样展示截断错误。

## 8. 当前实现的改进空间

1. 可抽取参数格式化函数，避免主 Agent / Subagent 两段重复代码。
2. 可使用 `toolCallId`（Reporter 接口已提供）在日志中标记调用，方便关联并发工具的开始和结束。
3. 可通过 `process.stdout.isTTY` 和 ANSI 颜色增强交互终端，同时为重定向日志保留纯文本。
4. 可限制 `onToolResult()` 错误文本长度，避免 Recovery 后仍输出过长内容。
5. Reporter 调用目前同步。若 stdout 管道背压或远程日志上报较慢，生产系统可引入队列或异步事件总线，避免影响引擎主链路。

## 9. 总结

TerminalReporter 是 Agent 引擎的“仪表盘”。它并不参与模型推理、工具执行或错误恢复，却通过统一事件接口把这些内部活动翻译为简洁可读的 CLI 日志。其核心价值是将展示策略从 `loop.js` 解耦，使 Agent 核心保持可测试、可替换和可扩展。
