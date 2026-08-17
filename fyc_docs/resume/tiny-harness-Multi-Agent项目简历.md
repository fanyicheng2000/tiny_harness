# tiny-harness｜可配置 Multi-Agent Harness｜个人项目

> 两版内容均基于当前仓库实现整理：长版适合作品集/面试材料，短版控制在半页左右，适合直接放入简历。

**技术栈：** Node.js（ESM）｜原生 `fetch`｜OpenAI-compatible API｜Anthropic Messages API｜Function Calling / ReAct｜JSONL｜`AsyncLocalStorage`｜CLI / readline｜UUID

---

## 长版（作品集 / 面试材料）

**背景：** 从 0 到 1 搭建通用 Agent Harness。大模型只负责"想做什么" → Harness 负责"怎么安全地做、失败后怎么恢复、过程怎么追踪"。同一套底座通过替换 Prompt / Skill / Tool / Agent 配置 → 可组装检索、分析、自动化等不同 Agent，不绑定某一种具体业务。

**我的职责：** 项目 Owner，负责从单 Agent ReAct Loop → Multi-Agent 协作 → 状态恢复与运行治理的完整实现。

### 1. 核心主链路：Provider → ReAct Loop → Registry

- Provider 层统一对外暴露 `generate(messages, tools)`；OpenAI-compatible / Anthropic / Mock Provider 各自处理消息格式、Function Calling、Token 字段差异 → **切模型不改执行引擎**。
- ReAct Loop：LLM 决策 → Tool Call → Registry 执行 → ToolResult 回灌 → LLM 下一轮决策；无 Tool Call 即结束。
- 支持慢思考两阶段：先发起 Thinking 生成分析/计划 → 再携带 Tool Schema 调用 Action；避免模型一上来就盲目调工具。
- 同一轮多个 Tool Call 使用 `Promise.all` 并发执行 → 读文件、检索等独立操作无需串行等待；按 `toolCallId` 精确回填结果。
- Registry 维护 `toolName → tool` 映射：聚合 Tool Schema 给模型 → 按名称路由真实工具 → 将未知工具、审批拒绝、执行异常统一转换为 ToolResult。新增模型补 Provider，新增工具补 Tool，主循环不动。

### 2. Multi-Agent：主 Agent 调度 → Worker 隔离执行 → 报告回流

- Agent 配置统一为 `id / Prompt / Skill / Tool / maxTurns`；Root Agent 额外配置 `multiAgents`，明确"有哪些 Worker 可调用"。
- 主 Agent → `run_subagent(agent_id, task, thread_id?)` → 指定 Worker 独立执行 → 最终报告回传主 Agent → 主 Agent 汇总继续决策。
- 子 Agent 不复用主 Agent 的工具集：每次委派按目标角色重建 **System Prompt + Skill Catalog + Tool Registry**；主 Agent 有 Shell 不代表 Worker 也有。
- 防止无限套娃：子 Agent 配置出现 `multiAgents` 直接拒绝；即使恶意在工具白名单里写 `run_subagent`，运行时仍强制剥离 → **配置校验 + 工具注册双层限制递归委派**。

### 3. 并发与状态：角色复用 → Thread 隔离 → JSONL 续接

- 拆分 `agent_id` 和 `thread_id`：`agent_id` = Worker 角色模板，例如 `reviewer`；`thread_id` = 一次具体任务的上下文，例如 `reviewer-uuid-1`。
- 同一个 `reviewer` → 可同时处理模块 A / B / C；未传 `thread_id` 时自动生成 `agentId-randomUUID()` → 多实例天然隔离。
- 子 Agent 对话与工具记录写入 `.tiny-harness/threads/<thread-id>.jsonl`；显式复用 `thread_id` → 加载历史 → 继续上轮任务。
- 同一 Thread 同时续接会导致历史交错写入；使用进程内 `activeThreads` 锁：执行前占用 → `finally` 释放 → 相同 Thread 的并发请求直接拒绝，不同 Thread 保持并发。

### 4. 长任务恢复：Working Memory → Plan Mode → Session 落盘

- Session 采用 JSONL 增量落盘，保存消息、Token、费用等元数据；进程中断后按 Session ID 恢复。
- 历史过长时：保留 System Prompt → 裁剪近期 Working Memory → 清理无主 Tool Result → 对早期内容分层压缩，避免上下文越跑越大。
- Plan Mode 将短期计划和完成状态写入文件：任务拆解 → 标记进度 → 中断后重新读取计划继续推进，避免 Agent "失忆"。
- System Prompt 按基础规则、当前角色、Skill 目录、工作记忆、计划状态分层组装；Skill 只注入索引 → Agent 按需读取全文，避免一次塞满上下文。

### 5. 工具防御与失败恢复：先限制 → 再引导 → 最后叫醒

- `Registry + Middleware` 在真实执行前设置统一拦截点：可接入人工审批；Shell 具备超时强杀和输出截断。
- `read_file`：工作区路径校验 → 真实路径校验 → 防 `../` 目录穿越和软链接逃逸；大文件采用 `offset + limit` 分页，并限制最大行数/字符数，避免单次 Observation 撑爆上下文。
- `edit_file`：模型给出的 `old_text` 经常存在换行、缩进偏差；设计四级降级：精确匹配 → 换行归一化 → 首尾 `trim` → 逐行去缩进。每一级都要求**唯一命中**，命中多处直接拒绝 → 提升编辑成功率，同时避免误改。
- 工具失败后走两道串联防线：
  - **Recovery（软引导）**：识别路径不存在、编辑未命中、命令超时/语法错误等特征 → 注入救援指南，如"先 `ls/find` 查路径""先重新读文件再编辑"。
  - **Reminder（硬叫醒）**：以 `工具名 + 参数` 生成调用指纹；相同指纹连续失败 3 次 → 注入"停止原样重试、切换策略"的强提醒。
  - 改过参数 → 新指纹 → 允许有效重试；原样重试 → 识别为死循环。

