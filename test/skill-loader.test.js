import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PromptComposer } from '../src/context/composer.js';
import { SkillLoader } from '../src/context/skill.js';
import { ReadSkillTool } from '../src/tools/read-skill.js';

function makeFixture() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiny-harness-skill-test-'));
  const skillDir = path.join(workDir, '.tiny-harness', 'skills', 'git-review');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: git-review\ndescription: 当用户要求审查 Git 改动时使用\n---\n先执行 git diff。\n再检查测试。\n'
  );
  return { workDir };
}

test('SkillLoader catalog contains metadata but excludes skill body', (t) => {
  const { workDir } = makeFixture();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const catalog = new SkillLoader(workDir).buildCatalog();
  assert.match(catalog, /`git-review`：当用户要求审查 Git 改动时使用/);
  assert.doesNotMatch(catalog, /先执行 git diff/);
  assert.doesNotMatch(catalog, /再检查测试/);
});

test('read_skill loads exactly one skill full body on demand', async (t) => {
  const { workDir } = makeFixture();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const output = await new ReadSkillTool(workDir).execute({ skill_name: 'git-review' });
  assert.match(output, /技能名称: git-review/);
  assert.match(output, /完整执行指南:/);
  assert.match(output, /先执行 git diff/);
  assert.match(output, /再检查测试/);
});

test('read_skill reads skill body by requested line page and reports the next offset', async (t) => {
  const { workDir } = makeFixture();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const skillPath = path.join(workDir, '.tiny-harness', 'skills', 'git-review', 'SKILL.md');
  fs.writeFileSync(
    skillPath,
    '---\nname: git-review\ndescription: 当用户要求审查 Git 改动时使用\n---\nfirst\nsecond\nthird\nfourth\nfifth\n'
  );

  const output = await new ReadSkillTool(workDir).execute({
    skill_name: 'git-review',
    offset: 2,
    limit: 2,
  });
  assert.match(output, /行范围: 2-3 \/ 5/);
  assert.match(output, /还有更多: 是/);
  assert.match(output, /下一页 offset: 4/);
  assert.match(output, /2 \| second/);
  assert.match(output, /3 \| third/);
  assert.doesNotMatch(output, /1 \| first/);
  assert.doesNotMatch(output, /4 \| fourth/);
});

test('read_skill rejects a skill name not present in the catalog', async (t) => {
  const { workDir } = makeFixture();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  await assert.rejects(
    new ReadSkillTool(workDir).execute({ skill_name: '../secret' }),
    /未找到技能/
  );
});

test('PromptComposer injects catalog rather than full skill content', (t) => {
  const { workDir } = makeFixture();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const systemMessage = new PromptComposer(workDir).build();
  assert.match(systemMessage.content, /可用专业技能（按需加载）/);
  assert.match(systemMessage.content, /`git-review`/);
  assert.match(systemMessage.content, /read_skill/);
  assert.doesNotMatch(systemMessage.content, /先执行 git diff/);
});
