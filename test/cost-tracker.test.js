import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

import { Message, Role, Usage } from '../src/schema/message.js';
import { Session } from '../src/context/session.js';
import { CostTracker, PRICE_SNAPSHOTS } from '../src/observability/tracker.js';

class UsageProvider {
  async generate() {
    return new Message({
      role: Role.ASSISTANT,
      content: 'ok',
      usage: new Usage(1_000_000, 0),
    });
  }
}

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

test('unknown models track tokens without claiming zero monetary cost', async (t) => {
  const workDir = fs.mkdtempSync(`${os.tmpdir()}/tiny-harness-cost-test-`);
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const session = new Session('unknown-price', workDir);
  const tracker = new CostTracker(new UsageProvider(), 'unknown-model', session);

  const logs = await captureLogs(() => tracker.generate([], []));
  assert.equal(session.totalPromptTokens, 1_000_000);
  assert.deepEqual(session.estimatedCosts, {});
  assert.match(logs, /估算费用: 未配置/);
  assert.doesNotMatch(logs, /[¥$]0\.000000/);
});

test('known prices include currency and verification date', async (t) => {
  const workDir = fs.mkdtempSync(`${os.tmpdir()}/tiny-harness-cost-test-`);
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const session = new Session('known-price', workDir);
  const tracker = new CostTracker(new UsageProvider(), 'gpt-5.6-sol', session);

  const logs = await captureLogs(() => tracker.generate([], []));
  assert.equal(PRICE_SNAPSHOTS['gpt-5.6-sol'].currency, 'USD');
  assert.equal(PRICE_SNAPSHOTS['gpt-5.6-sol'].verifiedAt, '2026-07-20');
  // 1M input × $1.25 / 1M + 0 output × $10 / 1M = $1.25
  assert.equal(session.estimatedCosts.USD, 1.25);
  assert.match(logs, /USD 1\.250000.*2026-07-20/);
});

test('price snapshots only include supported protocol examples and mock', () => {
  assert.deepEqual(
    Object.keys(PRICE_SNAPSHOTS).sort(),
    [
      'claude-fable-5',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'gpt-5.4-mini',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'mock',
    ],
  );
});

test('unlike currencies remain separate totals', () => {
  const session = new Session('mixed', os.tmpdir());
  session.recordUsage(1, 1, { currency: 'USD', amount: 1 });
  session.recordUsage(1, 1, { currency: 'CNY', amount: 2 });
  assert.deepEqual(session.estimatedCosts, { USD: 1, CNY: 2 });
});
