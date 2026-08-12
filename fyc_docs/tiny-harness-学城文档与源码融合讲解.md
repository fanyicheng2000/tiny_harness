# tiny-harness：学城教程与项目源码融合讲解

> 对照来源：学城《从零搭建 Coding Agent Harness：跟着象小码演进一个真 Agent-副本》（contentId: `2778797150`）
>
> 对照仓库：当前 `tiny-harness` Node.js 实现。本文不复述概念，而是按“问题 → 代码落点 → 一次运行如何流动 → 工程取舍”把教程和可执行代码连起来。

## 目录与阅读路线

本项目把大模型当作“CPU”，把 `src/` 当作给 CPU 配套的微型操作系统：

- `src/engine/loop.js`：调度心脏，负责持续执行“想 → 调工具 → 观察”。
- `src/provider/`：协议适配层，隔离 OpenAI/Claude/Mock 的消息格式差异。
- `src/tools/`：文件系统与 Shell 外设驱动，并负责路径、输出和超时边界。
- `src/context/`：会话、提示词、压缩、失败恢复和技能加载，即 Agent 的记忆与规则系统。
- `src/observability/`：调用树和费用累计。
- `src/index.js`：CLI 组合根，选择 Provider、注册工具、安装审批、启动单轮或 REPL。

建议先运行 `npm start` 看一次离线 Mock 链路；再读第 01、03、07、11、15 讲。所有示例均可通过 `npm run demo:1` 到 `npm run demo:6` 单独验证。

---

# 第一章：ReAct 主循环——模型为什么会“自己继续做事”

## 教程中的问题

直接调用一次 `fetch` 只能得到一段文本；模型即使说“我需要读 `README.md`”，程序也不会替它读。学城教程把这个缺口归纳为 ReAct：模型输出动作，Harness 执行动作，再把观察结果回喂模型。

## 源码落点

核心在 `src/engine/loop.js` 的 `AgentEngine.run()` 与 `_runOneTurn()`：

1. `run()` 先创建 `PromptComposer`，生成固定的 system message。
2. 外层 `while (true)` 逐轮调用 `_runOneTurn()`。
3. `_runOneTurn()` 从 Session 取工作记忆、补上 system prompt 后调用 `provider.generate()`。
4. 模型响应会被统一封装成 `Message` 并写回 `session`。
5. 若 `actionResp.toolCalls` 为空，返回 `true`，外层循环退出；否则进入工具执行并返回 `false`。

这里的退出条件并非关键词匹配，而是**模型不再提出工具调用**。这是 Agent 循环最小而通用的停止协议。

## 消息如何成为模块间的共同语言

`src/schema/message.js` 的 `Message`、`ToolCall`、`ToolResult` 是这条链路的内存数据模型。特别要注意：工具结果用 `role: user` 加 `toolCallId` 表示，这一内部表达随后由 Provider 翻译为不同厂商真正需要的 tool-result 格式。引擎因此不需要知道 HTTP 协议细节。

## 一次 Mock 演示的真实流动

执行 `node src/index.js --provider mock --script read-file` 时，`src/index.js` 先把用户任务追加为 `Role.USER`。Mock Provider 的第一条脚本响应请求 `read_file`；引擎调用注册表得到文件内容，并将内容作为带同一 `toolCallId` 的观察消息追加；第二轮 Mock 不再返回工具调用，循环结束。由此，所谓“模型自己读下一个文件”其实是 Harness 每轮重新把最新观察交给模型后的选择。

---

# 第二章：Provider 抽象——换模型而不改引擎

## 教程中的问题

OpenAI 兼容接口把调用放在 `tool_calls` 数组中；Claude 则使用 content block 里的 `tool_use`，system prompt 与 tool result 的位置也不同。若把这些格式写进循环，切模型就会牵动整个引擎。

## 源码落点

`src/provider/interface.js` 用 `BaseProvider.generate(messages, availableTools)` 定义内部契约。`AgentEngine` 只依赖此方法，完全不导入 OpenAI 或 Claude 的 HTTP 格式。

