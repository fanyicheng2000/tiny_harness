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

test('run_subagent routes to a whitelisted specialist with its own prompt and turn limit', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  let received;
  const engine = {
    async runSub(task, registry, reporter, options) {
      received = {
        task,
        tools: registry.getAvailableTools().map((tool) => tool.name),
        reporter,
        options,
      };
      return '证据：src/auth.js:42 是认证入口。';
    },
  };

  const output = await new RunSubagentTool({ engine, workDir }).execute({
    agent_id: 'reviewer',
    task: '审查认证入口的错误处理并给出证据',
  });

  assert.equal(received.task, '审查认证入口的错误处理并给出证据');
  assert.deepEqual(received.tools, ['read_file']);
  assert.equal(received.options.maxTurns, 6);
  assert.match(received.options.systemPrompt, /Reviewer Agent/);
  assert.match(output, /src\/auth\.js:42/);
});

test('run_subagent exposes the coordinator whitelist in its tool definition', () => {
  const tool = new RunSubagentTool({ engine: {}, workDir: '/tmp' });
  const definition = tool.definition();
  assert.match(definition.description, /explorer/);
  assert.match(definition.description, /reviewer/);
  assert.match(definition.description, /test_planner/);
  assert.deepEqual(definition.inputSchema.required, ['agent_id', 'task']);
});

test('run_subagent rejects an agent outside the coordinator whitelist', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const tool = new RunSubagentTool({ engine: {}, workDir });
  await assert.rejects(
    tool.execute({ agent_id: 'arbitrary-agent', task: '做任何事' }),
    /Coordinator 无权委派/
  );
});

test('run_subagent rejects an empty or oversized task before delegation', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const engine = { async runSub() { throw new Error('should not be called'); } };
  const tool = new RunSubagentTool({ engine, workDir });
  await assert.rejects(tool.execute({ agent_id: 'explorer', task: '   ' }), /非空字符串/);
  await assert.rejects(tool.execute({ agent_id: 'explorer', task: 'x'.repeat(4001) }), /不能超过 4000/);
});

test('run_subagent truncates an oversized worker report before it reaches the parent context', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const tool = new RunSubagentTool({
    engine: { async runSub() { return 'x'.repeat(8001); } },
    workDir,
  });
  const output = await tool.execute({ agent_id: 'explorer', task: '收集证据' });
  assert.match(output, /已截断/);
  assert.ok(output.length < 8100);
});

test('AgentRegistry rejects duplicate agent IDs', () => {
  assert.throws(
    () => new AgentRegistry([
      { id: 'same', description: '', systemPrompt: '', toolNames: [] },
      { id: 'same', description: '', systemPrompt: '', toolNames: [] },
    ]),
    /重复/
  );
});
