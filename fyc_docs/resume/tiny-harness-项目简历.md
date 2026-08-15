# tiny-harness｜Coding Agent Harness（Node.js）

> 以下内容基于项目源码及《从零搭建 Coding Agent Harness：跟着象小码演进一个真 Agent》项目文档提炼。为避免简历表述失实，未虚构线上用户量、QPS、耗时提升或业务指标；“约 3000 行、零第三方运行时依赖”等规模信息以项目文档为准。

## 一句话简介

从零实现一个面向 Coding Agent 的轻量级 Harness：将大模型的文本/工具调用能力接入受控本地工作区，提供 ReAct 调度、多协议 Provider 适配、文件与 Shell 工具、安全审批、会话续传、上下文压缩、错误自愈、链路追踪与 Token 成本估算等能力。

## 技术栈

**Node.js（ESM）｜原生 `fetch`｜`AsyncLocalStorage`｜JSONL｜CLI / readline｜OpenAI-compatible API｜Anthropic Messages API**

---

## 简历项目经历（推荐版）

### Coding Agent Harness｜个人项目

**项目背景：** 面向 Coding Agent 的极简运行时框架。以“模型负责推理、Harness 负责执行与治理”为核心，解决模型无法直接操作本地文件、跨模型协议不兼容、长任务上下文膨胀、风险操作不可控及执行过程不可观测等问题。

**个人职责与成果：**

- **搭建 ReAct Agent 主循环**：实现“LLM 决策 → 工具调用 → 结果回灌 → 下一轮决策”的闭环；支持可选的 Thinking / Action 两阶段执行，并使用无工具调用作为任务终止条件，使模型可基于工具观察结果持续规划和纠错。
- **抽象多模型 Provider 层**：设计统一的 `Message`、`ToolCall`、`ToolDefinition` 等内部领域模型，隔离引擎与供应商协议；完成 OpenAI-compatible 与 Anthropic 两套协议的双向转换，支持通过 CLI / 环境变量切换模型，无需改动 Agent 引擎。
- **构建可扩展工具运行时**：设计 `Registry` 统一管理工具注册、工具描述下发、按名称路由与异常归一化；接入读文件、写文件、精确/模糊编辑、Shell 等工具，并以 `Promise.all` 并发执行同一轮多个 Tool Call，按 `callId` 精确回填结果。
- **强化工具可靠性与安全边界**：为文件/Shell 工具加入工作区路径约束、输出截断与超时控制；针对模型生成的编辑片段易出现换行、空白、缩进差异的问题，实现四级渐进式模糊替换（精确匹配 → 换行归一化 → trim → 逐行去缩进），提升编辑成功率；基于 Middleware 构建危险操作人工审批，并提供 YOLO 模式切换。
- **实现长任务上下文与断点续传**：基于 JSONL 增量持久化会话消息、Token 与费用元数据，支持按 Session ID 恢复；实现最近工作记忆提取与无主工具结果清理，结合分层 Compactor 对早期工具输出、早期推理和近期长输出差异化压缩，在保留系统约束与关键信息的同时控制上下文规模。
- **完善 Agent 稳定性机制**：将工具失败归一化为可回灌给模型的 `ToolResult`，通过 `RecoveryManager` 注入针对性修复提示；配合重复调用检测与 Reminder 注入，降低模型在相同错误或调用中循环的风险；提供 Plan Mode，将任务计划和进度外化到文件，支持长任务恢复。
- **建立可观测与成本治理能力**：基于 `AsyncLocalStorage` 实现自动父子关联的 Span 树，覆盖 Agent Run、Turn、LLM 调用和工具调用，并导出 JSON Trace；以装饰器模式封装 Provider，记录调用延迟、输入/输出 Token 与基于价格快照的费用估算，累计到 Session 并支持 CLI 查询。

**项目规模：** 约 3000 行 Node.js 代码、零第三方运行时依赖；覆盖 Mock 演示与真实模型调用链路。

---

## 简历项目经历（精简版，适合一页简历）

### Coding Agent Harness｜Node.js 个人项目

