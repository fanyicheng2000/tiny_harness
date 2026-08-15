// ===========================================
// tools/read-file.js
// ===========================================
// read_file 工具：按行分页读取指定路径的文本文件
//
// 关键设计：
//   1. 路径必须位于 workDir 内（路径边界保护，不是进程沙箱）
//   2. 对外使用 1-based 行号，便于直接对应 IDE / 报错 / grep -n 的行号
//   3. offset + limit 分页：大文件可以继续读取后续行，不再永远只能看到文件开头
//   4. 单次读取同时受“最多行数 + 最多字符数”限制，防止上下文爆炸
// ===========================================

import fs from 'fs';
import { ToolDefinition } from '../schema/message.js';
import {
  assertExistingPathInsideWorkspace,
  resolveWorkspacePath,
} from './path-utils.js';

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

// 将文本拆成逻辑行：兼容 Windows \r\n；文件以换行结尾时，不把最后的空片段算作额外一行。
function splitLines(content) {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

export class ReadFileTool {
  constructor(workDir) {
    this.workDir = workDir;
  }

  name() {
    return 'read_file';
  }

  definition() {
    return new ToolDefinition({
      name: this.name(),
      description:
        '按行分页读取指定路径的文本文件。行号从 1 开始；首次读取可省略 offset 和 limit。返回内容会包含已读取行范围、总行数及下一页起始行。',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要读取的文件路径，如 src/index.js',
          },
          offset: {
            type: 'integer',
            minimum: 1,
            description: `从第几行开始读取，行号从 1 开始，默认 ${DEFAULT_LINE_LIMIT} 行中的第 1 行。`,
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LINE_LIMIT,
            description: `最多读取多少行，默认 ${DEFAULT_LINE_LIMIT}，最大 ${MAX_LINE_LIMIT}；仍受单次 ${MAX_OUTPUT_CHARS} 字符输出预算限制。`,
          },
        },
        required: ['path'],
      },
    });
  }

  async execute(args) {
    try {
      const offset = parsePositiveInteger(args.offset, 1, 'offset');
      const limit = parsePositiveInteger(args.limit, DEFAULT_LINE_LIMIT, 'limit', MAX_LINE_LIMIT);
      const fullPath = resolveWorkspacePath(this.workDir, args.path);
      const safePath = assertExistingPathInsideWorkspace(this.workDir, fullPath);
      const lines = splitLines(fs.readFileSync(safePath, 'utf-8'));

      if (offset > lines.length && lines.length > 0) {
        throw new Error(`offset ${offset} 超出文件总行数 ${lines.length}`);
      }

      const startIndex = offset - 1;
      const selected = [];
      let contentLength = 0;
      let stoppedByCharBudget = false;

      // 逐行追加，优先在完整行边界停止，避免把正常代码行从中间切断。
      for (let index = startIndex; index < lines.length && selected.length < limit; index++) {
        const formattedLine = `${index + 1} | ${lines[index]}`;
        const separatorLength = selected.length === 0 ? 0 : 1;
        if (selected.length > 0 && contentLength + separatorLength + formattedLine.length > MAX_OUTPUT_CHARS) {
          stoppedByCharBudget = true;
          break;
        }

        // 极长的单行文本没有可用的行边界可停，因此作为例外截断该行并继续下一行。
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
        `文件: ${args.path}`,
        `行范围: ${selected.length === 0 ? '无（空文件）' : `${offset}-${endLine}`} / ${lines.length}`,
        `还有更多: ${hasMore ? '是' : '否'}`,
        hasMore ? `下一页 offset: ${endLine + 1}` : null,
        stoppedByCharBudget ? `提示: 本页因 ${MAX_OUTPUT_CHARS} 字符预算提前结束。` : null,
      ].filter(Boolean).join('\n');

      return selected.length > 0 ? `${header}\n\n${selected.join('\n')}` : `${header}\n\n[文件为空]`;
    } catch (err) {
      // 报错格式要让 recovery.js 能匹配
      throw new Error(`打开文件失败: ${err.message}`);
    }
  }
}
