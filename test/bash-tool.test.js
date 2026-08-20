import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolCall } from '../src/schema/message.js';
import { Registry } from '../src/tools/registry.js';
import { BashTool } from '../src/tools/bash.js';
import { ExecutionScheduler } from '../src/execution/scheduler.js';
import { LocalProcessBackend } from '../src/execution/backend.js';

function setup(t, options = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-bash-test-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const registry = new Registry();
  registry.register(new BashTool(workDir, options));
  return registry;
}

function call(command) {
  return new ToolCall({ id: 'call-1', name: 'bash', arguments: { command } });
}

test('zero exit is a successful ToolResult', async (t) => {
  const registry = setup(t);
  const result = await registry.execute(call('printf ok'));
  assert.equal(result.isError, false);
  assert.match(result.output, /ok/);
});

test('non-zero exit preserves stderr and becomes an error ToolResult', async (t) => {
  const registry = setup(t);
  const result = await registry.execute(call('printf boom >&2; exit 7'));
  assert.equal(result.isError, true);
  assert.match(result.output, /boom/);
  assert.match(result.output, /退出码: 7/);
});

test('timeout becomes an error ToolResult', async (t) => {
  const registry = setup(t, { timeoutMs: 40 });
  const result = await registry.execute(call('sleep 1'));
  assert.equal(result.isError, true);
  assert.match(result.output, /超过 40ms/);
});

test('bash execution enters the scheduler and exposes execution metrics', async (t) => {
  const scheduler = new ExecutionScheduler({ maxConcurrent: 1, maxPerSession: 1, maxPerAgent: 1, maxQueueWaitMs: 500 });
  const registry = setup(t, { scheduler });
  const result = await registry.execute(call('printf scheduled'));
  assert.equal(result.isError, false);
  assert.match(result.output, /scheduled/);
  assert.equal(scheduler.getSnapshot().metrics.succeeded, 1);
});

test('bash delegates command execution to the configured backend', async (t) => {
  const scheduler = new ExecutionScheduler({ maxConcurrent: 1, maxPerSession: 1, maxPerAgent: 1, maxQueueWaitMs: 500 });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-bash-backend-test-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const registry = new Registry();
  registry.register(new BashTool(workDir, { scheduler, backend: new LocalProcessBackend({ timeoutMs: 500 }) }));
  const result = await registry.execute(call('printf backend-delegated'));
  assert.equal(result.isError, false);
  assert.match(result.output, /backend-delegated/);
});
