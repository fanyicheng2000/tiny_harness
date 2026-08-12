import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { Message, Role } from '../src/schema/message.js';
import { Session, SessionManager } from '../src/context/session.js';

function makeWorkDir(t) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-session-test-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  return workDir;
}

test('Session save and load round-trip messages and usage (JSONL)', (t) => {
  const workDir = makeWorkDir(t);
  const session = new Session('task-1', workDir);
  session.append(new Message({ role: Role.USER, content: 'hello' }));
  session.recordUsage(10, 5, { currency: 'USD', amount: 0.1 });
  session.save();

  const restored = Session.load('task-1', workDir);
  assert.equal(restored.history[0] instanceof Message, true);
  assert.equal(restored.history[0].content, 'hello');
  assert.equal(restored.totalPromptTokens, 10);
  assert.equal(restored.totalCompletionTokens, 5);
  assert.deepEqual(restored.estimatedCosts, { USD: 0.1 });
  assert.equal(restored.createdAt instanceof Date, true);
  assert.equal(restored.updatedAt instanceof Date, true);
});

test('Session writes JSONL file (one message per line)', (t) => {
  const workDir = makeWorkDir(t);
  const session = new Session('jsonl-check', workDir);
  session.append(new Message({ role: Role.USER, content: 'first' }));
  session.append(new Message({ role: Role.ASSISTANT, content: 'second' }));
  session.save();

  const file = path.join(workDir, '.tiny-harness', 'sessions', 'jsonl-check.jsonl');
  assert.equal(fs.existsSync(file), true);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  // 1 行 meta + 2 行 message
  assert.equal(lines.length, 3);
  const meta = JSON.parse(lines[0]);
  assert.equal(meta.__type, 'meta');
  assert.equal(meta.count, 2);
  const msg1 = JSON.parse(lines[1]);
  assert.equal(msg1.__type, 'message');
  assert.equal(msg1.content, 'first');
});

test('Session save is incremental (append only new messages)', (t) => {
  const workDir = makeWorkDir(t);
  const session = new Session('incremental', workDir);
  session.append(new Message({ role: Role.USER, content: 'm1' }));
  session.save();

  const file = path.join(workDir, '.tiny-harness', 'sessions', 'incremental.jsonl');
  const linesAfterFirst = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  // 1 meta + 1 message
  assert.equal(linesAfterFirst, 2);

  // 追加两条新消息
  session.append(new Message({ role: Role.ASSISTANT, content: 'm2' }));
  session.append(new Message({ role: Role.USER, content: 'm3' }));
  session.save();

  const linesAfterSecond = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  // 1 meta + 1 message + 2 message + 1 new meta = 5
  assert.equal(linesAfterSecond, 5);

  // 重读应得 3 条消息
  const restored = Session.load('incremental', workDir);
  assert.equal(restored.history.length, 3);
  assert.equal(restored.history[2].content, 'm3');
});

test('Session load skips corrupt JSONL lines instead of failing', (t) => {
  const workDir = makeWorkDir(t);
  const sessionsDir = path.join(workDir, '.tiny-harness', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const file = path.join(sessionsDir, 'broken.jsonl');
  // meta 行 + 一条有效消息 + 一条坏行 + 又一条有效消息
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ __type: 'meta', id: 'broken', count: 2, totalPromptTokens: 0, totalCompletionTokens: 0 }),
      JSON.stringify({ __type: 'message', role: 'user', content: 'good-1' }),
      '{this is not valid json',
      JSON.stringify({ __type: 'message', role: 'assistant', content: 'good-2' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const restored = Session.load('broken', workDir);
  // 坏行被跳过，两条好行被加载
  assert.equal(restored.history.length, 2);
  assert.equal(restored.history[0].content, 'good-1');
  assert.equal(restored.history[1].content, 'good-2');
});

test('Session rejects IDs that could escape the sessions directory', (t) => {
  const workDir = makeWorkDir(t);
  assert.throws(() => new Session('../outside', workDir).save(), /会话 ID/);
});

test('SessionManager loads an existing session on first access', (t) => {
  const workDir = makeWorkDir(t);
  const original = new Session('saved-task', workDir);
  original.append(new Message({ role: Role.USER, content: 'persisted' }));
  original.save();

  const manager = new SessionManager();
  const restored = manager.getOrCreate('saved-task', workDir);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.history[0].content, 'persisted');
});

test('Session persists across separate Node.js processes', (t) => {
  const workDir = makeWorkDir(t);
  const moduleUrl = pathToFileURL(path.resolve('src/context/session.js')).href;
  const saveScript = `
    import { Session } from ${JSON.stringify(moduleUrl)};
    const session = new Session('cross-process', ${JSON.stringify(workDir)});
    session.append({ role: 'user', content: 'from process one' });
    session.save();
  `;
  const loadScript = `
    import { Session } from ${JSON.stringify(moduleUrl)};
    const session = Session.load('cross-process', ${JSON.stringify(workDir)});
    process.stdout.write(session.history[0].content);
  `;

  const saved = spawnSync(process.execPath, ['--input-type=module', '--eval', saveScript], {
    encoding: 'utf8',
  });
  assert.equal(saved.status, 0, saved.stderr);

  const loaded = spawnSync(process.execPath, ['--input-type=module', '--eval', loadScript], {
    encoding: 'utf8',
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, 'from process one');
});
