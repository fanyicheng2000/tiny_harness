// ===========================================
// tools/write-file.js
// ===========================================
// write_file 工具：创建或覆盖写入文件
//
// 关键设计：
//   1. 自动创建父目录（mkdirAll）
//   2. 路径相对于 workDir
// ===========================================

import fs from 'fs';
import path from 'path';
import { ToolDefinition } from '../schema/message.js';
import { resolveWorkspacePath } from './path-utils.js';

export class WriteFileTool {
  constructor(workDir) {
    this.workDir = workDir;
  }

  name() {
    return 'write_file';
  }

  definition() {
    return new ToolDefinition({
      name: this.name(),
      description: '创建或覆盖写入一个文件。如果目录不存在会自动创建。请提供相对于工作区的相对路径。',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要写入的文件路径，如 src/main.js',
          },
          content: {
            type: 'string',
            description: '要写入的完整文件内容',
          },
        },
        required: ['path', 'content'],
      },
    });
  }

  async execute(args) {
    try {
      const fullPath = resolveWorkspacePath(this.workDir, args.path);
      // 自动创建父目录
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, args.content, 'utf-8');
      return `成功将内容写入到文件: ${args.path}`;
    } catch (err) {
      throw new Error(`写入文件失败: ${err.message}`);
    }
  }
}
