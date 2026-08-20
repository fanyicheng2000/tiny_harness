import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DockerBackend, LocalProcessBackend, createExecutionBackend } from '../src/execution/backend.js';

test('DockerBackend builds a resource-limited and network-isolated command', () => {
  const backend = new DockerBackend({
    image: 'node:22-alpine',
    memory: '256m',
    cpus: '0.5',
    pidsLimit: 64,
  });
  const args = backend.buildArgs({
    command: 'node --version',
    workDir: '/tmp/project',
    containerName: 'tiny-harness-test',
  });

  assert.deepEqual(args, [
    'run', '--rm', '--name', 'tiny-harness-test',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '64',
    '--memory', '256m',
    '--cpus', '0.5',
    '--workdir', '/workspace',
    '--volume', '/tmp/project:/workspace:rw',
    'node:22-alpine', 'sh', '-c', 'node --version',
  ]);
});

test('execution backend factory selects local or docker backend', () => {
  assert.equal(createExecutionBackend({ kind: 'local' }).name, 'local');
  assert.equal(createExecutionBackend({ kind: 'docker' }).name, 'docker');
  assert.throws(() => createExecutionBackend({ kind: 'microvm' }), /不支持的执行后端/);
});

test('LocalProcessBackend preserves the original shell execution behavior', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-backend-test-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const backend = new LocalProcessBackend({ timeoutMs: 500 });
  const result = await backend.execute({ command: 'printf backend-ok', workDir, signal: new AbortController().signal });
  assert.equal(result, 'backend-ok');
});

test('DockerBackend rejects invalid resource configuration', () => {
  assert.throws(() => new DockerBackend({ pidsLimit: 0 }), /pidsLimit 必须是正整数/);
  assert.throws(() => new DockerBackend({ image: '' }), /Docker image 必须是非空字符串/);
});
