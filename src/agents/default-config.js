// CLI 教学演示默认配置。真实平台应从数据库或平台 API 读取同构配置。
export const defaultAgentConfig = {
  id: 'tiny-harness-main',
  name: 'Tiny Harness 主 Agent',
  description: '负责理解用户任务、执行工具，并按需委派直属子 Agent。',
  systemPrompt: '你是 Tiny Harness 的主 Agent。依据用户目标选择自身工具或委派合适的直属子 Agent，并整合结果。',
  skillIds: [],
  toolNames: ['read_file', 'read_skill', 'write_file', 'edit_file', 'bash', 'run_subagent'],
  multiAgents: [
    {
      id: 'tiny-harness-worker',
      name: 'Tiny Harness 通用子 Agent',
      description: '执行主 Agent 委派的独立任务，可按其独立权限读取、分析或修改工作区。',
      systemPrompt: '你是 Tiny Harness 的通用子 Agent。专注完成主 Agent 指定的任务，清晰报告结果与风险。',
      skillIds: [],
      toolNames: ['read_file', 'read_skill', 'write_file', 'edit_file', 'bash'],
      maxTurns: 8,
    },
  ],
};
