import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolCall } from '../src/schema/message.js';
import { Registry } from '../src/tools/registry.js';
import { BashTool } from '../src/tools/bash.js';

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