- `src/provider/openai.js`：`toOpenAIMessages()` 将内部消息映射为 Chat Completions 格式；`generate()` 把内部 `ToolDefinition` 变为 `tools[].function`，响应再还原为 `Message + ToolCall + Usage`。
- `src/provider/claude.js`：`toClaudeMessages()` 将 system message 从消息序列抽到顶级 `system` 字段；连续工具结果合并成一条 user message 的多个 `tool_result` block，并保留 `is_error`。
- `src/provider/mock.js`：提供可预期的脚本响应，使循环、并发、审批等机制能离线教学和回归。

## 关键实现细节

OpenAI 返回的工具参数是 JSON 字符串，`parseToolArguments()` 做容错解析；Claude 返回的是对象，直接作为 `ToolCall.arguments`。两者最后都被压平为相同的内部对象，这就是“反腐层”的价值。

`src/index.js` 的 `buildProvider()` 还实现了 `auto` 策略：优先从环境变量选择 Claude，再选择 OpenAI；之后统一套上 `CostTracker`。Provider 的可替换性不只在 HTTP 调用，也体现在上层装饰器与引擎均无感。

---

# 第三章：Tool Registry——工具如何接入与执行

## 教程中的问题

模型只会产出诸如 `read_file({ path: "..." })` 的意图，不能直接访问本机。Harness 必须把“模型可见的工具声明”与“真实 JavaScript 实现”绑定，并处理未知工具、异常和未来的安全策略。

## 源码落点

`src/tools/registry.js` 的 `Registry` 负责三件事：

1. `register(tool)` 以 `tool.name()` 为键保存实现；
2. `getAvailableTools()` 调用每个工具的 `definition()`，将 JSON Schema 发送给模型；
3. `execute(call)` 按名称路由、依次经过 middleware、再执行真实工具。

## 为什么失败不直接抛到引擎

`Registry.execute()` 会把未知工具、拦截和执行异常全部转换为 `ToolResult({ isError: true })`。这不是掩盖错误，而是让错误成为下一轮模型上下文的一部分。模型可据此改参数、换工具或结束任务；第 11 章的 Recovery 和 Reminder 也正是消费这个 `isError` 信号。

## 工具接口的隐含约束

每个工具实现同一形状：`name()`、`definition()`、`execute(args)`。其中 definition 的 `inputSchema` 是“给模型的 API 文档”；execute 才是实际能力。`src/index.js` 在构建阶段注入同一个 `workDir`，因而所有文件类工具可以共享工作区边界，而不是让模型任意传绝对路径。

---

# 第四章：工具边界——截断、超时、路径三道防线

## 教程中的问题

工具一旦能触碰真实环境，失败模式会从“答错”升级为“上下文爆掉、命令卡死、越界读写”。教程强调 Harness 不能假设模型输入总是安全或完整。

## 源码落点与实现

### 1. 路径边界

`src/tools/path-utils.js` 的 `resolveWorkspacePath()` 先用 `path.resolve(workDir, requestedPath)` 规范化，再以 `path.relative()` 拒绝 `..` 和绝对路径逃逸。对于已有文件，`assertExistingPathInsideWorkspace()` 再执行 `realpathSync()`，防止工作区内的符号链接把读取或编辑引向工作区外。

这是一道路径 guard，而不是容器沙箱：`README.md` 也明确说明 bash 仍拥有 Node 进程本身的系统权限。

### 2. 输出截断

`ReadFileTool` 在 `src/tools/read-file.js` 中把单文件读取限制为 8000 字符；`BashTool` 在 `src/tools/bash.js` 中以 UTF-8 字节计算，超过 8000 字节时保留头尾各 4000 字节。前者优先让模型看到文件开头，后者保留尾部错误信息，符合两个来源的常见诊断需求。

### 3. 命令超时

`BashTool` 不用阻塞式 `execSync`，而是 `spawn('sh', ['-c', command])` 收集 stdout/stderr，并用 `setTimeout()` 在默认 30 秒后 `SIGKILL`。非零退出码、超时和 spawn 错误都会 reject，随后由 Registry 转换成 `isError` 观察结果。

