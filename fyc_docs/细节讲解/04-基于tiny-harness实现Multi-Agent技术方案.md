# 基于 tiny-harness 实现 Multi-Agent 的技术方案

> 目标：在不推翻现有 `AgentEngine + Session + Registry + Provider` ReAct 架构的前提下，使一个主 Agent 能够把可并行、可隔离的子任务委派给多个专业子 Agent，并把经过限制和审计的结果汇总回主任务。

## 1. 先说结论：推荐的目标形态

推荐先实现 **Supervisor（主控）— Worker（专业子 Agent）** 架构：

```text
用户
  ↓
主 Agent / Supervisor
  ├─ 自己处理简单任务、统一制定计划、拥有写入权限和最终答复权
  ├─ run_subagent("检索认证链路") ──→ Explorer Agent（只读代码/日志）
  ├─ run_subagent("审查改动风险") ──→ Reviewer Agent（只读、给审查意见）
  └─ run_subagent("设计测试方案") ──→ Test Planner Agent（只读、生成测试建议）
                                      ↓
                           每个 Worker 只返回结构化报告
                                      ↓
主 Agent 汇总证据、决定后续写代码 / 跑测试 / 回复用户
```

这是最适合当前项目的第一阶段方案，原因是：

1. 项目已经有 `AgentEngine.runSub()`，具备一次性只读探索子 Agent 的循环基础；
2. 主 Agent 已有成熟的 Session、工具审批、错误恢复、Trace、上下文压缩能力；
3. 将写文件、执行危险 Shell、最终答复集中在主 Agent，可避免多 Agent 并发写同一文件或绕过人工审批；
4. 多 Agent 的价值首先来自**上下文隔离、角色专业化、并行检索**，不是让多个模型无约束地“聊天”。

不建议一开始实现“所有 Agent 共享历史、自由轮流发言”的群聊模式：实现复杂、Token 成本和循环风险更高，也难以审计哪个 Agent 对最终写入负责。

---

## 2. 当前项目已经具备的基础

### 2.1 主 Agent ReAct 循环

`src/engine/loop.js` 的 `AgentEngine.run()` 已承担以下职责：

```text
Session 工作记忆
  → Provider.generate()
  → 模型返回 ToolCall
  → Registry.execute()
  → ToolResult 写回 Session
  → 下一轮 ReAct
```

它已经支持同一轮多个 ToolCall 用 `Promise.all()` 并发执行。因此，当模型一次请求多个互不依赖的 `run_subagent` 调用时，主循环无需改成串行就可并发等待多个报告。

### 2.2 已存在但尚未接通的 `runSub()`

`AgentEngine.runSub(taskPrompt, readOnlyRegistry, reporter)` 已实现探索 Worker 的核心循环：

- 使用独立 `contextHistory`，不会污染主 Session；
- 起始消息为专门的 Explorer System Prompt；
- 仅使用传入的 `readOnlyRegistry`；
- 最多 10 个 Turn；
- 每一轮可并发执行只读工具；
- 完成后返回一段文本报告；
- Reporter 已支持 `onSubAgentToolCall()` 与 `onSubAgentToolResult()`。

当前缺口是：`runSub()` 是 `AgentEngine` 的普通方法，**没有包装成模型可调用的 Tool**。主模型看到的工具列表里没有 `run_subagent`，因此不会自主委派任务。

### 2.3 可复用的安全与观测能力

| 现有能力 | Multi-Agent 中的用途 |
| --- | --- |
| `Registry` 与 middleware | 为不同 Worker 配发不同工具白名单及审批策略 |
| `resolveWorkspacePath` / 符号链接校验 | 继续限制 Worker 读取文件的工作区边界 |
| `Session` JSONL | 主任务持久化；后续可扩展记录委派事件和结果摘要 |
| `Compactor` | 限制主 / 子 Agent 上下文，避免报告与历史无限膨胀 |
| `RecoveryManager` / `ReminderInjector` | 子任务工具失败后的恢复；后续可单独统计每个 Worker 的失败 |
| `startSpan()` | 形成 `Agent.Run → Tool.run_subagent → Subagent.Run` 的嵌套追踪树 |
| `TerminalReporter` | 区分主 Agent 和子 Agent 的工具活动 |

---

## 3. 业内常用的 Multi-Agent 编排模式

主流框架并不存在一个“唯一正确”的多 Agent 形态。LangGraph 的 Multi-agent 文档强调可按任务结构选择 Supervisor、层级团队、网络等拓扑；Microsoft AutoGen 则将 Concurrent Agents、Sequential Workflow、Group Chat、Handoff、Debate 等作为独立模式。

