// ===========================================
// tools/bash.js
// ===========================================
// BashTool 只负责 Agent 工具协议：校验参数、提交调度任务、
// 把执行结果返回 Registry。实际在哪运行由 ExecutionBackend 决定：
// local = 宿主机 sh；docker = 受限容器。
// ===========================================

import { ToolDefinition } from '../schema/message.js';
import { defaultExecutionScheduler } from '../execution/default-scheduler.js';
import { getDefaultExecutionBackend } from '../execution/default-backend.js';
import { LocalProcessBackend } from '../execution/backend.js';
import { getExecutionContext } from '../execution/context.js';
import { getCurrentSpan } from '../observability/trace.js';

export class BashTool {
  constructor(workDir, { scheduler = defaultExecutionScheduler, backend = null, timeoutMs = null } = {}) {
    this.workDir = workDir;
    this.scheduler = scheduler;
    // 保持第一期 BashTool({ timeoutMs }) 的注入方式兼容；显式 backend 优先。
    this.backend = backend || (timeoutMs ? new LocalProcessBackend({ timeoutMs }) : getDefaultExecutionBackend());
  }

  name() { return 'bash'; }

  definition() {
    const environment = this.backend.name === 'docker' ? '受限 Docker 容器' : '本机 Shell（不提供安全隔离）';
    return new ToolDefinition({
      name: this.name(),
      description: `在指定工作目录中执行 shell 命令。当前执行环境：${environment}；命令会进入本地执行队列，输出过长会被截断。`,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          priority: { type: 'integer', description: '可选，数值越大越优先；默认 0' },
          resources: {
            type: 'object', description: '可选执行资源规格；未传使用默认 1000m CPU / 512MB 内存',
            properties: { cpuMillis: { type: 'integer' }, memoryMb: { type: 'integer' } },
          },
        },
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
      label: `bash:${this.backend.name}`,
      priority: args.priority ?? 0,
      resources: args.resources,
      run: (signal) => this.backend.execute({ command, workDir: this.workDir, signal, resources: args.resources }),
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
    span.addAttribute('executionBackend', this.backend.name);
  }
}
