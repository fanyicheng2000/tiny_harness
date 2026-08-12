// ===========================================
// engine/terminal-reporter.js
// ===========================================
// 终端 UI 实现：把引擎事件打印到 stdout
//
// 注意事项：
//   1. 参数可能含换行/特殊字符，要清理一下再打印
//   2. 输出超过 200 个 JavaScript 字符要截断，避免刷屏
//   3. 用 emoji 区分事件类型，肉眼一眼能看出来
// ===========================================

import { Reporter } from './reporter.js';

export class TerminalReporter extends Reporter {
  onThinking() {
    console.log('\n[🤔 思考中] 模型正在推理...');
  }

  onToolCall(toolName, args) {
    console.log(`[🛠️ 调用工具] ${toolName}`);
    let displayArgs = String(args).replaceAll('\n', '\\n').replaceAll('\r', '\\r');
    if (displayArgs.length > 150) {
      displayArgs = displayArgs.slice(0, 150) + '... (已截断)';
    }
    console.log(`   参数: ${displayArgs}`);
  }

  onToolResult(toolName, result, isError) {
    if (isError) {
      console.log(`[❌ 执行失败] ${toolName}`);
      if (result) {
        console.log(`   错误: ${result}`);
      }
    } else {
      console.log(`[✅ 执行成功] ${toolName}`);
    }
  }

  onMessage(content) {
    if (!content) return;
    console.log(`\n🤖 Agent 回复:\n${content}\n`);
  }

  onSubAgentToolCall(toolName, args) {
    console.log(`[🛠️ [Subagent] 调用工具] ${toolName}`);
    let displayArgs = String(args).replaceAll('\n', '\\n').replaceAll('\r', '\\r');
    if (displayArgs.length > 150) {
      displayArgs = displayArgs.slice(0, 150) + '... (已截断)';
    }
    console.log(`   参数: ${displayArgs}`);
  }

  onSubAgentToolResult(toolName, result, isError) {
    if (isError) {
      console.log(`[❌ [Subagent] 执行失败] ${toolName}`);
    } else {
      console.log(`[✅ [Subagent] 执行成功] ${toolName}`);
    }
  }
}
