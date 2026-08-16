import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentDefinition,
  AgentRegistry,
  RootAgentDefinition,
} from '../src/agents/agent-registry.js';

const child = {
  id: 'code-writer',
  name: '代码实现助手',
  description: '根据任务实现代码',
  systemPrompt: '你是谨慎的代码实现助手。',
  skillIds: ['repo-conventions'],
  toolNames: ['read_file', 'edit_file'],
};

function makeRoot(overrides = {}) {
  return {
    id: 'release-manager',
    name: '发布协调助手',
    description: '负责拆分发布任务并汇总结果',
    systemPrompt: '你是发布协调助手。',
    skillIds: ['release-process'],
    toolNames: ['read_file', 'run_subagent'],
    multiAgents: [child],
    ...overrides,
  };
}

test('root agent and its direct subagents are configured from one platform model', () => {
  const registry = new AgentRegistry(makeRoot());
  const root = registry.getRootAgent();
  const subagent = registry.getSubagent('code-writer');

  assert.equal(root.name, '发布协调助手');
  assert.deepEqual(root.skillIds, ['release-process']);
  assert.equal(subagent.name, '代码实现助手');
  assert.deepEqual(subagent.toolNames, ['read_file', 'edit_file']);
  assert.equal(registry.listSubagents().length, 1);
});

test('subagent rejects nested multiAgents to enforce a single delegation layer', () => {
  assert.throws(
    () => new AgentDefinition({ ...child, multiAgents: [] }),
    /不允许携带 multiAgents/
  );
});

test('root agent rejects duplicate subagent IDs', () => {
  assert.throws(
    () => new RootAgentDefinition(makeRoot({ multiAgents: [child, child] })),
    /重复 ID/
  );
});

test('root agent only resolves configured direct subagents', () => {
  const registry = new AgentRegistry(makeRoot());
  assert.throws(() => registry.getSubagent('not-configured'), /未配置/);
});

test('agent definition validates platform configuration fields', () => {
  assert.throws(() => new AgentDefinition({ ...child, id: '../unsafe' }), /ID/);
  assert.throws(() => new AgentDefinition({ ...child, skillIds: [''] }), /skillIds/);
  assert.throws(() => new AgentDefinition({ ...child, toolNames: 'read_file' }), /toolNames/);
});
