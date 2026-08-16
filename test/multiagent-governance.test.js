import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RunSubagentTool } from '../src/tools/run-subagent.js';
import { AgentRegistry, defaultDefinitions } from '../src/agents/agent-registry.js';
import { Span } from '../src/observability/trace.js';
import { Message } from '../src/schema/message.js';

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-governance-test-'));
}

test('run_subagent rejects concurrent execution on the same thread_id', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  let resolveFirst;
  const firstCall = new Promise((resolve) => { resolveFirst = resolve; });

  const engine = {
    async runSub() {
      // 模拟长时间运行的子 Agent
      await firstCall;
      return '完成';
    },
  };

  const tool = new RunSubagentTool({ engine, workDir });
  const firstExec = tool.execute({ agent_id: 'explorer', task: '第一次', thread_id: 't1' });
  // 让第一次调用进入活跃状态
  await new Promise((r) => setImmediate(r));

  await assert.rejects(
    tool.execute({ agent_id: 'explorer', task: '第二次', thread_id: 't1' }),
    /正在执行中/
  );

  resolveFirst();
  await firstExec;
});

test('run_subagent allows concurrent execution on different thread_ids', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const engine = {
    async runSub(_task, _reg, _reporter, opts) {
      return `来自 ${opts.threadId} 的报告`;
    },
  };

  const tool = new RunSubagentTool({ engine, workDir });
  const [r1, r2] = await Promise.all([
    tool.execute({ agent_id: 'explorer', task: 'A', thread_id: 't-a' }),
    tool.execute({ agent_id: 'explorer', task: 'B', thread_id: 't-b' }),
  ]);

  assert.match(r1, /t-a/);
  assert.match(r2, /t-b/);
});

test('run_subagent tool definition describes available agents from registry', () => {
  const customRegistry = new AgentRegistry([
    { id: 'custom_agent', description: '自定义角色', systemPrompt: '', toolNames: ['read_file'], maxTurns: 3 },
  ]);
  const tool = new RunSubagentTool({ engine: {}, workDir: '/tmp', agentRegistry: customRegistry });
  const def = tool.definition();
  assert.match(def.description, /custom_agent/);
});