- 从零实现轻量级 Coding Agent 运行时，基于 ReAct 构建“模型决策—工具执行—结果回灌”闭环，支持可选慢思考、并发工具调用及多轮 CLI 交互。
- 设计 Provider 抽象与统一消息协议，兼容 OpenAI-compatible / Anthropic API；通过 Registry + Middleware 构建文件、Shell 工具系统及人工审批安全边界。
- 基于 JSONL 完成会话持久化与断点续传，结合分层上下文压缩、Plan Mode、错误自愈和死循环提醒，提升长任务可恢复性与执行稳定性。
- 使用 `AsyncLocalStorage` 构建调用 Span 树，并以 Provider 装饰器统计延迟、Token 和费用；项目约 3000 行、零第三方运行时依赖。

---

## 面试展开版本（按模块讲项目）

### 1. 你解决的核心问题是什么？

大模型本身只能生成文本或结构化的工具调用意图，不能直接访问本地文件系统、执行命令，也无法天然处理记忆、安全、成本和调试问题。项目将这些运行时能力组织成 Harness，让模型成为“决策者”，而运行时成为“受控执行层”。

### 2. 主链路如何工作？

1. CLI 解析模型、工作目录、会话和运行模式；
2. Engine 拼装 System Prompt 与 Working Memory，向 Provider 请求模型响应；
3. 模型返回文本或 `ToolCall[]`；
4. Engine 将工具调用交由 Registry；Registry 完成路由、审批和真实执行；
5. 执行结果以带原始 `toolCallId` 的 `ToolResult` 返回，并写入 Session；
6. 模型在下一轮读取观察结果，继续调用工具或输出最终答案；
7. 运行结束后持久化 Session，并导出全链路 Trace。

### 3. 为什么要做 Provider 抽象？

不同供应商不仅 URL 不同，消息结构、System Prompt 位置、工具定义字段、工具结果格式和 Token 统计字段也不同。项目将这些差异收敛至 Provider：引擎只处理统一内部对象，切换协议不会污染 ReAct 循环或工具层。

### 4. 工具如何既可扩展又安全？

`Registry` 用 `Map<toolName, tool>` 路由真实工具，同时将每个工具的 JSON Schema 聚合后交给模型。执行时先按顺序运行 Middleware，任意一个拒绝都会短路，真实工具不会执行；成功、拒绝、未知工具和工具异常均被统一封装为 `ToolResult`，让模型可在下一轮感知问题并调整策略。

### 5. 长任务如何避免“忘事”和“爆上下文”？

- **会话层：** JSONL 增量落盘，恢复时容忍异常半行；
- **工作记忆层：** 截取近期消息，并移除没有对应 Tool Call 的孤儿工具结果；
- **上下文层：** System Prompt 永远保留；早期长工具输出替换为摘要标记，近期长输出保留头尾；
- **任务状态层：** Plan Mode 将计划与完成状态写入文件，进程恢复后可继续推进。

### 6. 可观测性如何实现？

通过 `AsyncLocalStorage` 在异步调用链中隐式传递当前 Span：新 Span 自动挂到当前父 Span 下，不需要在每层函数手动传递 parent。调用结束后导出 JSON 树；`CostTracker` 采用装饰器模式包裹 Provider，在不修改引擎的前提下采集调用时延、Token 和费用估算。

---

## 可替换表达（按目标岗位选择）

### 偏 AI Agent / LLM 应用岗位

突出关键词：**ReAct、Function Calling、Agent Runtime、Context Engineering、Tool Use、Multi-provider、Human-in-the-loop、Observability**。

### 偏后端 / 平台工程岗位

突出关键词：**分层架构、接口抽象、Middleware、责任链、装饰器、异步并发、持久化、可观测性、故障恢复、安全边界**。

### 偏全栈 / 工程效率岗位

突出关键词：**CLI、Coding Agent、文件编辑、Shell 执行、任务规划、断点续传、研发提效、开发者体验**。

---

## 使用提醒

- 若简历需要写明时间、团队、个人角色或开源链接，请根据实际情况补充，避免将个人项目写成生产业务系统。
- 目前项目资料未提供真实线上使用量、性能压测结论、成功率、成本节省等数据，因此不建议写“提升 XX%”“服务 XX 用户”等量化结果。
- “约 3000 行、零第三方运行时依赖”来自项目文档；若最终投递前代码规模变化，可按最新仓库统计结果更新。