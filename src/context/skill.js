// ===========================================
// context/skill.js
// ===========================================
// Skill 加载器：遍历 .tiny-harness/skills/*/SKILL.md
//
// SKILL.md 格式：
//   ---
//   name: skill-name
//   description: 什么时候用这个技能
//   ---
//   正文：执行指南
//
// 加载后注入到 System Prompt 的"可用专业技能"段落
// ===========================================

import fs from 'fs';
import path from 'path';

export class Skill {
  constructor(name = 'Unknown Skill', description = 'No description provided.', body = '') {
    this.name = name;
    this.description = description;
    this.body = body;
  }
}

export class SkillLoader {
  constructor(workDir) {
    this.workDir = workDir;
  }

  /**
   * 加载所有技能，返回拼接后的字符串（注入 System Prompt）
   * @returns {string}
   */
  loadAll() {
    const skillBaseDir = path.join(this.workDir, '.tiny-harness', 'skills');
    if (!fs.existsSync(skillBaseDir)) return '';

    let builder = '';
    builder += '\n### 可用专业技能 (Agent Skills)\n';
    builder += '以下是你拥有的标准化外挂技能，请在符合 description 描述的场景下严格遵循其正文指令：\n\n';

    // 递归查找所有 SKILL.md
    const skillFiles = this._findSkillFiles(skillBaseDir);
    for (const file of skillFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const skill = this._parseSkillMD(content);
        builder += `#### 技能名称: ${skill.name}\n`;
        builder += `**触发条件**: ${skill.description}\n\n`;
        builder += '**执行指南**:\n';
        builder += skill.body;
        builder += '\n\n---\n';
      } catch {
        // 读取失败，跳过
      }
    }

    return builder.length < 50 ? '' : builder;
  }

  // 递归查找 SKILL.md 文件
  _findSkillFiles(dir) {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this._findSkillFiles(fullPath));
      } else if (entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
    return results;
  }

  // 解析 SKILL.md 的 YAML frontmatter + 正文
  _parseSkillMD(content) {
    const skill = new Skill();
    skill.body = content;

    // 简单解析 YAML frontmatter
    if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
      const parts = content.split('---');
      if (parts.length >= 3) {
        const frontmatter = parts[1];
        skill.body = parts[2].trim();

        for (const line of frontmatter.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('name:')) {
            skill.name = trimmed.slice(5).trim();
          } else if (trimmed.startsWith('description:')) {
            skill.description = trimmed.slice(12).trim();
          }
        }
      }
    }

    return skill;
  }
}