### 3.1 Supervisor / Subagents（本项目推荐）

```text
Supervisor 选择任务
  ├─ 委派 Worker A
  ├─ 委派 Worker B
  └─ 汇总、验证、最终行动
```

- **适用**：代码库探索、并行资料收集、测试计划、代码审查、根因分析。
- **优点**：职责清晰；主 Agent 掌控最终输出和写权限；容易加入预算、超时、审批。
- **缺点**：Supervisor 仍可能拆分不好；报告过长会增加汇总上下文。
- **对应本项目**：直接把 `runSub()` 接成工具。

### 3.2 Handoff（交接）

```text
用户 → 通用接待 Agent → 领域 Agent A / B
```

当前 Agent 根据意图，将**接下来的对话控制权**转给另一个专业 Agent。例如售后 Agent 交接给退款 Agent。

- **适用**：客服、固定领域路由、长对话中“谁主答”的职责转移。
- **不适合当前第一阶段**：代码 Agent 的最终写入和上下文所有权不应频繁转移，否则 Session、工具权限、审批和回滚边界都会变复杂。
- **后续可选**：当项目有稳定的 `frontend`、`backend`、`database` 领域团队时，再实现 `handoff_to(agentId)`。

### 3.3 Group Chat / Debate（群聊 / 辩论）

```text
共享消息线程
  ↓
调度器选择下一位发言者
  ↓
Writer ↔ Reviewer ↔ Architect ...
```

AutoGen 的 Group Chat 由 Manager 选择下一位发言 Agent，常用 round-robin 或 LLM selector；参与者围绕共享主题顺序发言。

- **适用**：创作协作、架构方案辩论、多个候选答案交叉评审。
- **风险**：每位 Agent 都会重复读取公共历史，Token 增长快；轮次选择与终止条件难控制；容易出现“礼貌附和”而非真实验证。
- **建议**：只作为后期的“有限轮数 Reviewer Debate”能力，不能作为默认执行模型。

### 3.4 Sequential Workflow（流水线）

```text
需求分析 Agent → 实现 Agent → 测试 Agent → 审查 Agent
```

- **适用**：产物类型明确且有稳定前后依赖的流程。
- **优点**：可预测、好测、审批点明确。
- **缺点**：灵活性不足，上游错误会传递到下游。
- **建议**：适合 CI 或固定交付流程；用确定性代码编排步骤，不要让 LLM 每次自由决定顺序。

### 3.5 Concurrent Fan-out / Fan-in（扇出 / 汇聚）

```text
                 ┌→ Explorer: 找调用链
主任务 ──扇出────┼→ Reviewer: 找风险
                 └→ Tester: 找测试点
                         ↓
                    汇聚为报告
```

- **适用**：多个子任务独立，结果可以并行收集。
- **对应本项目**：现有主循环已经用 `Promise.all()` 执行同轮 ToolCall；为 `run_subagent` 工具增加并发上限即可。
- **关键点**：并发不等于无上限；模型调用、Shell、文件系统和上下文预算都必须限流。

---

## 4. 推荐的第一阶段边界

先将多 Agent 做成“**只读研究团队**”，由主 Agent 保留全部副作用权限。

| 角色 | 能做什么 | 第一阶段禁止什么 |
| --- | --- | --- |
| Supervisor | 分解任务、调用 Worker、汇总报告、调用主 Registry 工具、最终回复 | 不应把未验证的 Worker 文本直接当作事实 |
| Explorer | `read_file`、受限 `bash` 搜索、分析调用链 | 写文件、编辑文件、危险 Shell、再次派生子 Agent |
| Reviewer | 读取变更和测试，输出风险及建议 | 直接修复代码、批准自身建议 |
| Test Planner | 读取代码 / 测试，给出测试清单 | 运行破坏性命令、写测试文件 |

这样可将治理规则固定为：

> Worker 只提供证据和建议；Supervisor 对事实核验、代码改动、工具审批和最终结果负责。

这与“最小权限”原则一致，也避免两个子 Agent 同时修改同一个工作区导致竞态和覆盖。

---

## 5. 第一阶段架构设计

### 5.1 新增模块建议

```text
src/
  agents/
    agent-definition.js       # AgentDefinition：角色、Prompt、工具权限、预算
    worker-registry.js        # WorkerRegistry：按 ID 查找并校验角色
    subagent-tool.js          # RunSubagentTool：暴露给主模型的工具适配器
    subagent-manager.js       # SubagentManager：并发、超时、预算、结果裁剪
    worker-prompts.js         # Explorer / Reviewer / TestPlanner 的专用 Prompt
```