### 4. 写入与局部编辑的取舍

`write_file` 会自动 `mkdir` 并整体覆盖，适合新文件；已有大文件更应该走 `edit_file`，以减少误覆盖面。这一分工也被 PromptComposer 的核心纪律写进 system prompt。

---

# 第五章：Edit 容错——为什么是四级 fuzzyReplace

## 教程中的问题

模型生成的 `old_text` 经常只差缩进、换行或首尾空白。仅使用精确替换会频繁失败；一上来模糊替换又可能误改多处相似代码。

## 源码落点

`src/tools/edit-file.js` 里的 `fuzzyReplace()` 按风险从低到高执行四层匹配：

1. **L1 精确匹配**：仅当出现一次才替换；多次命中立即要求更多上下文。
2. **L2 换行归一化**：将 `\r\n` 统一成 `\n`，处理 Windows/Unix 差异。
3. **L3 首尾 trim**：只放宽 old_text 两端的无意义空白。
4. **L4 逐行 trim**：滑动窗口比较每一行去缩进后的文本，仍要求全文件唯一命中。

`lineByLineReplace()` 即使在最宽松层也维护 `matchCount`，零命中和多命中都是错误。这体现了教学文档中的原则：容错不是“猜到就改”，而是“放宽格式条件，但绝不放弃唯一性”。

## 运行结果如何反馈给模型

编辑前会通过路径工具验证真实目标，再读原文；编辑后写回同一路径。若失败，Registry 返回 `isError=true`，随后 `RecoveryManager` 会针对“未找到 old_text”提示重新读取文件，针对“多处匹配”提示补足上下文。这样失败不是盲目重试，而是转化为下一步行动建议。

---

# 第六章：并发执行——单轮多个工具为什么能并行

## 教程中的问题

当模型一轮同时要求读多个独立文件，串行执行会把总耗时变成各调用时长之和。Node.js 的异步模型适合让互不依赖的 I/O 并发。

## 源码落点

`AgentEngine._runOneTurn()` 对 `actionResp.toolCalls` 使用 `Promise.all(toolCalls.map(...))`。每项任务负责：报告开始、创建 `Tool.<name>` span、交给 Registry、错误增强、报告结束，并返回 `{ message, result, call }`。

等待 `Promise.all` 完成后，代码才一次性把 `observationEntries.map(e => e.message)` 写入 Session。这个“先并行执行、后成批提交观察”的结构有两个收益：

- 后续一轮只会看到完整的一组工具结果，不会在一半结果到达时提前推理；
- 每条结果保留模型原始的 `call.id`，Provider 能将其精确回填给对应请求。

## 边界与取舍

并发不代表所有工具都适合并发：两个写同一文件仍可能竞争。本项目遵循“模型同轮声明的调用视为可并行”的教学简化，生产系统通常需要给工具标注读写资源、依赖图或互斥策略。与此同时，`runRepl()` 使用 Promise 链 `pending` 串行化**用户轮次**，避免 stdin 一次灌入多行时并发启动多个 Agent 回合。

---

# 第七章：Session 持久化——工作记忆与长期记录分离

## 教程中的问题

进程重启后仍要继续任务；但每次模型调用又不能无限携带全部历史。学城教程将“完整历史”和“本轮可见工作记忆”分开。

## 源码落点

`src/context/session.js` 的 `Session` 保存完整 `history`、Token 和价格累计；`getWorkingMemory(limit = 20)` 只返回最后 N 条给引擎。`AgentEngine` 每轮通过它构造输入，而不是直接使用 `history`。

## 工具结果截断边缘

若最近 N 条恰好从工具结果开始，就会出现只有 `toolCallId`、却没有前序 assistant tool call 的无主结果。这对某些 Provider 是非法会话。`getWorkingMemory()` 用 while 循环剔除开头这种消息；`loop.js` 又在截断结果首条不是 user 时补一个占位 user message，形成跨协议兼容的双层防御。

## 为什么是 JSONL

