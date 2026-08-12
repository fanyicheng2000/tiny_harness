// ===========================================
// provider/interface.js
// ===========================================
// LLM Provider 统一接口
// 引擎只依赖这个接口，不依赖具体厂商
// 真实网络协议只分 OpenAI 兼容与 Claude 兼容；Mock 用于离线测试
// ===========================================

// LLMProvider 接口（JavaScript 用 JSDoc 注释表达接口契约）
// 所有 provider 实现都要满足这个方法签名
//
// @typedef {Object} LLMProvider
// @property {string} name - provider 名称（用于日志）
// @property {(messages: Message[], availableTools: ToolDefinition[]) => Promise<Message>} generate
//   - messages: 完整的上下文历史（含 system / user / assistant / 工具结果）
//   - availableTools: 可用工具列表（null 表示不传工具，用于慢思考 Phase 1）
//   - 返回: 模型的响应消息（含 content 和 toolCalls）
//

export class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * @param {Message[]} messages
   * @param {ToolDefinition[]|null} availableTools
   * @returns {Promise<Message>}
   */
  async generate(messages, availableTools) {
    throw new Error('子类必须实现 generate 方法');
  }
}