这些模块不要放进 `tools/` 后直接让任意 Worker 继承全部工具；`subagent-tool.js` 可以实现工具接口，但调度、角色定义和资源治理应留在 `agents/`，避免 `Registry` 变成了解所有 Agent 生命周期的上帝对象。

### 5.2 核心对象

```js
// agents/agent-definition.js（建议接口）
export class AgentDefinition {
  constructor({ id, description, systemPrompt, toolNames, maxTurns, timeoutMs, maxOutputChars }) {
    this.id = id;                       // explorer / reviewer / test_planner
    this.description = description;     // 给 Supervisor 选择角色用
    this.systemPrompt = systemPrompt;   // 角色专用规则
    this.toolNames = toolNames;         // 最小工具白名单
    this.maxTurns = maxTurns;
    this.timeoutMs = timeoutMs;
    this.maxOutputChars = maxOutputChars;
  }
}
```

```js
// run_subagent 的输入契约（建议 JSON Schema）
{
  agent_id: 'explorer',
  task: '定位订单取消接口的调用链，列出文件、函数和证据行号',
  context: '用户希望修改取消原因校验；只调查，不修改文件。'
}
```

```js
// 成功输出：不要只返回无结构自然语言，建议固定为 JSON 文本
{
  status: 'completed',
  agentId: 'explorer',
  summary: '取消入口为 ...',
  findings: [
    { claim: '入口函数为 cancelOrder', evidence: 'src/order/service.js:42', confidence: 'high' }
  ],
  openQuestions: [],
  suggestedNextActions: ['主 Agent 阅读 src/order/service.js:42-88']
}
```

结构化报告的目的不是“格式好看”，而是让主 Agent 能够区分**结论、证据、待确认问题**，并让测试可以稳定断言返回内容。

### 5.3 `SubagentManager` 的职责

`SubagentManager` 是实际调度器，应持有：

- 当前可用 Agent Definition；
- `createReadOnlyRegistry(workDir)` 工厂；
- `AgentEngine.runSub()` 或后续独立 WorkerRunner；
- `maxConcurrentSubagents` 信号量；
- 单任务超时、总子任务数、总 Token / 总成本预算；
- 结果截断、结果结构校验、失败归一化；
- Trace / Reporter 事件。

伪代码：

```js
async run({ agentId, task, context, parentSession, reporter }) {
  const definition = this.workerRegistry.get(agentId);
  this.budget.assertCanStart(parentSession.id, definition);

  return this.semaphore.use(async () => {
    const registry = this.createReadOnlyRegistry(parentSession.workDir, definition.toolNames);
    const prompt = buildWorkerTask(definition, task, context);

    const raw = await withTimeout(
      this.engine.runSub(prompt, registry, reporter),
      definition.timeoutMs
    );

    const report = parseAndValidateReport(raw, definition.maxOutputChars);
    this.budget.record(parentSession.id, report);
    return report;
  });
}
```

建议初始配置：

| 限制 | 建议起始值 | 作用 |
| --- | ---: | --- |
| 最大并发 Worker | 2 | 防止一次 ToolCall 扇出压垮 API / Shell |
| 单 Worker 最大 Turn | 6 | 当前 `runSub()` 为 10，可先收紧 |
| 单 Worker 超时 | 60 秒 | 防止模型或工具长时间挂起 |
| 单报告最大字符 | 8,000 | 控制回传到主上下文的大小 |
| 每次主任务最大 Worker 数 | 4 | 避免模型无限委派 |
| 最大嵌套深度 | 1 | Worker 不能再委派 Worker |

### 5.4 `RunSubagentTool`：连接主 Agent 与子 Agent

该工具注册在**主 Registry** 中，因此模型可以像调用 `read_file` 一样调用它。

```text
主模型 ToolCall
  { name: 'run_subagent', arguments: { agent_id, task, context } }
        ↓
主 Registry.execute(call)
        ↓
RunSubagentTool.execute(arguments)
        ↓
SubagentManager.run(...)
        ↓
临时只读 Registry + runSub()
        ↓
结构化 Worker Report
        ↓
ToolResult
        ↓
作为带 toolCallId 的 Message 回到主 Session
```

工具定义建议明确告诉模型何时使用：

