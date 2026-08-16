// ===========================================
// agents/agent-registry.js
// ===========================================
// 平台 Agent 配置模型。
//
// 主 Agent 与子 Agent 共用 AgentDefinition（名称、描述、Prompt、Skill、工具），
// 但只有 RootAgentDefinition 可以声明 multiAgents。这样把“谁可委派谁”变为
// 平台配置数据，而不是写死 Explorer / Reviewer 等角色。
// ===========================================

const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;

export class AgentDefinition {
  constructor({
    id,
    name,
    description = '',
    systemPrompt = '',
    skillIds = [],
    toolNames = [],
    maxTurns = 6,
    multiAgents,
  }) {
    validateId(id);
    validateText(name, 'Agent 名称');
    validateText(systemPrompt, 'Agent 系统提示词');
    validateStringArray(skillIds, 'skillIds');
    validateStringArray(toolNames, 'toolNames');
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error('maxTurns 必须是大于 0 的整数');
    }
    if (multiAgents !== undefined) {
      throw new Error(`子 Agent '${id}' 不允许携带 multiAgents；只有主 Agent 可以委派子 Agent`);
    }

    this.id = id;
    this.name = name;
    this.description = description;
    this.systemPrompt = systemPrompt;
    this.skillIds = [...skillIds];
    this.toolNames = [...new Set(toolNames)];
    this.maxTurns = maxTurns;
  }
}

export class RootAgentDefinition extends AgentDefinition {
  constructor({ multiAgents = [], ...definition }) {
    // Root 自己不应触发子 Agent 禁止 multiAgents 的校验。
    super(definition);
    if (!Array.isArray(multiAgents)) {
      throw new Error('主 Agent 的 multiAgents 必须是数组');
    }

    this.multiAgents = new Map();
    for (const child of multiAgents) {
      const agent = child instanceof AgentDefinition ? child : new AgentDefinition(child);
      if (this.multiAgents.has(agent.id)) {
        throw new Error(`主 Agent 的 multiAgents 存在重复 ID: ${agent.id}`);
      }
      this.multiAgents.set(agent.id, agent);
    }
  }

  getSubagent(agentId) {
    if (typeof agentId !== 'string' || !agentId.trim()) {
      throw new Error("参数 'agent_id' 必须是非空字符串");
    }
    const agent = this.multiAgents.get(agentId.trim());
    if (!agent) {
      throw new Error(`主 Agent 未配置可委派的子 Agent: ${agentId}`);
    }
    return agent;
  }

  listSubagents() {
    return [...this.multiAgents.values()];
  }
}

// AgentRegistry 是平台读取一份主 Agent 配置后的运行时入口。
// 子 Agent 只能通过 rootAgent.getSubagent() 按直属关系被定位。
export class AgentRegistry {
  constructor(rootAgent) {
    this.rootAgent = rootAgent instanceof RootAgentDefinition
      ? rootAgent
      : new RootAgentDefinition(rootAgent);
  }

  getRootAgent() {
    return this.rootAgent;
  }

  getSubagent(agentId) {
    return this.rootAgent.getSubagent(agentId);
  }

  listSubagents() {
    return this.rootAgent.listSubagents();
  }
}

function validateId(id) {
  if (typeof id !== 'string' || !SAFE_AGENT_ID.test(id)) {
    throw new Error('Agent ID 只能包含字母、数字、点、下划线和连字符');
  }
}

function validateText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串`);
  }
}

function validateStringArray(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${label} 必须是字符串数组`);
  }
}
