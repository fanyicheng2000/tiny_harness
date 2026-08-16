import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentRegistry } from '../src/agents/agent-registry.js';
import { RunSubagentTool } from '../src/tools/run-subagent.js';

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-governance-test-'));
}

function makeAgentRegistry() {
  return new AgentRegistry({
    id: 'root', name: '主控', description: '', systemPrompt: '主提示词', skillIds: [], toolNames: ['run_subagent'],
    multiAgents: [{ id: 'worker', name: '工作子 Agent', description: '', systemPrompt: '子提示词', skillIds: [], toolNames: ['read_file'] }],
  });
}

test('run_subagent rejects concurrent execution on the same thread_id', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  let resolveFirst;
  const firstCall = new Promise((resolve) => { resolveFirst = resolve; });
  const engine = { async runSub() { await firstCall; return '完成'; } };
  const tool = new RunSubagentTool({ engine, workDir, agentRegistry: makeAgentRegistry() });
  const firstExec = tool.execute({ agent_id: 'worker', task: '第一次', thread_id: 't1' });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(tool.execute({ agent_id: 'worker', task: '第二次', thread_id: 't1' }), /正在执行中/);
  resolveFirst();
  await firstExec;
});

test('run_subagent allows concurrent execution on different thread_ids', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const engine = { async runSub(_task, _reg, _reporter, opts) { return `来自 ${opts.threadId} 的报告`; } };
  const tool = new RunSubagentTool({ engine, workDir, agentRegistry: makeAgentRegistry() });
  const [r1, r2] = await Promise.all([
    tool.execute({ agent_id: 'worker', task: 'A', thread_id: 't-a' }),
    tool.execute({ agent_id: 'worker', task: 'B', thread_id: 't-b' }),
  ]);
  assert.match(r1, /t-a/);
  assert.match(r2, /t-b/);
});

test('delegation definition describes root configured child agents', () => {
  const tool = new RunSubagentTool({ engine: {}, workDir: '/tmp', agentRegistry: makeAgentRegistry() });
  assert.match(tool.definition().description, /worker/);
});
