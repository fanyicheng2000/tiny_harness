// ===========================================
// agents/agent-registry.js
// ===========================================
// Coordinator 可委派 Agent 的白名单与角色配置。
//
// 这对应 CatX 的 multiagent.agents：主 Agent 只能按 agent_id 委派这里登记的角色，
// 不能由模型临时指定任意 Prompt、工具或递归层级。
// ===========================================

export class AgentDefinition {
  constructor({ id, description, systemPrompt, toolNames, maxTurns = 6 }) {
    this.id = id;
    this.description = description;
    this.systemPrompt = systemPrompt;
    this.toolNames = toolNames;
    this.maxTurns = maxTurns;
  }
}

const READ_ONLY_EVIDENCE_RULES = `
【共同约束】
- 你是被 Coordinator 委派的专业子 Agent，只负责调研与报告，不直接修改任何文件。
- 只能使用系统提供的工具获取证据；不要猜测。
- 结论必须尽量给出文件路径、函数名和行号；不确定之处明确列入待确认项。
- 完成后停止调用工具，输出简洁的纯文本报告给 Coordinator。`;

export class AgentRegistry {
  constructor(definitions = defaultDefinitions()) {
    this.definitions = new Map();
    for (const definition of definitions) {
      if (this.definitions.has(definition.id)) {
        throw new Error(`AgentDefinition 重复: ${definition.id}`);
      }
      this.definitions.set(definition.id, definition);
    }
  }

  get(agentId) {
    if (typeof agentId !== 'string' || !agentId.trim()) {
      throw new Error("参数 'agent_id' 必须是非空字符串");
    }
    const definition = this.definitions.get(agentId.trim());
    if (!definition) {
      throw new Error(`Coordinator 无权委派 Agent: ${agentId}`);
    }
    return definition;
  }

  list() {
    return [...this.definitions.values()];
  }
}

export function defaultDefinitions() {
  return [
    new AgentDefinition({
      id: 'explorer',
      description: '负责跨文件定位调用链、实现位置和可验证代码证据',
      toolNames: ['read_file'],
      maxTurns: 8,
      systemPrompt: `你是 Explorer Agent，专门探索代码库的结构、调用链和实现细节。${READ_ONLY_EVIDENCE_RULES}`,
    }),
    new AgentDefinition({
      id: 'reviewer',
      description: '负责识别代码变更的逻辑风险、边界条件和潜在回归',
      toolNames: ['read_file'],
      maxTurns: 6,
      systemPrompt: `你是 Reviewer Agent，专门进行只读代码审查。检查正确性、错误处理、边界条件、兼容性和缺失测试，并按风险等级报告。${READ_ONLY_EVIDENCE_RULES}`,
    }),
    new AgentDefinition({
      id: 'test_planner',
      description: '负责分析测试覆盖并给出应补充的测试场景与断言建议',
      toolNames: ['read_file'],
      maxTurns: 6,
      systemPrompt: `你是 Test Planner Agent，专门从代码行为中设计测试场景。识别正常路径、边界、失败恢复和回归风险，给出可执行的测试建议。${READ_ONLY_EVIDENCE_RULES}`,
    }),
  ];
}
