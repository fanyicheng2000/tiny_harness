// ===========================================
// context/skill.js
// ===========================================
// Skill 加载器：管理 .tiny-harness/skills/**/SKILL.md
//
// 渐进式加载策略：
//   1. 启动时只扫描技能目录，向 System Prompt 注入 name + description 的「技能目录」；
//   2. 模型判断某个技能匹配当前任务后，调用 read_skill(skill_name)；
//   3. read_skill 才读取并返回该 SKILL.md 的完整执行指南。
//
// 这样不会把所有技能正文都塞进每次模型调用的上下文，减少 Token 消耗并避免无关指令干扰。
// ===========================================

import fs from 'node:fs';
import path from 'node:path';

export class Skill {
  constructor({ name = 'Unknown Skill', description = 'No description provided.', filePath, body = '' } = {}) {
    this.name = name;
    this.description = description;
    this.filePath = filePath;
    this.body = body;
  }
}

export class SkillLoader {
  constructor(workDir, allowedSkillIds = null) {
    this.workDir = workDir;
    this.allowedSkillIds = allowedSkillIds === null ? null : new Set(allowedSkillIds);
  }

  // 扫描技能目录并返回目录项。该方法只返回名称和触发条件，绝不把正文放入 System Prompt。
  // 读取文件仅用于解析 YAML frontmatter；调用方拿到的 Skill.body 始终为空。
  listSkills() {
    const skillBaseDir = this._skillBaseDir();
    if (!fs.existsSync(skillBaseDir)) return [];

    const skills = [];
    const seenNames = new Set();
    for (const filePath of this._findSkillFiles(skillBaseDir)) {
      try {
        const metadata = this._readMetadata(filePath);
        if (seenNames.has(metadata.name)) {
          console.warn(`[SkillLoader] 技能名称重复，跳过后发现的技能: ${metadata.name}`);
          continue;
        }
        seenNames.add(metadata.name);
        skills.push(metadata);
      } catch {
        // 单个技能格式错误或不可读不应阻止 Agent 启动，跳过它即可。
      }
    }
    return this.allowedSkillIds
      ? skills.filter((skill) => this.allowedSkillIds.has(skill.name))
      : skills;
  }

  // 生成注入 System Prompt 的轻量目录；模型只能看到技能名和何时使用，需通过 read_skill 获取正文。
  buildCatalog() {
    const skills = this.listSkills();
    if (skills.length === 0) return '';

    const entries = skills
      .map((skill) => `- \`${skill.name}\`：${skill.description}`)
      .join('\n');

    return `
### 可用专业技能（按需加载）
以下仅为技能目录，**未加载任何技能正文**。当用户任务明显符合某项触发条件时，先调用 \`read_skill\` 工具并传入对应 \`skill_name\`，获取完整执行指南后再执行；不匹配时不要加载。

${entries}
`;
  }

  // 按技能名读取完整正文。此方法只接受 listSkills() 发现的名称，不能让模型传任意文件路径。
  loadSkill(name) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('skill_name 必须是非空字符串');
    }

    const skill = this.listSkills().find((item) => item.name === name.trim());
    if (!skill) {
      throw new Error(`未找到技能: ${name}`);
    }

    // realpath 防止技能目录中的符号链接指向工作区外；只加载已扫描到的 SKILL.md。
    const baseReal = fs.realpathSync(this._skillBaseDir());
    const fileReal = fs.realpathSync(skill.filePath);
    const relative = path.relative(baseReal, fileReal);
    if (this._isOutside(relative)) {
      throw new Error(`技能文件位于技能目录外，拒绝加载: ${name}`);
    }

    const content = fs.readFileSync(fileReal, 'utf-8');
    const parsed = this._parseSkillMD(content, fileReal);
    // 正文为空时返回原文以便用户看到实际文件内容；正常 frontmatter 文件则只返回 frontmatter 后的指南。
    const body = parsed.body || content.trim();
    return new Skill({ ...skill, body });
  }

  _skillBaseDir() {
    return path.join(path.resolve(this.workDir), '.tiny-harness', 'skills');
  }

  _findSkillFiles(dir) {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this._findSkillFiles(fullPath));
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
    return results;
  }

  _readMetadata(filePath) {
    // 当前简化格式的 metadata 位于 SKILL.md 开头；为兼容旧格式仍读取文本后复用同一解析器，
    // 但不会把解析得到的 body 保存在目录项中或注入 Prompt。
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = this._parseSkillMD(content, filePath);
    return new Skill({
      name: parsed.name,
      description: parsed.description,
      filePath,
    });
  }

  // 解析 SKILL.md 的 YAML frontmatter + 正文。仅支持本项目需要的 name / description 两个简单字段。
  _parseSkillMD(content, filePath) {
    const skill = new Skill({ filePath, body: content.trim() });
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return skill;

    const [, frontmatter, body] = match;
    skill.body = body.trim();
    for (const line of frontmatter.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('name:')) {
        skill.name = trimmed.slice('name:'.length).trim();
      } else if (trimmed.startsWith('description:')) {
        skill.description = trimmed.slice('description:'.length).trim();
      }
    }
    return skill;
  }

  _isOutside(relativePath) {
    return (
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    );
  }
}
