// ===========================================
// tools/read-skill.js
// ===========================================
// read_skill：按名称按需、按行分页读取一个技能的完整执行指南。
//
// System Prompt 只含技能目录；模型确认当前任务匹配某项技能后才调用本工具。
// 行分页与 read_file 保持一致：默认 120 行、单页最多 300 行、单次最多 8,000 字符，
// 结果提供下一页 offset，使长 Skill 不会一次塞满模型上下文。
// ===========================================

import { ToolDefinition } from '../schema/message.js';
import { SkillLoader } from '../context/skill.js';

const DEFAULT_LINE_LIMIT = 120;
const MAX_LINE_LIMIT = 300;
const MAX_OUTPUT_CHARS = 8000;

function parsePositiveInteger(value, defaultValue, fieldName, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${fieldName} 必须是 1 到 ${max} 之间的整数`);
  }
  return value;
}

// 与 read_file 一致：兼容 Windows 换行；末尾换行不算额外空白行。
function splitLines(content) {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

export class ReadSkillTool {
  constructor(workDir) {
    this.loader = new SkillLoader(workDir);
  }

  name() {
    return 'read_skill';
  }

  definition() {
    return new ToolDefinition({
      name: this.name(),
      description:
        '按技能名称分页读取一个已登记技能的完整执行指南。仅当用户任务符合 System Prompt 中该技能的触发条件时调用；不要猜测名称，也不能读取任意文件。首次可省略 offset 和 limit，后续按返回的下一页 offset 继续。',
      inputSchema: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: '技能目录中列出的精确技能名称，例如 git-review',
          },
          offset: {
            type: 'integer',
            minimum: 1,
            description: `从执行指南的第几行开始读取，行号从 1 开始，默认 1。`,
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LINE_LIMIT,
            description: `最多读取多少行，默认 ${DEFAULT_LINE_LIMIT}，最大 ${MAX_LINE_LIMIT}；仍受单次 ${MAX_OUTPUT_CHARS} 字符输出预算限制。`,
          },
        },
        required: ['skill_name'],
      },
    });
  }

  async execute(args) {
    const offset = parsePositiveInteger(args?.offset, 1, 'offset');
    const limit = parsePositiveInteger(args?.limit, DEFAULT_LINE_LIMIT, 'limit', MAX_LINE_LIMIT);
    const skill = this.loader.loadSkill(args?.skill_name);
    const lines = splitLines(skill.body);

    if (offset > lines.length && lines.length > 0) {
      throw new Error(`offset ${offset} 超出技能正文总行数 ${lines.length}`);
    }

    const startIndex = offset - 1;
    const selected = [];
    let contentLength = 0;
    let stoppedByCharBudget = false;

    // 逐行加入完整指南；优先在行边界停止，避免普通步骤说明被从中间切断。
    for (let index = startIndex; index < lines.length && selected.length < limit; index++) {
      const formattedLine = `${index + 1} | ${lines[index]}`;
      const separatorLength = selected.length === 0 ? 0 : 1;
      if (selected.length > 0 && contentLength + separatorLength + formattedLine.length > MAX_OUTPUT_CHARS) {
        stoppedByCharBudget = true;
        break;
      }

      // 单行本身超过字符预算时没有可用的行边界，只能截断该行并提示模型。
      if (selected.length === 0 && formattedLine.length > MAX_OUTPUT_CHARS) {
        const prefix = `${index + 1} | `;
        const available = MAX_OUTPUT_CHARS - prefix.length;
        selected.push(`${prefix}${lines[index].slice(0, available)}...[本行过长，已截断]`);
        stoppedByCharBudget = true;
        break;
      }

      selected.push(formattedLine);
      contentLength += separatorLength + formattedLine.length;
    }

    const endLine = selected.length === 0 ? 0 : startIndex + selected.length;
    const hasMore = endLine < lines.length;
    const header = [
      `技能名称: ${skill.name}`,
      `触发条件: ${skill.description}`,
      `行范围: ${selected.length === 0 ? '无（技能正文为空）' : `${offset}-${endLine}`} / ${lines.length}`,
      `还有更多: ${hasMore ? '是' : '否'}`,
      hasMore ? `下一页 offset: ${endLine + 1}` : null,
      stoppedByCharBudget ? `提示: 本页因 ${MAX_OUTPUT_CHARS} 字符预算提前结束。` : null,
    ].filter(Boolean).join('\n');

    return selected.length > 0
      ? `${header}\n\n完整执行指南:\n${selected.join('\n')}`
      : `${header}\n\n完整执行指南:\n[该技能没有正文]`;
  }
}
