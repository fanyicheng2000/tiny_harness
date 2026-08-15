import test from 'node:test';
import assert from 'node:assert/strict';

import { ReminderInjector } from '../src/engine/reminder.js';

function call(name, arguments_) {
  return { id: `${name}-id`, name, arguments: arguments_ };
}

function result(isError) {
  return { isError };
}

test('ReminderInjector triggers independently for repeated failures of each tool fingerprint', () => {
  const injector = new ReminderInjector();
  const readMissing = call('read_file', { path: 'missing.js' });
  const failingBash = call('bash', { command: 'npm test -- bad-suite' });

  for (let index = 0; index < 2; index++) {
    assert.equal(injector.checkAndInject(readMissing, result(true)), null);
    assert.equal(injector.checkAndInject(failingBash, result(true)), null);
  }

  const readReminder = injector.checkAndInject(readMissing, result(true));
  const bashReminder = injector.checkAndInject(failingBash, result(true));

  assert.match(readReminder.content, /read_file/);
  assert.match(bashReminder.content, /bash/);
});

test('success clears only its own fingerprint and preserves another tool failure count', () => {
  const injector = new ReminderInjector();
  const successfulRead = call('read_file', { path: 'ok.js' });
  const failingBash = call('bash', { command: 'npm test -- bad-suite' });

  assert.equal(injector.checkAndInject(failingBash, result(true)), null);
  assert.equal(injector.checkAndInject(failingBash, result(true)), null);

  // A different successful call must not clear failingBash's two accumulated failures.
  assert.equal(injector.checkAndInject(successfulRead, result(false)), null);

  const reminder = injector.checkAndInject(failingBash, result(true));
  assert.match(reminder.content, /连续 3 次/);
});

test('ReminderInjector treats reordered object keys as the same tool-call fingerprint', () => {
  const injector = new ReminderInjector();

  // 两个对象字段插入顺序不同，但语义相同；第三次失败应触发同一个指纹的提醒。
  assert.equal(
    injector.checkAndInject(call('read_file', { path: 'same.js', offset: 1 }), result(true)),
    null
  );
  assert.equal(
    injector.checkAndInject(call('read_file', { offset: 1, path: 'same.js' }), result(true)),
    null
  );

  const reminder = injector.checkAndInject(
    call('read_file', { path: 'same.js', offset: 1 }),
    result(true)
  );
  assert.match(reminder.content, /连续 3 次/);
});

test('a successful call resets its own repeated-failure counter', () => {
  const injector = new ReminderInjector();
  const target = call('read_file', { path: 'eventually-exists.js' });

  assert.equal(injector.checkAndInject(target, result(true)), null);
  assert.equal(injector.checkAndInject(target, result(true)), null);
  assert.equal(injector.checkAndInject(target, result(false)), null);

  // This is only the first failure after success, not the third historical failure.
  assert.equal(injector.checkAndInject(target, result(true)), null);
});
