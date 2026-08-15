// ===========================================
// tools/run-subagent.js
// ===========================================
// run_subagent：让主 Agent 将一个独立的只读调研任务委派给 Explorer Subagent。
//
// 安全边界：子 Agent 不复用主 Registry，运行时新建仅含 read_file 的 Registry；
// 因而它无法 write_file、edit_file、执行 bash，也不能递归调用 run_subagent。
// 子 Agent 完成后只把文字报告作为当前 ToolResult 返回给主 Agent。
// ===========================================

import { ToolDefinition } from '../schema/message.js';
import { Registry } from './registry.js';
import { ReadFileTool } from './read-file.js';

const MAX_TASK_CHARS = 4000;
const MAX_REPORT_CHARS = 8000;

export class RunSubagentTool {
  constructor({ engine, workDir, reporter = null }) {
    this.engine = engine;
    this.workDir = workDir;
    this.reporter = reporter;
  }

  name() {
    return 'run_subagent';
  }

  definition() {
    return new ToolDefinition({
      name: this.name(),
      description:
        '委派一个独立的只读代码调研任务给 Explorer Subagent。适合跨多个文件的调用链定位、证据收集或问题排查；简单的单文件读取请直接使用 read_file。子 Agent 只能读取文件，不能修改文件、执行 Shell 或再委派子 Agent。返回带文件和行号证据的调研报告。',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '一个清晰、可验证的调研任务，应说明要找什么证据、关注哪些文件或关键词；例如“定位认证失败错误的产生和处理调用链，列出文件、函数和行号”。',
          },
        },
        required: ['task'],
      },
    });
  }

  async execute(args) {
    const task = args?.task;
    if (typeof task !== 'string' || !task.trim()) {
      throw new Error("参数 'task' 必须是非空字符串");
    }
    if (task.length > MAX_TASK_CHARS) {
      throw new Error(`子 Agent 任务不能超过 ${MAX_TASK_CHARS} 个字符`);
    }

    // 每次委派创建独立 Registry，而非传入主 Registry；最小权限是子 Agent 隔离的核心。
    const readOnlyRegistry = new Registry();
    readOnlyRegistry.register(new ReadFileTool(this.workDir));

    const report = await this.engine.runSub(task.trim(), readOnlyRegistry, this.reporter);
    if (typeof report !== 'string' || !report.trim()) {
      return '[子 Agent 未返回文字报告]';
    }

    // 报告最终会作为 ToolResult 写回主 Session，必须限制大小避免子 Agent 输出撑爆主上下文。
    if (report.length > MAX_REPORT_CHARS) {
      return `${report.slice(0, MAX_REPORT_CHARS)}\n\n[子 Agent 报告超过 ${MAX_REPORT_CHARS} 字符，已截断]`;
    }
    return report;
  }
}
