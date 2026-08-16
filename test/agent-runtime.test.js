import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentRegistry } from '../src/agents/agent-registry.js';
import { buildAgentRegistry } from '../src/agents/runtime.js';

function makeWorkDir() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-runtime-test-'));
  fs.mkdirSync(path.join(workDir, '.tiny-harness', 'skills', 'allowed'), { recursive: true });
  fs.mkdirSync(path.join(workDir, '.tiny-harness', 'skills', 'hidden'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.tiny-harness', 'skills', 'allowed', 'SKILL.md'), '---\nname: allowed-skill\ndescription: allowed\n---\n允许内容');
  fs.writeFileSync(path.join(workDir, '.tiny-harness', 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden-skill\ndescription: hidden\n---\n隐藏内容');
  return workDir;
}

function makeRegistry() {
  return new AgentRegistry({
    id: 'root', name: '主 Agent', description: '主控', systemPrompt: '主提示词',
    skillIds: ['allowed-skill'], toolNames: ['read_file', 'read_skill', 'run_subagent'],
    multiAgents: [{
      id: 'writer', name: '写代码子 Agent', description: '实现', systemPrompt: '子提示词',
      skillIds: ['allowed-skill'], toolNames: ['read_file', 'read_skill', 'write_file', 'run_subagent'],
    }],
  });
}

test('root registry receives only configured tools plus delegation', (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const agents = makeRegistry();
  const registry = buildAgentRegistry({ agent: agents.getRootAgent(), workDir, engine: {}, reporter: {}, agentRegistry: agents });
  assert.deepEqual(registry.getAvailableTools().map((tool) => tool.name).sort(), ['read_file', 'read_skill', 'run_subagent']);
});

test('child runtime cannot receive run_subagent even if its configuration contains it', (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const agents = makeRegistry();
  const registry = buildAgentRegistry({ agent: agents.getSubagent('writer'), workDir, engine: {}, reporter: {}, agentRegistry: agents });
  assert.deepEqual(registry.getAvailableTools().map((tool) => tool.name).sort(), ['read_file', 'read_skill', 'write_file']);
});

test('read_skill only allows platform Skill IDs granted to the current agent', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const agents = makeRegistry();
  const registry = buildAgentRegistry({ agent: agents.getRootAgent(), workDir, engine: {}, reporter: {}, agentRegistry: agents });
  const readSkill = registry.tools.get('read_skill');

  const allowed = await readSkill.execute({ skill_name: 'allowed-skill' });
  assert.match(allowed, /允许内容/);
  await assert.rejects(readSkill.execute({ skill_name: 'hidden-skill' }), /未授权/);
});
