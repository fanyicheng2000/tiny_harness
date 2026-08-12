// ===========================================
// schema/message.js
// ===========================================
// 数据结构层：定义 Agent 内部所有的消息格式
// 这是整个项目的"通用语言"，所有模块都依赖它
// ===========================================

// 消息角色（和 OpenAI / Claude 的 role 一致）
export const Role = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
};

// 单次 API 调用的 Token 消耗
export class Usage {
  constructor(promptTokens = 0, completionTokens = 0) {
    this.promptTokens = promptTokens;
    this.completionTokens = completionTokens;
  }
}

// 消息：Agent 内部的统一消息格式
// 一条消息可能是：系统提示 / 用户输入 / 助手回复 / 工具结果
export class Message {
  constructor({ role, content = '', toolCalls = [], toolCallId = '', usage = null, isError = false }) {
    this.role = role;             // system / user / assistant
    this.content = content;       // 文本内容
    this.toolCalls = toolCalls;   // 助手要调用的工具列表（只有 assistant 有）
    this.toolCallId = toolCallId; // 工具结果消息的关联 ID（只有 user 角色作为工具结果时有）
    this.usage = usage;           // Token 消耗（只有 assistant 有）
    this.isError = isError;       // 工具结果是否失败（Provider 可映射到厂商协议）
  }
}

// 工具调用：模型决定要调哪个工具、传什么参数
export class ToolCall {
  constructor({ id, name, arguments: args = {} }) {
    this.id = id;             // 调用 ID（用于关联工具结果）
    this.name = name;         // 工具名
    this.arguments = args;    // 参数（对象，不是 JSON 字符串）
  }
}

// 工具执行结果
export class ToolResult {
  constructor({ toolCallId, output, isError = false }) {
    this.toolCallId = toolCallId;
    this.output = output;
    this.isError = isError;
  }
}

// 工具定义：告诉模型"有这些工具可用"
export class ToolDefinition {
  constructor({ name, description, inputSchema }) {
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema; // JSON Schema 对象
  }
}
