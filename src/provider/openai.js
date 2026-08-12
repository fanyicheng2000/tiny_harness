// ===========================================
// provider/openai.js
// ===========================================
// OpenAI Provider：用 fetch 调 OpenAI 兼容 API
//
// 关键设计：双向转换
//   入参：内部 schema.Message → OpenAI 格式
//   返回：OpenAI 响应 → 内部 schema.Message
//   引擎其他部分完全不知道用的哪家模型
// ===========================================

import { BaseProvider } from './interface.js';
import { Message, ToolCall, Usage } from '../schema/message.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

function parseToolArguments(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toOpenAIMessage(msg) {
  if (msg.role === 'system') {
    return { role: 'system', content: msg.content };
  }

  if (msg.role === 'user') {
    if (msg.toolCallId) {
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
    }
    return { role: 'user', content: msg.content };
  }

  if (msg.role === 'assistant') {
    const message = { role: 'assistant', content: msg.content };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      message.tool_calls = msg.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }));
    }
    return message;
  }

  return { role: 'user', content: msg.content };
}

export function toOpenAIMessages(messages) {
  return messages.map(toOpenAIMessage);
}

export class OpenAIProvider extends BaseProvider {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey - API key
   * @param {string} opts.model - 模型名
   * @param {string} [opts.baseUrl] - OpenAI 兼容 API 地址
   */
  constructor({ apiKey, model, baseUrl = 'https://api.openai.com/v1' }) {
    super('openai');
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async generate(messages, availableTools) {
    // 1. 内部 messages → OpenAI messages
    const openaiMsgs = toOpenAIMessages(messages);

    // 2. 构造请求体
    const body = {
      model: this.model,
      messages: openaiMsgs,
    };
    if (availableTools && availableTools.length > 0) {
      body.tools = availableTools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    // 3. 调 API
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API 请求失败 (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    if (!data.choices || data.choices.length === 0) {
      throw new Error('API 返回了空的 choices');
    }

    // 4. OpenAI 响应 → 内部 Message
    const choice = data.choices[0].message;
    const result = new Message({
      role: 'assistant',
      content: choice.content || '',
      toolCalls: (choice.tool_calls || [])
        .filter(tc => tc.type === 'function')
        .map(tc => new ToolCall({
          id: tc.id,
          name: tc.function.name,
          arguments: parseToolArguments(tc.function.arguments),
        })),
    });

    // 5. 提取 Token 消耗
    if (data.usage && (data.usage.prompt_tokens > 0 || data.usage.completion_tokens > 0)) {
      result.usage = new Usage(data.usage.prompt_tokens, data.usage.completion_tokens);
    }

    return result;
  }

  // 内部 Message → OpenAI message
  _toOpenAIMessage(msg) {
    return toOpenAIMessage(msg);
  }
}

// 工厂：从环境变量构造
export function createOpenAIProviderFromEnv() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('请设置 OPENAI_API_KEY');
  return new OpenAIProvider({
    apiKey,
    model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  });
}