### 6. 可观测性：Span 树 → Trace 回放 → 成本统计

- 基于 `AsyncLocalStorage` 自动串联 Agent Run → Turn → LLM → Tool → Sub-agent 的父子调用关系，无需层层手动传递上下文。
- 导出 JSON Span Trace：可查看哪个 Agent 调了什么工具、耗时在哪一段、子任务如何回流 → 用于问题回放与排障。
- `CostTracker` 以装饰器方式包裹 Provider：记录模型调用次数、输入/输出 Token、估算费用 → 按 Session / Thread 聚合统计。
- Session 记录覆盖消息、Token、费用等元数据 → 中断后可恢复，也可用于复盘和成本分析。

### 7. 架构总览

```text
主 Agent（全局任务拆分与汇总）
  ├── run_subagent(agent_id, task, thread_id?)
  ├── Worker A：独立 Prompt / Skill / Tool Registry / Thread
  ├── Worker B：独立 Prompt / Skill / Tool Registry / Thread
  └── Worker N：独立 Prompt / Skill / Tool Registry / Thread

配置驱动角色 + Agent 级权限隔离 + 单层委派
+ 同角色多实例并发 + 同 Thread 互斥续接 + 人工审批 + Trace
```

**项目规模：** 约 3000 行 Node.js 代码、零第三方运行时依赖；覆盖 Mock 演示、真实模型调用链路，以及 Agent 配置校验、运行时隔离、委派、Thread 持久化与并发互斥测试。

---

## 短版（简历用，半页）

### tiny-harness｜可配置 Multi-Agent Harness｜Node.js 个人项目

- 从零实现 ReAct Agent Harness，完成"模型决策 → 并发工具调用 → 结果回灌 → 多轮推理"闭环；抽象统一消息/工具协议，兼容 OpenAI-compatible、Anthropic、Mock Provider → 切模型不改执行引擎。
- 设计配置驱动 Multi-Agent 模型：主 Agent 声明直属 `multiAgents` → `run_subagent` 委派 Worker 独立执行 → 报告回传汇总；每次委派按角色重建 Prompt + Skill + Tool Registry → 权限不透传；配置校验 + 运行时注册双层禁止子 Agent 递归委派。
- 拆分 `agent_id`（角色模板）与 `thread_id`（任务实例）→ 同角色可并发多实例，未传 ID 自动 `randomUUID()`；JSONL 持久化 Thread → 可多轮续接；`activeThreads` 锁保证同一 Thread 不会并发写入。
- 工具层防御设计：`read_file` 路径校验 + 分页截断；`edit_file` 四级模糊降级（精确 → 换行归一化 → trim → 去缩进）；失败恢复走 Recovery（错误特征匹配 → 注入救援指南）+ Reminder（工具名+参数指纹 → 连续失败 3 次叫醒）两道串联防线。
- 长任务恢复：Session JSONL 增量落盘 → 中断后恢复；Working Memory 裁剪 + 无主 ToolResult 清理 + 分层压缩控制上下文膨胀；Plan Mode 计划落盘 → 断点续推。
- 可观测性：`AsyncLocalStorage` 自动串联 Agent Run → Turn → LLM → Tool → Sub-agent 的 Span 树 → 导出 JSON Trace 回放；`CostTracker` 装饰器统计 Token 与费用。
- 约 3000 行代码、零第三方运行时依赖；覆盖配置校验、运行时隔离、委派、Thread 持久化与并发互斥测试。

---

## 面试讲解要点

**为什么子 Agent 不能继续委派？** `AgentDefinition` 的构造器拒绝 `multiAgents`；同时构造子 Agent Registry 时无条件跳过 `run_subagent`。前者防止错误配置落入运行时，后者防止配置被绕过后出现工具权限逃逸。

**为什么要拆分 `agent_id` 和 `thread_id`？** `agent_id` 是固定角色，例如 `reviewer`；`thread_id` 是某一次角色实例的状态容器。角色需要可并发复用，而一次已开始的任务需要可持久化续接，这两种语义不能共用一个 ID。

**如何保证权限隔离不是只写在 Prompt 里？** 每次委派都以目标 Agent 的 `toolNames` 重新建 Registry，仅实例化被授权工具；Skill Catalog 也由 `skillIds` 限制。权限不依赖模型自觉，而由运行时实际可调用的工具集合保证。

**如何规避 Thread 并发写入竞态？** `run_subagent` 执行前检查并登记 `activeThreads`，结束时在 `finally` 释放。相同 Thread 的第二次调用被拒绝，不同 Thread 仍可并发运行。

**工具失败后怎么处理？** 先走 Recovery：按错误类型（路径不存在、编辑未命中、命令超时等）注入针对性救援指南，引导模型换策略。如果模型原样重试，以 `工具名 + 参数` 生成指纹，连续 3 次相同指纹失败 → 注入强提醒叫停。改了参数就是新指纹，允许有效重试。

**断点续传怎么实现？** Session 用 JSONL 增量落盘，保存消息、Token、费用；中断后按 Session ID 重新加载。Plan Mode 把计划和进度写文件，重启后读回继续推进。Thread 也持久化到 JSONL，显式传 `thread_id` 就能接着上次跑。

---

> 使用说明：项目未提供线上用户量、业务收益、QPS、成功率或成本节省等真实生产数据，简历中不应虚构此类指标；投递时请按真实项目时间、链接和个人信息补充。
