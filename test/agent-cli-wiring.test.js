import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentRegistry } from '../src/agents/agent-registry.js';
import { defaultAgentConfig } from '../src/agents/default-config.js';
import { buildAgentRegistry, buildAgentSystemMessage } from '../src/agents/runtime.js';
import { AgentEngine } from '../src/engine/loop.js';
import { MockProvider } from '../src/provider/mock.js';

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-cli-agent-test-'));
}

test('default CLI config creates a root runtime with one configurable child and root identity prompt', (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const agents = new AgentRegistry(defaultAgentConfig);
  const root = agents.getRootAgent();
  const engine = new AgentEngine(new MockProvider(), null, false, false,
    (dir, planMode) => buildAgentSystemMessage({ agent: root, workDir: dir, planMode })
  );
  const registry = buildAgentRegistry({ agent: root, workDir, engine, reporter: null, agentRegistry: agents });
  engine.registry = registry;

  assert.equal(root.name, 'Tiny Harness 主 Agent');
  assert.equal(agents.listSubagents().length, 1);
  assert.ok(registry.tools.has('run_subagent'));

  const message = engine.systemMessageFactory(workDir, false);
  assert.match(message.content, /Tiny Harness 主 Agent/);
  assert.match(message.content, /主 Agent/);
});
