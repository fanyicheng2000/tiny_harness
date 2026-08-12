import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveWorkspacePath } from '../src/tools/path-utils.js';
import { ReadFileTool } from '../src/tools/read-file.js';
import { WriteFileTool } from '../src/tools/write-file.js';
import { EditFileTool } from '../src/tools/edit-file.js';

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-path-test-'));
  const workDir = path.join(base, 'work');
  fs.mkdirSync(workDir);
  return { base, workDir };
}

test('resolveWorkspacePath accepts a path inside the workspace', () => {
  assert.equal(
    resolveWorkspacePath('/tmp/work', 'src/a.js'),
    path.resolve('/tmp/work/src/a.js')
  );
});

test('resolveWorkspacePath rejects traversal and absolute paths outside', () => {
  assert.throws(() => resolveWorkspacePath('/tmp/work', '../secret'), /工作区外/);
  assert.throws(() => resolveWorkspacePath('/tmp/work', '/etc/hosts'), /工作区外/);
});

test('file tools reject traversal outside the workspace', async (t) => {
  const { base, workDir } = makeFixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  await assert.rejects(new ReadFileTool(workDir).execute({ path: '../outside.txt' }), /工作区外/);
  await assert.rejects(
    new WriteFileTool(workDir).execute({ path: '../outside.txt', content: 'nope' }),
    /工作区外/
  );
  await assert.rejects(
    new EditFileTool(workDir).execute({ path: '../outside.txt', old_text: 'a', new_text: 'b' }),
    /工作区外/
  );
});

test('read_file rejects a symlink that resolves outside the workspace', async (t) => {
  const { base, workDir } = makeFixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(workDir, 'link.txt'));

  await assert.rejects(new ReadFileTool(workDir).execute({ path: 'link.txt' }), /符号链接.*工作区外/);
});
