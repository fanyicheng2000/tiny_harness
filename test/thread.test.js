import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Thread } from '../src/context/thread.js';
import { Message } from '../src/schema/message.js';

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-thread-test-'));
}

test('Thread persists and reloads history across processes', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const thread = new Thread('thread-1', workDir);
  thread.append(
    new Message({ role: 'system', content: '你是子 Agent' }),
    new Message({ role: 'user', content: '查找入口' }),
    new Message({ role: 'assistant', content: '找到了 src/index.js:10' }),
  );
  thread.save();

  const reloaded = Thread.load('thread-1', workDir);
  assert.equal(reloaded.history.length, 3);
  assert.equal(reloaded.history[2].content, '找到了 src/index.js:10');
});

test('Thread appends new messages without rewriting old ones', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const thread = new Thread('thread-2', workDir);
  thread.append(new Message({ role: 'user', content: '第一轮' }));
  thread.save();

  const thread2 = Thread.load('thread-2', workDir);
  thread2.append(new Message({ role: 'assistant', content: '回复' }));
  thread2.save();

  const thread3 = Thread.load('thread-2', workDir);
  assert.equal(thread3.history.length, 2);
  assert.equal(thread3.history[1].content, '回复');
});

test('Thread.load returns empty history for a non-existent thread', async (t) => {
  const workDir = makeWorkDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const thread = Thread.load('never-existed', workDir);
  assert.equal(thread.history.length, 0);
});