```text
当任务需要独立检索、代码库范围较大、或需要第二视角审查时调用。
不要把简单的单文件读取委派给子 Agent；不要要求 Worker 修改文件。
一次调用只给一个清晰、可验证的子任务，并要求返回具体文件/函数/行号证据。
```

### 5.5 如何构造只读 Registry

不能直接把主 `Registry` 传给 Worker：主 Registry 中含 `write_file`、`edit_file`、完整 `bash`，并且可能带有为主流程设计的审批状态。

建议提供工厂函数，只注册明确白名单：

```js
function createReadOnlyRegistry(workDir, allowedToolNames) {
  const registry = new Registry();
  if (allowedToolNames.includes('read_file')) {
    registry.register(new ReadFileTool(workDir));
  }
  if (allowedToolNames.includes('search_code')) {
    registry.register(new SearchCodeTool(workDir));
  }
  return registry;
}
```

尤其不建议把通用 `BashTool` 原样交给 Worker。即使 Worker “承诺只用 grep/find”，模型仍可能调用 `rm`、`curl`、环境变量读取等命令。更安全的做法是新增：

- `search_code`：只允许 `rg` 语义的代码搜索；
- `list_files`：只允许列目录；
- `read_file`：复用现有分页读取；
- `git_diff`：只允许只读 Git 查询。

如果短期必须复用 Bash，应增加命令 AST / allowlist 校验，拒绝重定向、管道到 shell、命令替换、网络访问和写入指令；仅靠字符串包含 `grep` 并不安全。

---

## 6. 状态、上下文与通信设计

### 6.1 不共享完整历史，只传最小任务上下文

不要把主 Session 全量复制给每个 Worker，原因是：

- 增加 Token 与延迟；
- 主历史中的工具结果可能对 Worker 无关；
- 可能把主任务中的敏感信息暴露给本不需要的角色；
- 多个 Worker 对同一历史做不同解释，难以归因。

传给 Worker 的上下文应控制为：

```text
角色 System Prompt
+ 主 Agent 明确写出的 task
+ 必要背景摘要（目标、约束、已知事实）
+ 可访问工具定义
```

Worker 完成后，主 Session 只追加其压缩后的结构化报告，而不是追加 Worker 的完整逐轮 ToolCall 历史。完整 Worker Trace 可以单独落盘供调试。

### 6.2 引入委派事件记录

主 Session 需要可恢复“已派了什么、结果是什么”。建议扩展 JSONL，加入事件型记录：

```json
{"type":"delegation","delegationId":"deleg_01","parentSessionId":"task-1","agentId":"explorer","task":"定位取消调用链","status":"started","createdAt":"..."}
{"type":"delegation","delegationId":"deleg_01","status":"completed","summary":"...","tracePath":"...","updatedAt":"..."}
```

不要把完整 Worker 上下文塞到主 JSONL；可单独保存：

```text
.tiny-harness/sessions/task-1/subagents/deleg_01.jsonl
.tiny-harness/traces/task-1/deleg_01.json
```

这样断点续传时可以显示已完成 / 失败 / 超时的委派任务，也不会将主会话无限放大。

### 6.3 报告可信度规则

Worker 报告必须包含证据。推荐主 Agent System Prompt 加入：

```text
子 Agent 报告是辅助观察，不是最终事实。
涉及代码结论时，优先依据报告中的文件路径、函数名和行号重新读取关键位置；
证据缺失、置信度低或结果冲突时，继续核验而不是直接修改代码。
```

这是防止“多 Agent 幻觉被放大”的关键。更多 Agent 不会自动带来更正确的结果。

---

## 7. 并发、冲突与终止策略

### 7.1 并发模型

主 Agent 一轮内如果返回：

```text
run_subagent(explorer, 调用链)
run_subagent(reviewer, 风险)
run_subagent(test_planner, 测试点)
```

现有 `AgentEngine` 的 `Promise.all()` 会并发执行。`SubagentManager` 仍要用信号量限制真实并发数为 2：其余任务排队，而不是同时请求模型。

不要让多个 Worker 共享一个可变数组的上下文，也不要同时向主 `Session` 直接 append。应等待每个 `ToolResult` 返回后，由**主循环**按照 ToolCall 顺序一次性 append，保持协议消息与 `toolCallId` 配对正确。

### 7.2 写冲突策略

第一阶段 Worker 全只读，因此没有文件写冲突。

未来若允许“实现 Worker”写代码，必须采用以下至少一种策略：

