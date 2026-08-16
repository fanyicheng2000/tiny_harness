// ===========================================
// tools/run-subagent.js
// ===========================================
// Coordinator 通过 run_subagent 将任务委派给白名单中的专业子 Agent。
// 每个角色拥有独立 Prompt、最大 Turn 和最小只读工具集；子 Agent 不能再次委派。
// ===========================================

import { ToolDefinition } from '../schema/message.js';
import { AgentRegistry } from '../agents/agent-registry.js';
import { Registry } from './registry.js';
import { ReadFileTool } from './read-file.js';

const MAX_TASK_CHARS = 4000;
const MAX_REPORT_CHARS = 8000;

export class RunSubagentTool {
  constructor({ engine, workDir, reporter = null, agentRegistry = new AgentRegistry() }) {
    this.engine = engine;
    this.workDir = workDir;
    this.reporter = reporter;
    this.agentRegistry = agentRegistry;
  }

  name() { return 'run_subagent'; }

  definition() {
    const agents = this.agentRegistry.list()
      .map((agent) => `${agent.id}（${agent.description}）`).join('；');
    return new ToolDefinition({
      name: this.name(),
      description: `委派一个独立只读任务给白名单专业子 Agent。可用角色：${agents}。适合跨文件调研、审查或测试设计；简单单文件读取请直接用 read_file。子 Agent 不能修改文件、执行 Shell 或再委派。`,
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: '可用角色的精确 ID，如 explorer、reviewer、test_planner' },
          task: { type: 'string', description: '一个清晰、可验证的委派任务，应要求文件、函数和行号等证据' },
          thread_id: { type: 'string', description: '可选；传入已有线程 ID 可复用该子 Agent 的历史记忆，实现多轮协作' },
        },
        required: ['agent_id', 'task'],
      },
    });
  }

  async execute(args) {
    const task = args?.task;
    if (typeof task !== 'string' || !task.trim()) throw new Error("参数 'task' 必须是非空字符串");
    if (task.length > MAX_TASK_CHARS) throw new Error(`子 Agent 任务不能超过 ${MAX_TASK_CHARS} 个字符`);

    const definition = this.agentRegistry.get(args?.agent_id);
    const registry = createReadOnlyRegistry(this.workDir, definition.toolNames);
    const threadId = args?.thread_id || `${definition.id}-${Date.now()}`;
    const report = await this.engine.runSub(task.trim(), registry, this.reporter, {
      systemPrompt: definition.systemPrompt,
      maxTurns: definition.maxTurns,
      threadId,
      workDir: this.workDir,
    });
    if (typeof report !== 'string' || !report.trim()) return `[${definition.id} 未返回文字报告]`;
    return report.length > MAX_REPORT_CHARS
      ? `${report.slice(0, MAX_REPORT_CHARS)}\n\n[${definition.id} 报告超过 ${MAX_REPORT_CHARS} 字符，已截断]`
      : report;
  }
}

function createReadOnlyRegistry(workDir, toolNames) {
  const registry = new Registry();
  if (toolNames.includes('read_file')) registry.register(new ReadFileTool(workDir));
  return registry;
}