`save()` 将会话写到 `<workDir>/.tiny-harness/sessions/<id>.jsonl`：每行是 meta 或 message。首次写入/历史缩短时采用临时文件 + rename 全量重写；常规情况仅追加新消息和最新 meta。加载时逐行 JSON parse，坏行跳过、最后一条 meta 生效。因此进程在追加中断，通常只损失最后半行，而不会损坏整份历史。

`SessionManager.getOrCreate()` 再按 session id 缓存实例；CLI 的 `--session` 便是断点续传入口。

---

# 第八章：上下文压缩——保留最近证据，折叠旧噪声

## 教程中的问题

Session 能无限增长，但模型上下文和费用不能。直接删除历史会让模型忘记已完成的动作；完整保留又会导致上下文爆炸与“中间信息遗忘”。

## 源码落点

`src/context/compactor.js` 的 `Compactor(200000, 6)` 在每轮请求前调用。低于 200000 字符直接返回原消息；超过阈值后分层处理：

- `Role.SYSTEM` 永不压缩，保证身份和纪律始终存在；
- 最近 6 条内的长工具结果保留首尾各 500 字符；
- 更早的超长工具结果替换为带原始长度的清理标记；
- 更早的长 assistant 推理折叠为固定提示。

## 它与 Session 的关系

压缩的是发给 Provider 的 `contextHistory` 副本，而不是 `session.history`。因此断点续传仍保有原始事实，下一轮也可以根据需要取新的工作记忆。这是“长期存储不丢、短期上下文可控”的职责分离。

当前实现是启发式字符压缩而非 LLM 摘要；优点是零额外调用、行为稳定，缺点是不会提炼语义事实。真实系统可在此接口后替换为可验证的摘要器。

---

# 第九章：Plan Mode——把长程状态外化为文件

## 教程中的问题

长任务不能只靠模型短期上下文记住计划；压缩、重启或跑偏都会让任务状态丢失。教程的解法是让 Agent 主动维护 `PLAN.md` 与 `TODO.md`。

## 源码落点

Plan Mode 的实现不是另写调度器，而是 `src/context/composer.js` 在 `planMode` 为真时对 system prompt 注入强制流程：

1. 启动先检查 `PLAN.md` 和 `TODO.md`；
2. 新任务先创建计划和 checkbox 待办；
3. 恢复任务先读取已有状态、找到第一个未完成项；
4. 每完成一步立即把对应项打勾；迷失时重新读取 TODO。

`src/index.js` 将 `--plan` 传给 `new AgentEngine(..., args.plan)`，引擎再传给 `PromptComposer`。也就是说 Plan Mode 的状态机主要由**提示词纪律 + 文件工具 + Session**共同实现，而非框架强行解释 Markdown。

## 工程意义

这种设计成本低、文件人类可读，且能和 Git 一起审查；代价是模型可能不遵守纪律。生产级实现可在工具层观察 TODO 修改、把计划转为结构化状态机，但本项目清晰展示了最小可用版本如何构成闭环。

---

# 第十章：System Prompt 三层注入——静态规则、项目规则、动态技能

## 教程中的问题

一个通用 Agent 需要基本安全和工作规范；不同仓库又有独特约定；某些任务还需要按需加载专门说明。把它们全部硬编码或全部交给用户都不可维护。

## 源码落点

`PromptComposer.build()` 采用三层拼装：

1. **核心层**：硬编码身份及六条纪律，例如编辑前先读、写新文件用 write_file、工具报错看 stderr。
2. **项目层**：若工作区有 `AGENTS.md`，同步读取并附加到 prompt。
3. **技能层**：`SkillLoader.loadAll()` 读取 `.tiny-harness/skills/*/SKILL.md` 的动态内容。

Plan Mode 是条件附加的强化段落，不是额外的第四套来源。

## 一次调用中的位置

`AgentEngine.run()` 在进入循环前只构造一次 `systemMsg`，之后每轮都放在 `contextHistory` 首位；Compactor 又保证它不会被压缩。于是动态规则不会因为长任务而消失，项目规则也不必散落在每个工具中。

---

# 第十一章：失败处理——Recovery 软引导与 Reminder 硬干预

## 教程中的问题

