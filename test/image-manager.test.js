import test from 'node:test';
import assert from 'node:assert/strict';

import { ImageManager } from '../src/execution/image-manager.js';

test('ImageManager uses Docker local image cache after the first readiness check', async () => {
  const runtime = {
    existsCalls: 0,
    pullCalls: 0,
    async exists() { this.existsCalls++; return true; },
    async pull() { this.pullCalls++; },
  };
  const manager = new ImageManager({ runtime });

  assert.deepEqual(await manager.ensureImage('alpine:3.20'), { image: 'alpine:3.20', source: 'docker-local-cache' });
  assert.deepEqual(await manager.ensureImage('alpine:3.20'), { image: 'alpine:3.20', source: 'memory-cache' });
  assert.equal(runtime.existsCalls, 1);
  assert.equal(runtime.pullCalls, 0);
});

test('ImageManager merges concurrent pulls for the same image', async () => {
  let resolvePull;
  const runtime = {
    existsCalls: 0,
    pullCalls: 0,
    async exists() { this.existsCalls++; return false; },
    async pull() {
      this.pullCalls++;
      await new Promise((resolve) => { resolvePull = resolve; });
    },
  };
  const manager = new ImageManager({ runtime });
  const first = manager.ensureImage('node:22-alpine');
  const second = manager.ensureImage('node:22-alpine');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.pullCalls, 1);
  resolvePull();

  assert.deepEqual(await Promise.all([first, second]), [
    { image: 'node:22-alpine', source: 'pulled' },
    { image: 'node:22-alpine', source: 'pulled' },
  ]);
  assert.equal(manager.getSnapshot().metrics.joinedLoads, 1);
});

test('ImageManager preloads every requested image', async () => {
  const pulled = [];
  const manager = new ImageManager({ runtime: { async exists() { return false; }, async pull(image) { pulled.push(image); } } });
  await manager.preload(['alpine:3.20', 'node:22-alpine']);
  assert.deepEqual(pulled.sort(), ['alpine:3.20', 'node:22-alpine']);
});
