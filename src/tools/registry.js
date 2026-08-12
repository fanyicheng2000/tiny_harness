// ===========================================
// tools/registry.js
// ===========================================
// 工具注册表 + 中间件拦截
//
// 职责：
//   1. 注册工具（Register）
//   2. 挂载中间件（Use）—— 用于人类审批
//   3. 执行工具（Execute）—— 先过中间件，再调真实工具
//
// 中间件签名：(call) => { allowed, rejectReason }
//   返回 { allowed: false } 就拦截，返回 { allowed: true } 就放行
// ===========================================

import { ToolResult } from '../schema/message.js';

export class Registry {
  constructor() {
    this.tools = new Map();        // name → tool
    this.middlewares = [];          // 中间件链
  }

  // 挂载中间件
  use(middleware) {
    this.middlewares.push(middleware);
  }

  // 注册工具
  register(tool) {
    const name = tool.name();
    if (this.tools.has(name)) {
      console.warn(`[Warning] 工具 '${name}' 已经被注册，将被覆盖。`);
    }
    this.tools.set(name, tool);
    console.log(`[Registry] 成功挂载工具: ${name}`);
  }

  // 获取所有工具定义（传给模型）
  getAvailableTools() {
    return Array.from(this.tools.values()).map(t => t.definition());
  }

  /**
   * 执行工具调用
   * @param {ToolCall} call
   * @returns {ToolResult}
   */
  async execute(call) {
    // 1. 路由查找
    const tool = this.tools.get(call.name);
    if (!tool) {
      return new ToolResult({
        toolCallId: call.id,
        output: `Error: 系统中不存在名为 '${call.name}' 的工具。`,
        isError: true,
      });
    }

    // 2. 核心防御：依次运行中间件（人类审批在这一层）
    // 中间件可以是同步的，也可以是 async 的（await 自动兼容）
    for (const mw of this.middlewares) {
      const { allowed, rejectReason } = await mw(call);
      if (!allowed) {
        console.log(`[Registry] ⚠️ 工具 ${call.name} 被 Middleware 拦截: ${rejectReason}`);
        return new ToolResult({
          toolCallId: call.id,
          output: `执行被系统拦截。原因: ${rejectReason}`,
          isError: true,  // 必须返回 Error，强制大模型阅读拒绝理由
        });
      }
    }

    // 3. 执行工具逻辑
    try {
      const output = await tool.execute(call.arguments);
      return new ToolResult({
        toolCallId: call.id,
        output,
        isError: false,
      });
    } catch (err) {
      return new ToolResult({
        toolCallId: call.id,
        output: `Error executing ${call.name}: ${err.message}`,
        isError: true,
      });
    }
  }
}
