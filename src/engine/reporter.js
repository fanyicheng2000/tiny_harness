// ===========================================
// engine/reporter.js
// ===========================================
// Reporter 接口：把引擎内部发生的事件外抛给 UI 层
//
// 为什么抽象成接口：
//   - 终端 UI 实现一个 TerminalReporter
//   - HTML 演示页可以再实现一个 WebSocketReporter
//   - 测试代码可以 mock 一个 NoopReporter
//   引擎完全无感知，只调接口方法
// ===========================================

export class Reporter {
  onThinking() {}
  // toolCallId 用于 UI 层把 tool_call 和 tool_result 关联成卡片
  onToolCall(toolName, args, toolCallId) {}
  onToolResult(toolName, result, isError, toolCallId) {}
  onMessage(content) {}
  onSubAgentToolCall(toolName, args, toolCallId) {}
  onSubAgentToolResult(toolName, result, isError, toolCallId) {}
}

// 空实现：测试时用，啥也不打印
export class NoopReporter extends Reporter {}
