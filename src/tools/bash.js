// ===========================================
// tools/bash.js
// ===========================================
// 本地 Shell 执行工具。命令先提交给 ExecutionScheduler，
// 由调度器完成队列、并发配额、排队超时和取消治理；真正的
// 进程生命周期仍由本工具负责（超时强杀、输出截断）。
// ===========================================

import { spawn } from 'node:child_process';
import { ToolDefinition } from '../schema/message.js';
import { defaultExecutionScheduler } from '../execution/default-scheduler.js';
import { getExecutionContext } from '../execution/context.js';
import { getCurrentSpan } from '../observability/trace.js';

const MAX_OUTPUT_BYTES = 8000;
const TIMEOUT_MS = 30_000;

export class BashTool {
  constructor(workDir, { timeoutMs = TIMEOUT_MS, scheduler = defaultExecutionScheduler } = {}) {
    this.workDir = workDir;
    this.timeoutMs = timeoutMs;
    this.scheduler = scheduler;
  }

  name() { return 'bash'; }

  definition() {
    return new ToolDefinition({
      name: this.name(),
      description: '在指定工作目录中执行 shell 命令（不提供安全隔离）。命令会进入本地执行队列，最长运行 30 秒，输出过长会被截断。',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command'],
      },
    });
  }

  async execute(args) {
    const { command } = args;
    if (!command || typeof command !== 'string') throw new Error("参数 'command' 不能为空");

    const context = getExecutionContext();
    const job = this.scheduler.submit({
      sessionId: context.sessionId,
      agentId: context.agentId,
      label: 'bash',
      run: (signal) => this._runProcess(command, signal),
    });
    this._recordJob(job);
    return job.promise;
  }

  _recordJob(job) {
    const span = getCurrentSpan();
    if (!span) return;
    span.addAttribute('executionJobId', job.id);
    span.addAttribute('executionSessionId', job.sessionId);
    span.addAttribute('executionAgentId', job.agentId);
  }

  _runProcess(command, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { cwd: this.workDir, env: process.env });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const stop = (reason) => {
        child.kill('SIGKILL');
        reject(new Error(`${formatOutput(stdout, stderr)}\n${reason}`));
      };
      const onAbort = () => finish(() => stop(`[⚠️ ${signal.reason?.message || '任务被调度器取消'}]`));
      const timer = setTimeout(() => finish(() => stop(`[⚠️ 命令超过 ${this.timeoutMs}ms 未结束，已被强制终止]`)), this.timeoutMs);

      signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
      child.stderr.on('data', (chunk) => { stderr = Buffer.concat([stderr, chunk]); });
      child.on('close', (code) => finish(() => {
        const output = formatOutput(stdout, stderr);
        if (code !== 0) reject(new Error(`${output}\n[退出码: ${code}]`));
        else resolve(output || '[命令执行成功，无输出]');
      }));
      child.on('error', (err) => finish(() => reject(new Error(`[执行失败] ${err.message}`))));
    });
  }
}

function formatOutput(stdout, stderr) {
  let text = '';
  if (stdout.length > 0) text += stdout.toString('utf8');
  if (stderr.length > 0) text += `${text ? '\n' : ''}[stderr]\n${stderr.toString('utf8')}`;
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length > MAX_OUTPUT_BYTES) {
    const head = encoded.subarray(0, 4000).toString('utf8');
    const tail = encoded.subarray(encoded.length - 4000).toString('utf8');
    text = `${head}\n\n...[输出超过 8000 字节，中间 ${encoded.length - 8000} 字节已被截断]...\n\n${tail}`;
  }
  return text;
}