1. **Workspace 隔离**：每个 Worker 使用独立 Git worktree / 临时副本；主 Agent 只接收 diff；
2. **单写者原则**：Worker 产出补丁建议，主 Agent 是唯一真正执行 `edit_file` 的角色；
3. **文件锁 / 声明式所有权**：计划阶段为 Worker 分配不重叠文件集合；
4. **强制 Review Gate**：任何 Worker diff 都要经过 Reviewer + 主 Agent 复核后合并。

对 tiny-harness，优先顺序是 **单写者原则 → Git worktree 隔离**。不要在同一工作目录里让多个模型并行编辑。

### 7.3 终止条件

每个层级都要有硬限制：

| 层级 | 终止条件 |
| --- | --- |
| Worker | 无 ToolCall、最大 Turn、超时、取消、预算耗尽 |
| Supervisor | 无 ToolCall、最大总 Turn、总时长、总成本、用户取消 |
| Group Chat（若后续实现） | 最大发言轮数、Manager 判定完成、Reviewer 批准、人工终止 |

当前主 `AgentEngine.run()` 使用 `while (true)`，只依赖“模型不再调工具”结束。引入 Multi-Agent 前建议补上 `maxMainTurns`、`maxRunMs` 与总成本上限；否则子 Agent 虽有限制，Supervisor 仍可不断继续委派。

---

## 8. 可观测性与人类审批

### 8.1 Trace 树

建议将调用链扩展为：

```text
Agent.Run (session=task-1)
  └─ Turn-2
      ├─ LLM.Action
      ├─ Tool.run_subagent (agent=explorer, delegation=deleg_01)
      │   └─ Subagent.Run (agent=explorer)
      │       ├─ Subagent.LLM.Action
      │       ├─ Subagent.Tool.search_code
      │       └─ Subagent.Tool.read_file
      └─ Tool.run_subagent (agent=reviewer, delegation=deleg_02)
          └─ Subagent.Run ...
```

关键属性包括：`agentId`、`delegationId`、父任务摘要、Turn 数、工具数、耗时、Token、成本、报告字符数、终止原因。

### 8.2 终端事件

现有 Reporter 已有 Subagent 工具事件，建议再增加：

```js
onSubagentStart({ delegationId, agentId, task }) {}
onSubagentEnd({ delegationId, agentId, status, durationMs, summary }) {}
```

示例输出：

```text
[🤝 委派] explorer / deleg_01：定位订单取消调用链
[🛠️ Subagent:explorer] search_code {"query":"cancelOrder"}
[✅ Subagent:explorer] read_file
[📥 汇报] explorer / 12.4s：找到 3 个入口，详见证据 ...
```

### 8.3 审批策略

- 只读 Worker：一般无需逐次人工审批，但仍受路径边界与搜索工具约束；
- 任意写入或执行命令的 Worker：必须经主 Registry 的审批 middleware，或更严格地在发起委派前审批；
- 主 Agent：维持现有 `bash` / `write_file` / `edit_file` 审批；
- 不能因为“子 Agent 是内部组件”就绕过审计与审批。

---

## 9. 分阶段落地计划

### Phase 0：补齐主引擎护栏

1. 给 `AgentEngine.run()` 增加主任务 `maxTurns`、总超时、预算上限；
2. 修正 `runSub()` 的参数化能力：接收 Worker 的 `systemPrompt`、`maxTurns`，不要将 Explorer Prompt 和 `10` 硬编码；
3. 为 `runSub()` 增加 `startSpan('Subagent.Run')`；
4. 统一 Worker 工具调用中的 `toolCallId` 传递给 Reporter。

验收：无子 Agent 工具时，已有主流程行为不变。

### Phase 1：只读 Explorer MVP

1. 创建 `AgentDefinition` 与 `WorkerRegistry`，只注册 `explorer`；
2. 创建受限 `createReadOnlyRegistry()`，仅包含 `read_file` 与新的 `search_code` / `list_files`；
3. 创建 `SubagentManager`，实现超时、并发 2、最大 4 个委派、报告 8k 截断；
4. 创建 `RunSubagentTool` 并注册到主 Registry；
5. 主 System Prompt 注入“何时适合委派”的简短规则；
6. 使用 MockProvider 增加可复现剧本：主 Agent 同轮派两个 Explorer，之后汇总结果。

验收：模型可调用 `run_subagent`；两个独立搜索可并行；Worker 无法看到写工具；超时、未知角色、超出并发 / 配额都有可读 `ToolResult`。

### Phase 2：专业角色与结构化报告