“工具报错后让模型再试一次”很容易变成同一参数无限重试。系统需要既保留原始诊断，又在重复失败时强制改变策略。

## 第一层：错误自愈

`src/context/recovery.js` 的 `RecoveryManager.analyzeAndInject()` 根据工具名和错误文本追加救援指南：

- edit 找不到片段：重新 `read_file` 获取最新内容；
- edit 命中多处：增加 old_text 上下文；
- 文件不存在：先用 `ls` 或 `find`，不要猜路径；
- bash 命令不存在、超时、语法错：分别提示替代命令、后台运行或检查转义。

`loop.js` 仅在 `result.isError` 时调用它，增强后的文本作为工具观察写回会话。原始 stderr 没有被丢弃，提示只是补充。

## 第二层：死循环检测

`src/engine/reminder.js` 的 `ReminderInjector` 用 `MD5(toolName + JSON.stringify(arguments))` 生成调用指纹。在同一指纹连续失败达到 3 次时，向会话追加一条强烈的 user message，要求停止重试、换策略或向人求助；任意一次成功会清空计数。

当前主循环按教程简化，使用一组并发结果中的第一项进行提醒检测。若扩展到生产场景，应对每个并发调用独立检测并防止 reminder 本身膨胀。

---

# 第十二章：人类审批——中间件为何是正确挂点

## 教程中的问题

读文件通常低风险，写文件、编辑文件和执行 Shell 则可能不可逆。审批若写在每个工具内部，会重复逻辑；若写在模型输出之后又可能漏掉工具。

## 源码落点

Registry 的 middleware 链正位于“找到工具”与“执行工具”之间。`src/index.js` 的 `makeApprovalMiddleware()` 返回一个闭包：

- 只对 `bash`、`write_file`、`edit_file` 询问；
- `y` 放行一次，`n` 返回拒绝原因，`a` 将本次运行切换为全部放行；
- 返回 `{ allowed, rejectReason }`。

`Registry.execute()` 依次 `await` 中间件；被拒绝时返回 `ToolResult(isError: true)`，让模型明确看到用户拒绝而非误以为工具消失。

## CLI 策略

`src/index.js` 让真实 Provider 默认审批，Mock 默认 YOLO 以便无交互跑 demo；`--require-approval` 和 `--auto-approve/--yolo` 显式改变策略。REPL 的 `/yolo` 会清空当前 middleware，演示了权限状态可在一段会话内切换。

注意 `promptUser()` 使用 readline Promise，但 `makeApprovalMiddleware()` 当前直接返回该 Promise，Registry 的 `await mw(call)` 正好兼容。注释里的“同步阻塞读 stdin”描述的是审批语义，实际 Node 实现仍是异步等待。

---

# 第十三章：可观测性——把黑盒循环还原成 Span 树

## 教程中的问题

Agent 一次任务会有多轮模型调用和多个工具调用。没有时间、Token、费用和父子关系，无法判断慢在哪里、贵在哪里、为何失败。

## Trace 实现

`src/observability/trace.js` 定义 `Span`：名称、起止时间、属性和 children。`startSpan()` 从 `AsyncLocalStorage` 取当前父 span，将新 span 自动挂到父节点，并通过 `traceStorage.run()` 保证异步调用链仍可取得正确上下文。

`loop.js` 的层级是：`Agent.Run` → `Turn-N` → `LLM.Thinking/LLM.Action/Tool.<name>`。运行结束时 `exportTraceToFile()` 输出到 `.tiny-harness/traces/trace_<session>_<timestamp>.json`，可直接回放树结构。

## CostTracker 装饰器

`src/observability/tracker.js` 的 `CostTracker extends BaseProvider` 包装真实 Provider：先记录开始时间，再代理 `generate()`，读取统一的 `Usage`，根据 `PRICE_SNAPSHOTS` 估算金额并调用 `session.recordUsage()`，最后把模型、Token、估算金额写入当前 Span。

因为装饰器仍满足 Provider 契约，`AgentEngine` 不需要为可观测性增加条件判断。这也为限流、缓存、重试等横切能力提供了同样的扩展模型。

