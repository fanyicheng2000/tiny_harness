import test from 'node:test';
import assert from 'node:assert/strict';

import { ExecutionScheduler, ExecutionStatus } from '../src/execution/scheduler.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('scheduler enforces global concurrency and records queue wait metrics', async () => {
  const scheduler = new ExecutionScheduler({ maxConcurrent: 1, maxPerSession: 1, maxPerAgent: 1, maxQueueWaitMs: 500 });
  let running = 0;
  let peak = 0;
  const run = async () => {
    running++;
    peak = Math.max(peak, running);
    await delay(30);
    running--;
    return 'ok';
  };

  const first = scheduler.submit({ sessionId: 's1', agentId: 'a1', run });
  const second = scheduler.submit({ sessionId: 's2', agentId: 'a2', run });
  assert.equal(await first.promise, 'ok');
  assert.equal(await second.promise, 'ok');
  const snapshot = scheduler.getSnapshot();

  assert.equal(peak, 1);
  assert.equal(snapshot.metrics.succeeded, 2);
  assert.ok(snapshot.metrics.totalQueueWaitMs >= 20);
});

test('scheduler allows different sessions to run while enforcing per-session quota', async () => {
  const scheduler = new ExecutionScheduler({ maxConcurrent: 2, maxPerSession: 1, maxPerAgent: 2, maxQueueWaitMs: 500 });
  const started = [];
  const run = (name) => async () => {
    started.push(name);
    await delay(40);
    return name;
  };

  const s1First = scheduler.submit({ sessionId: 's1', agentId: 'a1', run: run('s1-first') });
  const s1Second = scheduler.submit({ sessionId: 's1', agentId: 'a2', run: run('s1-second') });
  const s2 = scheduler.submit({ sessionId: 's2', agentId: 'a3', run: run('s2') });
  await delay(10);

  assert.deepEqual(new Set(started), new Set(['s1-first', 's2']));
  await Promise.all([s1First.promise, s1Second.promise, s2.promise]);
});

test('scheduler rejects jobs that wait beyond queue timeout', async () => {
  const scheduler = new ExecutionScheduler({ maxConcurrent: 1, maxPerSession: 1, maxPerAgent: 1, maxQueueWaitMs: 20 });
  const first = scheduler.submit({ sessionId: 's1', agentId: 'a1', run: async () => delay(80) });
  const queued = scheduler.submit({ sessionId: 's2', agentId: 'a2', run: async () => 'never' });

  await assert.rejects(queued.promise, /排队超过 20ms/);
  await first.promise;
  assert.equal(queued.status, ExecutionStatus.QUEUE_TIMEOUT);
  assert.equal(scheduler.getSnapshot().metrics.queueTimedOut, 1);
});

test('scheduler cancels a running job through AbortSignal', async () => {
  const scheduler = new ExecutionScheduler({ maxConcurrent: 1, maxPerSession: 1, maxPerAgent: 1, maxQueueWaitMs: 500 });
  const job = scheduler.submit({
    run: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(resolve, 100, 'too late');
    }),
  });
  await delay(5);
  assert.equal(scheduler.cancel(job.id, 'manual cancellation'), true);
  await assert.rejects(job.promise, /manual cancellation/);
  assert.equal(job.status, ExecutionStatus.CANCELLED);
});
