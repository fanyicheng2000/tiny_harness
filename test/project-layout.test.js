import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('credential-safe project templates exist', () => {
  assert.equal(fs.existsSync('.gitignore'), true);
  assert.equal(fs.existsSync('.env.example'), true);

  const ignore = fs.readFileSync('.gitignore', 'utf8');
  assert.match(ignore, /(^|\n)\.env(\n|$)/);
  assert.match(ignore, /(^|\n)\.tiny-harness\/(\n|$)/);

  const example = fs.readFileSync('.env.example', 'utf8');
  assert.doesNotMatch(example, /sk-[A-Za-z0-9_-]{12,}/);
  assert.doesNotMatch(example, /(?:ZHIPU|DEEPSEEK|ANTHROPIC|TINY_CLAW)_/);
  assert.match(example, /^OPENAI_API_KEY=/m);
  assert.match(example, /^CLAUDE_API_KEY=/m);
});

test('CLI exposes only the two network protocols and mock', () => {
  const help = spawnSync(process.execPath, ['src/index.js', '--help'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /mock \| openai \| claude/);
  assert.doesNotMatch(help.stdout, /zhipu|deepseek|anthropic/i);

  const legacy = spawnSync(
    process.execPath,
    ['src/index.js', '--provider', 'deepseek', '--prompt', 'test'],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.notEqual(legacy.status, 0);
  assert.match(`${legacy.stdout}\n${legacy.stderr}`, /支持: mock \| openai \| claude/);
});

test('README and tutorial local Markdown links resolve', () => {
  for (const document of ['README.md', 'docs/TUTORIAL_NEW.md']) {
    const markdown = fs.readFileSync(document, 'utf8');
    const links = [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(?:https?:|mailto:|#)/.test(target));

    for (const target of links) {
      const withoutAnchor = target.split('#', 1)[0].split('?', 1)[0];
      const resolved = path.resolve(path.dirname(document), withoutAnchor);
      assert.equal(fs.existsSync(resolved), true, `${document}: missing ${target}`);
    }
  }
});
