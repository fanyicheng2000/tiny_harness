import test from 'node:test';
import assert from 'node:assert/strict';

import { Message, Role, ToolCall } from '../src/schema/message.js';
import {
  DEFAULT_OPENAI_MODEL,
  toOpenAIMessages,
} from '../src/provider/openai.js';
import {
  DEFAULT_CLAUDE_MODEL,
  toClaudeMessages,
} from '../src/provider/claude.js';

test('OpenAI tool results use role tool and tool_call_id', () => {
  const [message] = toOpenAIMessages([
    new Message({ role: Role.USER, content: 'ok', toolCallId: 'call-1' }),
  ]);
  assert.deepEqual(message, { role: 'tool', tool_call_id: 'call-1', content: 'ok' });
});

test('Claude tool-only assistant has no empty text block', () => {
  const toolCall = new ToolCall({ id: 'call-1', name: 'read_file', arguments: { path: 'a' } });
  const converted = toClaudeMessages([
    new Message({ role: Role.ASSISTANT, content: '', toolCalls: [toolCall] }),
  ]);
  assert.deepEqual(converted.messages[0].content, [
    { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a' } },
  ]);
});

test('Claude coalesces parallel tool results into one user turn', () => {
  const converted = toClaudeMessages([
    new Message({ role: Role.USER, content: 'one', toolCallId: 'call-1' }),
    new Message({ role: Role.USER, content: 'two', toolCallId: 'call-2', isError: true }),
  ]);
  assert.equal(converted.messages.length, 1);
  assert.deepEqual(converted.messages[0], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call-1', content: 'one' },
      { type: 'tool_result', tool_use_id: 'call-2', content: 'two', is_error: true },
    ],
  });
});

test('current provider defaults are explicit constants', () => {
  assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-5.6-sol');
  assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-fable-5');
});
