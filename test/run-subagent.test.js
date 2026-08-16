import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentRegistry } from '../src/agents/agent-registry.js';
import { RunSubagentTool } from '../src/tools/run-subagent.js';

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-subagent-test-'));
}

function makeAgentRegistry() {
  return new AgentRegistry({
    id: 'main', name: '主 Agent', description: '负责委派', systemPrompt: '主提示词',
    skillIds: [], toolNames: ['run_subagent'],
    multiAgents: [{
      id: 'reviewer', name: '自定义审查助手', description: '审查代码', systemPrompt: '子提示词',
      skillIds: [], toolNames: ['read_file'], maxTurns: 6,
    }],
  });
}

test('run_subagent routes to a configured direct child with its own prompt and turn limit', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  let received;
  const engine = { async runSub(task, registry, reporter, options) {
    received = { task, tools: registry.getAvailableTools().map((tool) => tool.name), reporter, options };
    return '证据：src/auth.js:42 是认证入口。';
  } };

  const output = await new RunSubagentTool({ engine, workDir, agentRegistry: makeAgentRegistry() }).execute({
    agent_id: 'reviewer', task: '审查认证入口的错误处理并给出证据',
  });
  assert.equal(received.task, '审查认证入口的错误处理并给出证据');
  assert.deepEqual(received.tools, ['read_file']);
  assert.equal(received.options.maxTurns, 6);
  assert.match(received.options.systemPrompt, /自定义审查助手/);
  assert.match(output, /src\/auth\.js:42/);
});

test('run_subagent exposes only children configured by the root agent', () => {
  const tool = new RunSubagentTool({ engine: {}, workDir: '/tmp', agentRegistry: makeAgentRegistry() });
  const definition = tool.definition();
  assert.match(definition.description, /reviewer/);
  assert.match(definition.description, /自定义审查助手/);
  assert.deepEqual(definition.inputSchema.required, ['agent_id', 'task']);
});

test('run_subagent rejects an agent outside root multiAgents', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const tool = new RunSubagentTool({ engine: {}, workDir, agentRegistry: makeAgentRegistry() });
  await assert.rejects(tool.execute({ agent_id: 'arbitrary-agent', task: '做任何事' }), /未配置/);
});

test('run_subagent rejects an empty or oversized task before delegation', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const tool = new RunSubagentTool({ engine: { async runSub() { throw new Error('should not be called'); } }, workDir, agentRegistry: makeAgentRegistry() });
  await assert.rejects(tool.execute({ agent_id: 'reviewer', task: '   ' }), /非空字符串/);
  await assert.rejects(tool.execute({ agent_id: 'reviewer', task: 'x'.repeat(4001) }), /不能超过 4000/);
});

test('run_subagent truncates an oversized child report before it reaches root context', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const tool = new RunSubagentTool({ engine: { async runSub() { return 'x'.repeat(8001); } }, workDir, agentRegistry: makeAgentRegistry() });
  const output = await tool.execute({ agent_id: 'reviewer', task: '收集证据' });
  assert.match(output, /已截断/);
  assert.ok(output.length < 8100);
});
