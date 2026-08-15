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

test('read_file reads a requested 1-based line page and reports the next offset', async (t) => {
  const { base, workDir } = makeFixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.writeFileSync(path.join(workDir, 'pages.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  const output = await new ReadFileTool(workDir).execute({
    path: 'pages.txt',
    offset: 2,
    limit: 2,
  });

  assert.match(output, /行范围: 2-3 \/ 5/);
  assert.match(output, /还有更多: 是/);
  assert.match(output, /下一页 offset: 4/);
  assert.match(output, /2 \| two/);
  assert.match(output, /3 \| three/);
  assert.doesNotMatch(output, /1 \| one/);
  assert.doesNotMatch(output, /4 \| four/);
});

test('read_file applies the character budget at line boundaries and supports later pages', async (t) => {
  const { base, workDir } = makeFixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const lines = Array.from({ length: 4 }, (_, index) => `${index + 1}-${'x'.repeat(3000)}`);
  fs.writeFileSync(path.join(workDir, 'large.txt'), lines.join('\n'));
  const tool = new ReadFileTool(workDir);
  const firstPage = await tool.execute({ path: 'large.txt', offset: 1, limit: 4 });

  assert.match(firstPage, /提示: 本页因 8000 字符预算提前结束。/);
  assert.match(firstPage, /下一页 offset: 3/);
  assert.match(firstPage, /1 \| 1-/);
  assert.match(firstPage, /2 \| 2-/);
  assert.doesNotMatch(firstPage, /3 \| 3-/);

  const secondPage = await tool.execute({ path: 'large.txt', offset: 3, limit: 4 });
  assert.match(secondPage, /行范围: 3-4 \/ 4/);
  assert.match(secondPage, /3 \| 3-/);
  assert.match(secondPage, /4 \| 4-/);
  assert.match(secondPage, /还有更多: 否/);
});

test('read_file validates paging parameters and offsets beyond a non-empty file', async (t) => {
  const { base, workDir } = makeFixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.writeFileSync(path.join(workDir, 'small.txt'), 'line one');
  const tool = new ReadFileTool(workDir);

  await assert.rejects(tool.execute({ path: 'small.txt', offset: 0 }), /offset 必须/);
  await assert.rejects(tool.execute({ path: 'small.txt', limit: 301 }), /limit 必须/);
  await assert.rejects(tool.execute({ path: 'small.txt', offset: 2 }), /超出文件总行数/);
});
