// ===========================================
// tools/bash.js
// ===========================================
// 在指定工作目录里执行 shell 命令（不是安全沙箱）
//
// 安全设计：
//   1. 30 秒超时——防止死循环命令把 Agent 卡死
//   2. 原始合并输出超过 8000 UTF-8 字节时保留首尾片段
//   3. 默认工作目录设为 workDir——命令仍可访问进程权限允许的其他路径
//
// 为什么不直接用 execSync：
//   - execSync 是阻塞的，超时控制只能靠 spawn + setTimeout
//   - 我们要把 stdout/stderr 一起拿回来给模型
// ===========================================

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ToolDefinition } from '../schema/message.js';

const MAX_OUTPUT_BYTES = 8000;
const TIMEOUT_MS = 30_000;     // 30 秒

export class BashTool {
  constructor(workDir, { timeoutMs = TIMEOUT_MS } = {}) {
    this.workDir = workDir;
    this.timeoutMs = timeoutMs;
  }

  name() {
    return 'bash';
  }

  definition() {
    return new ToolDefinition({
      name: this.name(),
      description:
        '在指定工作目录中执行 shell 命令（不提供安全隔离）。可用来运行测试、查看目录、跑脚本等。命令最长运行 30 秒，输出过长会被截断。',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令',
          },
        },
        required: ['command'],
      },
    });
  }

  async execute(args) {
    const { command } = args;
    if (!command || typeof command !== 'string') {
      throw new Error("参数 'command' 不能为空");
    }

    return new Promise((resolve, reject) => {
      // 用 sh -c 执行，兼容 macOS / Linux
      // 注意：Windows 下应该用 cmd /c，这里简化只考虑 unix-like
      const child = spawn('sh', ['-c', command], {
        cwd: this.workDir,
        env: process.env,
      });

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;

      child.stdout.on('data', (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr.on('data', (chunk) => {
        stderr = Buffer.concat([stderr, chunk]);
      });

      // 超时强制杀死
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(
          formatOutput(stdout, stderr) +
            `\n[⚠️ 命令超过 ${this.timeoutMs}ms 未结束，已被强制终止]`
        ));
      }, this.timeoutMs);

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = formatOutput(stdout, stderr);
        if (code !== 0) {
          // Registry 会把这个包含完整诊断信息的错误转换成 isError=true。
          reject(new Error(`${out}\n[退出码: ${code}]`));
        } else {
          resolve(out || '[命令执行成功，无输出]');
        }
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`[执行失败] ${err.message}`));
      });
    });
  }
}

// 把 stdout + stderr 拼起来，原始合并输出超过 8000 UTF-8 字节就截断
function formatOutput(stdout, stderr) {
  let text = '';
  if (stdout.length > 0) {
    text += stdout.toString('utf8');
  }
  if (stderr.length > 0) {
    if (text) text += '\n';
    text += `[stderr]\n${stderr.toString('utf8')}`;
  }

  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length > MAX_OUTPUT_BYTES) {
    // 按字节保留原始输出的头尾；边界落在多字节字符中间时会显示替换字符。
    const head = encoded.subarray(0, 4000).toString('utf8');
    const tail = encoded.subarray(encoded.length - 4000).toString('utf8');
    const skipped = encoded.length - 8000;
    text = `${head}\n\n...[输出超过 8000 字节，中间 ${skipped} 字节已被截断]...\n\n${tail}`;
  }
  return text;
}
