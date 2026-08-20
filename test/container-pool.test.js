import test from 'node:test';
import assert from 'node:assert/strict';

import { ContainerPool } from '../src/execution/container-pool.js';

function fakeRuntime() {
  let nextId = 1;
  return {
    created: [], destroyed: [], resets: [],
    async create() { const container = { id: `c${nextId++}` }; this.created.push(container.id); return container; },
    async reset(container) { this.resets.push(container.id); },
    async destroy(container) { this.destroyed.push(container.id); },
  };
}

test('container pool reuses a reset healthy container', async () => {
  const runtime = fakeRuntime();
  const pool = new ContainerPool({ runtime, image: 'alpine', size: 1 });
  const first = await pool.acquire();
  await pool.release(first);
  const second = await pool.acquire();
  assert.equal(second.id, first.id);
  assert.deepEqual(runtime.resets, ['c1']);
  assert.equal(pool.getSnapshot().reused, 1);
});

test('container pool destroys unhealthy container and replaces it for a waiter', async () => {
  const runtime = fakeRuntime();
  const pool = new ContainerPool({ runtime, image: 'alpine', size: 1 });
  const first = await pool.acquire();
  const waiting = pool.acquire();
  await pool.release(first, { healthy: false });
  const replacement = await waiting;
  assert.equal(replacement.id, 'c2');
  assert.deepEqual(runtime.destroyed, ['c1']);
});
