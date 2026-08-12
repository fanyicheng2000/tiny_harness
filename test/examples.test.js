import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('demo 02 completes both parallel tool calls', () => {
  const result = spawnSync(process.execPath, ['examples/02-with-tools.js'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /执行失败/);
  assert.match(output, /write_file/);
  assert.match(output, /read_file/);
});