---

# 第十四章：慢思考两阶段——为什么先不传工具

## 教程中的问题

模型在看到工具列表后可能过早行动，直接调用工具而没有先分析目标与依赖。教程采用显式的两阶段调用，让推理与行动分离。

## 源码落点

在 `_runOneTurn()` 中，`enableThinking` 为真时：

1. **Thinking Phase**：`this.provider.generate(contextHistory, null)`，第二参数是 `null`，所以 Provider 不传 tools；模型输出的纯文本被保存在 `currentTurnThinkingContent`，并临时 append 到本轮 context。
2. **Action Phase**：`this.provider.generate(contextHistory, availableTools)`，这次才提供 Registry 的工具定义；模型可以根据前一步推理选择工具或直接回答。
3. 两段文本合并进一个最终 assistant message，动作中的 toolCalls 也一并写入 Session。

这不是厂商的 Extended Thinking API，而是 Harness 自己控制的两次普通调用，因此能跨 OpenAI/Claude 协议工作，也会带来额外延迟和 Token 成本。

## 使用场景

对于简单“读一个文件”任务，慢思考通常得不偿失；对于多文件改造、方案比较、风险较高的写操作，它能降低仓促调用概率。CLI 的 `--thinking` 和 REPL 的 `/think` 都会切换 `engine.enableThinking`。

---

# 第十五章：端到端装配——从 CLI 到一次真实编码任务

## 教程中的问题

前十四章是独立机制；真正的 Harness 要证明它们能在同一条调用链上协作，而不是各自孤立存在。

## 装配根：`src/index.js`

`main()` 的顺序就是端到端依赖关系：

1. `loadEnvFile()`：以零依赖方式加载项目根 `.env`；
2. `parseArgs()`：读取 provider、工作目录、session、thinking、plan 和审批开关；
3. `globalSessionMgr.getOrCreate()`：恢复或建立 Session；
4. `buildProvider()`：选择 Mock/OpenAI/Claude；
5. `new CostTracker(...)`：给模型调用加监测；
6. 注册 `ReadFileTool`、`WriteFileTool`、`EditFileTool`、`BashTool`；
7. 按策略安装审批 middleware；
8. 创建 `AgentEngine` 和 `TerminalReporter`；
9. 进入单轮 `runOneTurn()` 或多轮 `runRepl()`。

## 单轮与 REPL 的差异

单轮模式先把 prompt 写入 Session，再 `await engine.run()`，最后无论成功失败都 `session.save()`。REPL 则复用同一 Session 和 Engine，特殊命令可查看花费、历史、切换 Plan/Thinking/YOLO。`enqueue()` 把每个 readline 的 handler 串成 Promise 队列，防止输入过快造成多轮同时读写同一历史。

## 推荐验收步骤

1. `npm test`：验证工具边界、Provider 序列化、Session 等回归。
2. `npm start`：验证最小 ReAct 与 Mock。
3. `npm run demo:2`：观察一轮多工具并发。
4. `npm run demo:3`：检查 Plan Mode 生成和更新的状态文件。
5. `npm run demo:4`：检查重复失败后的 Reminder。
6. 配置 `.env` 后执行 `node src/index.js --provider openai --prompt "请读取 README.md" --thinking --plan`，在确认安全边界后做真实 Provider 验收。

---

# 总结：从 30 行调用到 Harness 的因果链

学城教程的核心不是“预先设计一套大架构”，而是每解决一个故障，就让下一个工程问题显现：一次调用需要循环；循环需要 Provider 统一；工具需要注册与边界；长任务需要记忆、压缩和外部计划；失败需要引导和止损；真实写操作需要人审；复杂运行需要追踪和费用反馈。当前仓库将这条因果链落在可执行的 Node.js 模块中。

阅读或扩展本项目时，请始终沿着 `src/index.js → AgentEngine → Provider/Registry → Session` 的主链追踪；任何新能力都应明确它属于模型协议、工具执行、上下文管理还是横切治理。这样才能在保持教学版简洁的同时，继续把它演进为可靠的 Coding Agent Harness。
