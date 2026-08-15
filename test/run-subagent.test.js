import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RunSubagentTool } from '../src/tools/run-subagent.js';

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-subagent-test-'));
}

test('run_subagent delegates the task with a read-only registry', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  let receivedTask;
  let availableToolNames;
  const engine = {
    async runSub(task, registry) {
      receivedTask = task;
      availableToolNames = registry.getAvailableTools().map((tool) => tool.name);
      return '证据：src/auth.js:42 是认证入口。';
    },
  };

  const output = await new RunSubagentTool({ engine, workDir }).execute({
    task: '定位认证入口并给出证据',
  });

  assert.equal(receivedTask, '定位认证入口并给出证据');
  assert.deepEqual(availableToolNames, ['read_file']);
  assert.match(output, /src\/auth\.js:42/);
});

test('run_subagent rejects an empty or oversized task before delegation', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const engine = {
    async runSub() {
      throw new Error('should not be called');
    },
  };
  const tool = new RunSubagentTool({ engine, workDir });

  await assert.rejects(tool.execute({ task: '   ' }), /非空字符串/);
  await assert.rejects(tool.execute({ task: 'x'.repeat(4001) }), /不能超过 4000/);
});

test('run_subagent truncates an oversized worker report before it reaches the parent context', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const tool = new RunSubagentTool({
    engine: { async runSub() { return 'x'.repeat(8001); } },
    workDir,
  });

  const output = await tool.execute({ task: '收集证据' });
  assert.match(output, /已截断/);
  assert.ok(output.length < 8100);
});
