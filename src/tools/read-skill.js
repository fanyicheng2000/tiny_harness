// ===========================================
// tools/read-skill.js
// ===========================================
// 按平台 Skill ID 按需、分页读取当前 Agent 被授权的技能。
// ===========================================

import { ToolDefinition } from '../schema/message.js';
import { SkillLoader } from '../context/skill.js';

const DEFAULT_LINE_LIMIT = 120;
const MAX_LINE_LIMIT = 300;
const MAX_OUTPUT_CHARS = 8000;

function parsePositiveInteger(value, defaultValue, fieldName, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${fieldName} 必须是 1 到 ${max} 之间的整数`);
  return value;
}

function splitLines(content) {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

export class ReadSkillTool {
  constructor(workDir, allowedSkillIds = null) {
    this.loader = new SkillLoader(workDir);
    this.allowedSkillIds = allowedSkillIds === null ? null : new Set(allowedSkillIds);
  }

  name() { return 'read_skill'; }

  definition() {
    return new ToolDefinition({
      name: this.name(),
      description: '按平台 Skill ID 分页读取当前 Agent 已授权的技能执行指南；不能读取未授权技能。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: '当前 Agent Skill 列表中登记的精确 Skill ID' },
          offset: { type: 'integer', minimum: 1, description: '起始行号，默认 1' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LINE_LIMIT, description: `读取行数，默认 ${DEFAULT_LINE_LIMIT}` },
        },
        required: ['skill_name'],
      },
    });
  }

  async execute(args) {
    const skillName = args?.skill_name;
    if (this.allowedSkillIds && !this.allowedSkillIds.has(skillName)) {
      throw new Error(`当前 Agent 未授权使用 Skill: ${skillName}`);
    }
    const offset = parsePositiveInteger(args?.offset, 1, 'offset');
    const limit = parsePositiveInteger(args?.limit, DEFAULT_LINE_LIMIT, 'limit', MAX_LINE_LIMIT);
    const skill = this.loader.loadSkill(skillName);
    const lines = splitLines(skill.body);
    if (offset > lines.length && lines.length > 0) throw new Error(`offset ${offset} 超出技能正文总行数 ${lines.length}`);

    const selected = [];
    let contentLength = 0;
    for (let index = offset - 1; index < lines.length && selected.length < limit; index++) {
      const line = `${index + 1} | ${lines[index]}`;
      if (selected.length > 0 && contentLength + line.length + 1 > MAX_OUTPUT_CHARS) break;
      selected.push(line);
      contentLength += line.length + (selected.length === 1 ? 0 : 1);
    }
    const endLine = selected.length === 0 ? 0 : offset + selected.length - 1;
    const hasMore = endLine < lines.length;
    const header = [`技能名称: ${skill.name}`, `行范围: ${selected.length ? `${offset}-${endLine}` : '无'} / ${lines.length}`, `还有更多: ${hasMore ? '是' : '否'}`, hasMore ? `下一页 offset: ${endLine + 1}` : null].filter(Boolean).join('\n');
    return `${header}\n\n完整执行指南:\n${selected.length ? selected.join('\n') : '[该技能没有正文]'}`;
  }
}