1. 增加 `reviewer`、`test_planner` 定义；
2. 强制 JSON / JSON Schema 报告校验，失败时返回“报告格式错误”而非未经处理的长文本；
3. 报告中要求 `findings[].evidence`；
4. 保存 delegation JSONL 与独立子 Trace；
5. 在主 Agent 汇总 Prompt 中加入“关键结论需复读证据”的规则。

验收：不同角色拥有不同 Prompt 和工具集；主 Session 只保留报告摘要；可从 trace 和 JSONL 定位每次委派。

### Phase 3：审查闭环与可选写入隔离

1. 实现“Explorer → Implementer（工作树隔离）→ Reviewer → Supervisor 合并”固定流水线；
2. 为 Implementer 建独立 Git worktree，限制其只提交 diff；
3. Reviewer 对 diff、测试结果、风险项给结构化结论；
4. 只有 Supervisor 在人工审批后将补丁应用到主工作区。

验收：即使两个 Implementer 并发，也不会写同一工作目录；失败 Worker 的变更可整体丢弃。

### Phase 4：按需引入更复杂拓扑

仅在明确需求存在时实现 Handoff 或有限轮 Debate。应使用确定性状态机 / 图，而非让 LLM 无限决定下一位发言者。

---

## 10. 测试方案

### 单元测试

- `WorkerRegistry`：未知角色、角色配置、工具白名单；
- `SubagentManager`：并发信号量、超时、最大委派数、报告截断、预算拒绝；
- `RunSubagentTool`：输入 Schema、成功 / 失败 `ToolResult`、`toolCallId` 保留；
- 只读 Registry：绝不暴露 `write_file`、`edit_file`、不受限 `bash`；
- 报告解析：缺少证据、无效 JSON、超长报告。

### 集成测试

使用 `MockProvider` 固定返回如下序列：

```text
主 Agent：同时调用 explorer 和 reviewer
Explorer：search_code → read_file → 完成报告
Reviewer：read_file → 完成报告
主 Agent：读取两份 ToolResult → 产生最终回答
```

断言：

1. 两个 Worker 都在主 Agent 下一轮前完成；
2. 主 Session 中有两个带正确 `toolCallId` 的结果消息；
3. Worker 的工具清单不含写工具；
4. Trace 存在父子层级；
5. 一个 Worker 超时不会导致另一个 Worker 的结果丢失；
6. 超过最大委派数时，主 Agent 收到可理解错误并能自行调整策略。

### 安全回归

- Worker 请求 `../`、绝对路径、符号链接逃逸；
- Worker 尝试调用未注册的 `write_file`；
- Worker 尝试通过搜索工具构造 Shell 注入；
- 多 Worker 同时返回超长内容；
- 递归调用 `run_subagent`；
- 主任务长时间继续委派，验证总 Turn / 预算限制。

---

## 11. 关键风险与取舍

| 风险 | 原因 | 缓解方式 |
| --- | --- | --- |
| 成本和延迟上升 | 每个 Worker 都会消耗模型调用 | 只对高价值、独立子任务委派；并发上限、总预算、短报告 |
| 幻觉互相放大 | 多份自然语言结论可能彼此引用 | 强制证据字段；主 Agent 复读关键代码；Reviewer 独立核验 |
| 上下文爆炸 | 报告和子历史重复进入主上下文 | 子历史独立存储；主会话仅写摘要；字符上限 |
| 并发写冲突 | 多个 Worker 修改同一工作区 | 第一阶段只读；后续单写者或 worktree 隔离 |
| 权限绕过 | Worker 继承了主工具 / Bash | 每角色专用 Registry、最小工具集、禁用递归委派 |
| 无限循环 | Supervisor 可不断委派，Worker 也可能反复工具调用 | 每层 Turn / 超时 / 预算 / 深度硬限制 |
| 难以调试 | 嵌套异步调用来源复杂 | delegationId、Span 父子树、独立 JSONL / Trace |

---

## 12. 最终建议

对这个项目，正确的演进顺序不是先实现“多个 Agent 互相聊天”，而是：

```text
已有 runSub()
  → 接成受限 run_subagent 工具
  → 只读 Explorer 并发检索
  → 结构化报告 + 预算 + Trace
  → 增加 Reviewer / Test Planner
  → 最后才考虑 worktree 隔离的写入 Worker、Handoff 或群聊辩论
```

这条路径复用了 tiny-harness 已有的 ReAct、Registry、Session、Compactor、Recovery、Reporter 和 Trace 设计，同时遵循主流框架共同强调的原则：**明确角色、显式路由、最小权限、受控并发、可观测执行、确定终止条件**。
