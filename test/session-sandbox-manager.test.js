import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionSandboxManager } from '../src/execution/session-sandbox-manager.js';

function createManager({ idleTtlMs = 60_000 } = {}) {
  let nextId = 1;
  const runtime = {
    created: [],
    destroyed: [],
    async create(request) { const sandbox = { id: `sandbox-${nextId++}` }; this.created.push({ ...request, id: sandbox.id }); return sandbox; },
    async destroy(sandbox, reason) { this.destroyed.push({ id: sandbox.id, reason }); },
  };
  const imageManager = { calls: [], async ensureImage(image) { this.calls.push(image); } };
  return { runtime, imageManager, manager: new SessionSandboxManager({ runtime, imageManager, image: 'alpine:3.20', idleTtlMs }) };
}

test('SessionSandboxManager reuses one sandbox per session and isolates different sessions', async () => {
  const { manager, runtime, imageManager } = createManager();
  const first = await manager.acquire({ sessionId: 'session-a', workDir: '/tmp/a' });
  const second = await manager.acquire({ sessionId: 'session-a', workDir: '/tmp/a' });
  const other = await manager.acquire({ sessionId: 'session-b', workDir: '/tmp/b' });

  assert.equal(first.id, second.id);
  assert.notEqual(first.id, other.id);
  assert.equal(runtime.created.length, 2);
  assert.deepEqual(imageManager.calls, ['alpine:3.20', 'alpine:3.20']);
  await manager.shutdown();
});

test('SessionSandboxManager creates a session sandbox only once under concurrent acquisition', async () => {
  let resolveCreate;
  const runtime = {
    createCalls: 0,
    async create() { this.createCalls++; await new Promise((resolve) => { resolveCreate = resolve; }); return { id: 'sandbox-1' }; },
    async destroy() {},
  };
  const manager = new SessionSandboxManager({ runtime, imageManager: { async ensureImage() {} }, image: 'alpine:3.20' });
  const first = manager.acquire({ sessionId: 'session-a', workDir: '/tmp/a' });
  const second = manager.acquire({ sessionId: 'session-a', workDir: '/tmp/a' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.createCalls, 1);
  resolveCreate();
  assert.equal((await first).id, (await second).id);
  await manager.shutdown();
});

test('SessionSandboxManager serializes commands in one session', async () => {
  const { manager } = createManager();
  const order = [];
  let finishFirst;
  const first = manager.execute({
    sessionId: 'session-a', workDir: '/tmp/a',
    run: async () => { order.push('first-start'); await new Promise((resolve) => { finishFirst = resolve; }); order.push('first-end'); },
  });
  const second = manager.execute({ sessionId: 'session-a', workDir: '/tmp/a', run: async () => { order.push('second'); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  await manager.shutdown();
});

test('SessionSandboxManager releases a sandbox after idle TTL', async () => {
  const { manager, runtime } = createManager({ idleTtlMs: 10 });
  await manager.acquire({ sessionId: 'session-a', workDir: '/tmp/a' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(runtime.destroyed, [{ id: 'sandbox-1', reason: 'idle-timeout' }]);
  assert.equal(manager.getSnapshot().active.length, 0);
});
