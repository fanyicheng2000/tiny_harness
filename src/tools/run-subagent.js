// ===========================================
// tools/run-subagent.js
// ===========================================
// 主 Agent 的委派工具。可委派目标严格来自当前主 Agent 的 multiAgents 配置；
// 子 Agent 运行时不会注册本工具，因此不能继续委派。
// ===========================================

import { ToolDefinition } from '../schema/message.js';
import { Registry } from './registry.js';
import { ReadFileTool } from './read-file.js';
import { ReadSkillTool } from './read-skill.js';
import { WriteFileTool } from './write-file.js';
import { EditFileTool } from './edit-file.js';
import { BashTool } from './bash.js';
import { PromptComposer } from '../context/composer.js';

const MAX_TASK_CHARS = 4000;
const MAX_REPORT_CHARS = 8000;
const activeThreads = new Set();

const TOOL_FACTORIES = {
  read_file: (workDir) => new ReadFileTool(workDir),
  read_skill: (workDir, agent) => new ReadSkillTool(workDir, agent.skillIds),
  write_file: (workDir) => new WriteFileTool(workDir),
  edit_file: (workDir) => new EditFileTool(workDir),
  bash: (workDir) => new BashTool(workDir),
};

export class RunSubagentTool {
  constructor({ engine, workDir, reporter = null, agentRegistry, middleware = null }) {
    if (!agentRegistry) throw new Error('run_subagent 必须绑定主 Agent 配置');
    this.engine = engine;
    this.workDir = workDir;
    this.reporter = reporter;
    this.agentRegistry = agentRegistry;
    this.middleware = middleware;
  }

  name() { return 'run_subagent'; }

  definition() {
    const agents = this.agentRegistry.listSubagents()
      .map((agent) => `${agent.id}（${agent.name}：${agent.description}）`).join('；');
    return new ToolDefinition({
      name: this.name(),
      description: `委派任务给当前主 Agent 配置的直属子 Agent：${agents}。子 Agent 的 Skill、工具和系统提示词均按其独立平台配置执行。`,
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: '主 Agent 的 multiAgents 中登记的精确 Agent ID' },
          task: { type: 'string', description: '清晰、可验证的委派任务与验收证据要求' },
          thread_id: { type: 'string', description: '可选；复用该子 Agent 的持久化线程' },
        },
        required: ['agent_id', 'task'],
      },
    });
  }

  async execute(args) {
    const task = args?.task;
    if (typeof task !== 'string' || !task.trim()) throw new Error("参数 'task' 必须是非空字符串");
    if (task.length > MAX_TASK_CHARS) throw new Error(`子 Agent 任务不能超过 ${MAX_TASK_CHARS} 个字符`);

    const agent = this.agentRegistry.getSubagent(args?.agent_id);
    const threadId = args?.thread_id || `${agent.id}-${Date.now()}`;
    if (activeThreads.has(threadId)) throw new Error(`线程 ${threadId} 正在执行中，不允许并发调用同一子 Agent`);

    activeThreads.add(threadId);
    try {
      const registry = createChildRegistry(this.workDir, agent, this.middleware);
      const systemPrompt = buildChildSystemPrompt(this.workDir, agent);
      const report = await this.engine.runSub(task.trim(), registry, this.reporter, {
        systemPrompt,
        maxTurns: agent.maxTurns,
        threadId,
        workDir: this.workDir,
      });
      if (typeof report !== 'string' || !report.trim()) return `[${agent.name} 未返回文字报告]`;
      return report.length > MAX_REPORT_CHARS
        ? `${report.slice(0, MAX_REPORT_CHARS)}\n\n[${agent.name} 报告超过 ${MAX_REPORT_CHARS} 字符，已截断]`
        : report;
    } finally {
      activeThreads.delete(threadId);
    }
  }
}

function createChildRegistry(workDir, agent, middleware) {
  const registry = new Registry();
  for (const toolName of agent.toolNames) {
    // 单层约束：即便配置数据被绕过，子 Agent 也绝不获得 run_subagent。
    if (toolName === 'run_subagent') continue;
    const factory = TOOL_FACTORIES[toolName];
    if (!factory) throw new Error(`子 Agent '${agent.id}' 配置了平台未支持的工具: ${toolName}`);
    registry.register(factory(workDir, agent));
  }
  if (middleware) registry.use(middleware);
  return registry;
}

function buildChildSystemPrompt(workDir, agent) {
  const skillCatalog = new PromptComposer(workDir, false, agent.skillIds).build().content;
  return `# 当前子 Agent 身份\n名称：${agent.name}\n描述：${agent.description}\n\n# 子 Agent 系统提示词\n${agent.systemPrompt}\n\n# 委派纪律\n- 仅完成当前任务并返回报告。\n- 不能继续委派其他 Agent。\n- 工具与 Skill 权限以当前配置为准。\n\n${skillCatalog}`;
}
