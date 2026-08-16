// ===========================================
// agents/runtime.js
// ===========================================
// 根据一份平台 AgentDefinition 构造隔离运行环境：
// - System Prompt 使用该 Agent 的身份和技能目录；
// - Registry 只注册该 Agent 被授权的工具；
// - 只有 Root Agent 获得 run_subagent。
// ===========================================

import { Message, Role } from '../schema/message.js';
import { PromptComposer } from '../context/composer.js';
import { Registry } from '../tools/registry.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ReadSkillTool } from '../tools/read-skill.js';
import { WriteFileTool } from '../tools/write-file.js';
import { EditFileTool } from '../tools/edit-file.js';
import { BashTool } from '../tools/bash.js';
import { RunSubagentTool } from '../tools/run-subagent.js';

const TOOL_FACTORIES = {
  read_file: (workDir) => new ReadFileTool(workDir),
  read_skill: (workDir, agent) => new ReadSkillTool(workDir, agent.skillIds),
  write_file: (workDir) => new WriteFileTool(workDir),
  edit_file: (workDir) => new EditFileTool(workDir),
  bash: (workDir) => new BashTool(workDir),
};

export function buildAgentRegistry({ agent, workDir, engine, reporter, agentRegistry, middleware }) {
  const registry = new Registry();
  for (const toolName of agent.toolNames) {
    if (toolName === 'run_subagent') continue;
    const factory = TOOL_FACTORIES[toolName];
    if (!factory) throw new Error(`Agent '${agent.id}' 配置了平台未支持的工具: ${toolName}`);
    registry.register(factory(workDir, agent));
  }

  // 仅主 Agent 可委派；子 Agent 即使恶意在 toolNames 中填写 run_subagent 也无法获得该工具。
  if (agentRegistry.getRootAgent() === agent && agentRegistry.listSubagents().length > 0) {
    registry.register(new RunSubagentTool({ engine, workDir, reporter, agentRegistry, middleware }));
  }
  if (middleware) registry.use(middleware);
  return registry;
}

export function buildAgentSystemMessage({ agent, workDir, planMode = false }) {
  const base = new PromptComposer(workDir, planMode, agent.skillIds).build().content;
  const skills = agent.skillIds.length ? agent.skillIds.map((id) => `- \`${id}\``).join('\n') : '（未授权平台 Skill）';
  return new Message({
    role: Role.SYSTEM,
    content: `# 当前 Agent 身份\n名称：${agent.name}\n描述：${agent.description}\n\n# 角色系统提示词\n${agent.systemPrompt}\n\n# 当前 Agent 已授权的 Platform Skill ID\n${skills}\n\n${base}`,
  });
}
