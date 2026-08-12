// ===========================================
// provider/claude.js
// ===========================================
// Claude Provider：用 fetch 调 Anthropic API
//
// 和 OpenAI 的关键差异：
//   1. system prompt 是顶级参数，不是 messages 数组的第一条
//   2. 工具调用是 content 里的 tool_use block，不是 tool_calls 数组
//   3. 工具结果是 tool_result block，不是 role:tool 消息
//   4. 同一轮的并行工具结果合并进一条 user 消息
//   5. 失败工具结果映射为 tool_result.is_error=true
// ===========================================

import { BaseProvider } from './interface.js';
import { Message, ToolCall, Usage } from '../schema/message.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-fable-5';

export function toClaudeMessages(messages) {
  let systemPrompt = '';
  const claudeMessages = [];

  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + msg.content;
      continue;
    }

    if (msg.role === 'user' && msg.toolCallId) {
      const blocks = [];
      while (
        index < messages.length &&
        messages[index].role === 'user' &&
        messages[index].toolCallId
      ) {
        const result = messages[index];
        const block = {
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.content,
        };
        if (result.isError) block.is_error = true;
        blocks.push(block);
        index++;
      }
      index--;
      claudeMessages.push({ role: 'user', content: blocks });
      continue;
    }

    if (msg.role === 'user') {
      claudeMessages.push({ role: 'user', content: [{ type: 'text', text: msg.content }] });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const toolCall of msg.toolCalls || []) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        });
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: ' ' });
      claudeMessages.push({ role: 'assistant', content: blocks });
    }
  }

  return { systemPrompt, messages: claudeMessages };
}

export class ClaudeProvider extends BaseProvider {
  constructor({ apiKey, model, baseUrl = 'https://api.anthropic.com' }) {
    super('claude');
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async generate(messages, availableTools) {
    // 1. 分离 system prompt 和对话消息
    const { systemPrompt, messages: claudeMsgs } = toClaudeMessages(messages);

    // 2. 构造请求体
    const body = {
      model: this.model,
      max_tokens: 4096,
      messages: claudeMsgs,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (availableTools && availableTools.length > 0) {
      body.tools = availableTools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    // 3. 调 API
    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Claude API 请求失败 (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    // 4. Claude 响应 → 内部 Message
    const result = new Message({ role: 'assistant', content: '', toolCalls: [] });
    for (const block of data.content) {
      if (block.type === 'text') {
        result.content += block.text;
      } else if (block.type === 'tool_use') {
        result.toolCalls.push(new ToolCall({
          id: block.id,
          name: block.name,
          arguments: block.input,
        }));
      }
    }

    // 5. Token 消耗（Claude 的字段名不同）
    if (data.usage && (data.usage.input_tokens > 0 || data.usage.output_tokens > 0)) {
      result.usage = new Usage(data.usage.input_tokens, data.usage.output_tokens);
    }

    return result;
  }
}

export function createClaudeProviderFromEnv() {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('请设置 CLAUDE_API_KEY');
  return new ClaudeProvider({
    apiKey,
    model: process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    baseUrl: process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com',
  });
}
