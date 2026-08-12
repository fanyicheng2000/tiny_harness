// ===========================================
// tools/read-file.js
// ===========================================
// read_file 工具：读取指定路径的文件内容
//
// 关键设计：
//   1. 路径必须位于 workDir 内（路径边界保护，不是进程沙箱）
//   2. 超过 8000 个 JavaScript 字符自动截断（防止上下文爆炸）
//   3. 报错信息要让模型能理解（配合 recovery.js）
// ===========================================

import fs from 'fs';
import { ToolDefinition } from '../schema/message.js';
import {
  assertExistingPathInsideWorkspace,
  resolveWorkspacePath,
} from './path-utils.js';

const MAX_LEN = 8000;

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
      description: '读取指定路径的文件内容。请提供相对工作区的路径。',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要读取的文件路径，如 src/index.js',
          },
        },
        required: ['path'],
      },
    });
  }

  async execute(args) {
    try {
      const fullPath = resolveWorkspacePath(this.workDir, args.path);
      const safePath = assertExistingPathInsideWorkspace(this.workDir, fullPath);
      const content = fs.readFileSync(safePath, 'utf-8');
      if (content.length > MAX_LEN) {
        return content.slice(0, MAX_LEN) + `\n\n...[由于内容过长，已被系统截断至前 ${MAX_LEN} 个字符]...`;
      }
      return content;
    } catch (err) {
      // 报错格式要让 recovery.js 能匹配
      throw new Error(`打开文件失败: ${err.message}`);
    }
  }
}
