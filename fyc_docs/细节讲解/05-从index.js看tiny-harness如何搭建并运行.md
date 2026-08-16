# 从 `index.js` 看 tiny-harness 如何被搭建并运行

> 本文以 `src/index.js` 为主线，解释 tiny-harness 从一条终端命令启动，到模型调用工具、执行 Multi-Agent 委派、保存会话与导出 Trace 的完整过程。
>
> 阅读目标：读完后应能回答四个问题：
>
> 1. 运行 `node src/index.js ...` 后，程序第一步做什么？
> 2. Provider、Session、工具、审批、Agent 配置、Engine 是怎样装配起来的？
> 3. 用户输入如何进入 ReAct 循环，工具结果又如何回到模型？
> 4. Multi-Agent 配置如何影响主 Agent、子 Agent 的 Prompt、Skill、工具与委派权限？

---

## 1. 总览：`index.js` 是“装配线”，不是业务逻辑中心

`src/index.js` 是这个项目的 CLI 入口。它的职责不是自己实现模型协议、文件读写或 ReAct，而是把这些分散的模块按正确顺序连接起来。

可以把它理解为一个依赖装配器（Composition Root）：

```text
终端命令
  ↓
index.js / main()
  ├── 读取 .env 和 CLI 参数
  ├── 创建或恢复 Session
  ├── 选择 Provider，并套上 CostTracker
  ├── 读取主 Agent 配置
  ├── 创建审批策略
  ├── 创建 AgentEngine
  ├── 按 Agent 配置注册工具
  └── 进入单次执行或 REPL
          ↓
     AgentEngine.run()
          ↓
     ReAct：模型 → 工具 → 工具结果 → 模型
```

模块分工如下：

| 模块 | 主要职责 | `index.js` 如何使用它 |
| --- | --- | --- |
| `provider/*` | 把统一消息转换成 OpenAI / Claude / Mock 协议 | 选择并创建模型客户端 |
| `context/session.js` | 保存会话历史、Token、费用并持久化 JSONL | 根据 `--session` 获取 Session |
| `agents/*` | 定义主/子 Agent 配置及运行时权限 | 生成主 Agent Prompt、工具表、委派关系 |
| `tools/*` | 文件、Skill、Shell、委派等能力 | 根据 Agent 的 `toolNames` 进行注册 |
| `engine/loop.js` | ReAct 主循环和子 Agent 循环 | 接收装配好的 Provider / Registry 后运行 |
| `observability/*` | Token 成本和 Trace | 给 Provider 加成本追踪，Engine 导出 Trace |

核心原则是：**Engine 不应该知道 CLI 参数从哪里来；工具不应该知道模型厂商；Provider 不应该知道哪些工具被授权。** `index.js` 正是将它们组织在一起的地方。

---

## 2. 从命令开始：Node.js 如何进入 `main()`

常见启动命令：

```bash
node src/index.js --provider mock --prompt "读取 package.json" --dir .
```

脚本末尾有真正的启动语句：

```js
main().catch((err) => {
  console.error('未捕获错误:', err);
  process.exit(1);
});
```

含义是：

1. 调用异步函数 `main()`；
2. `main()` 返回 Promise；
3. 如果 Promise 被 reject，即运行期间有未处理异常，则输出错误；
4. 使用非零状态码 `1` 结束进程，让 Shell、CI 或调用方知道执行失败。

这里的 `main().catch(...)` 很重要。因为 `main` 是 `async function`，其中的异常不会像普通同步函数一样直接冒到文件顶层；需要通过 Promise 的 `.catch(...)` 统一处理。

---

## 3. 第一阶段：加载配置来源

### 3.1 `loadEnvFile()`：把 `.env` 转成 `process.env`

`main()` 的第一行：

```js
loadEnvFile();
```

它手动实现了一个极简版 dotenv：

```text
项目根目录/.env
        ↓
逐行读取 KEY=VALUE
        ↓
process.env.KEY = VALUE
        ↓
Provider 创建阶段读取 API Key、模型名、Base URL
```

例如 `.env`：

```dotenv
OPENAI_API_KEY=sk-xxx
OPENAI_MODEL=gpt-4.1
OPENAI_BASE_URL=https://example.com/v1
```

加载后可在任何 Node.js 模块中读取：

```js
process.env.OPENAI_API_KEY
```

实现细节：

- 使用 `fileURLToPath(import.meta.url)` 找到当前 ESM 文件路径；
- 再通过 `path.dirname(...), '..'` 回到项目根目录；
- 忽略空行和 `#` 注释；
- 仅在系统环境中不存在该 Key 时才写入 `.env` 值。

最后一点意味着优先级为：

```text
命令行/操作系统已设置的环境变量
        >
项目 .env 中的同名变量
```

这符合部署环境通常用系统变量覆盖本地文件配置的习惯。

### 3.2 `parseArgs(process.argv)`：把一串字符串变成配置对象

Node 自动提供：

```js
process.argv
```

若执行：

```bash
node src/index.js --provider openai --session task-1 --thinking
```

则它大致是：

```js
[
  '/path/to/node',
  '/path/to/src/index.js',
  '--provider',
  'openai',
  '--session',
  'task-1',
  '--thinking',
]
```

`parseArgs` 从下标 `2` 开始解析，生成统一对象：

```js
{
  prompt: '',
  dir: '.',
  session: 'task-1',
  provider: 'openai',
  thinking: true,
  plan: false,
  requireApproval: false,
  autoApprove: false,
  script: 'read-file',
}
```

支持的参数及其运行含义：

| 参数 | 影响模块 | 作用 |
| --- | --- | --- |
| `--prompt`, `-p` | 输入分支 | 单次直接执行任务 |
| `--dir`, `-d` | Session、工具 | 限定 Agent 工作区 |
| `--session`, `-s` | Session | 指定可恢复的会话 ID |
| `--provider` | Provider | `mock` / `openai` / `claude` / `auto` |
| `--script` | MockProvider | 选择演示剧本 |
| `--thinking` | AgentEngine | 启用两阶段慢思考 |
| `--plan` | Prompt / Engine | 注入长程任务计划约束 |
| `--require-approval` | Registry middleware | 强制危险工具人工审批 |
| `--auto-approve`, `--yolo` | Registry middleware | 跳过人工审批 |

解析参数后，`main` 立即计算工作区绝对路径：

```js
const workDir = path.resolve(args.dir);
```

后续所有文件工具、Session、Skill、Thread、Trace 都以这个 `workDir` 作为边界或存储根目录。换言之，`--dir` 不是一个普通展示参数，它定义了 Agent 的实际操作空间。

---

## 4. 第二阶段：恢复状态与选择模型

### 4.1 Session：一次任务的长期记忆和账本

`index.js` 通过下面一行取得 Session：

```js
const session = globalSessionMgr.getOrCreate(args.session, workDir);
```

含义是：

```text
若内存里已经有该 session ID
  → 复用同一个 Session 对象
否则
  → 尝试加载 .tiny-harness/sessions/<session-id>.jsonl
  → 文件不存在则创建空 Session
```

Session 负责保存：

```text
history                 用户、助手、工具结果等消息
workDir                 本会话对应的工作区
totalPromptTokens       累计输入 Token
totalCompletionTokens   累计输出 Token
estimatedCosts          按币种累计的估算费用
```

这就是为什么下面命令可以断点续传：

```bash
node src/index.js --session fix-login --prompt "继续处理"
```

它会加载 `fix-login` 的历史，而不是开启一段完全无记忆的新对话。

### 4.2 `buildProvider()`：把模型差异收敛到 Provider 层

随后调用：

```js
const { provider: realProvider, modelName } = buildProvider(
  args.provider,
  args.script,
  session
);
```

它根据 `args.provider` 分支：

```text
mock    → MockProvider
openai  → OpenAIProvider
claude  → ClaudeProvider
auto    → 有 Claude Key 则 Claude；否则有 OpenAI Key 则 OpenAI；都没有则报错
```

三个 Provider 对外遵循同一个接口思想：

```js
await provider.generate(messages, availableTools)
```

无论底层使用 OpenAI 的 `tool_calls`、Claude 的 `tool_use`，还是本地预设剧本，Engine 最终拿到的都是项目统一的 `Message` 和 `ToolCall` 对象。

这样 `AgentEngine` 不必写成：

```text
如果 OpenAI 则解析 A 格式
如果 Claude 则解析 B 格式
如果 Mock 则解析 C 格式
```

它只关心：模型是否返回了工具调用。

### 4.3 `CostTracker`：装饰 Provider，而不污染 Provider 实现

Provider 创建后，`index.js` 继续包装：

```js
const trackedProvider = new CostTracker(realProvider, modelName, session);
```

这是一种装饰器（Decorator）结构：

```text
AgentEngine
   ↓ 调用 generate
CostTracker
   ↓ 统计 token / 估算费用
真实 Provider
   ↓ 请求 API 或返回 mock 响应
```

`AgentEngine` 仍然只看到 `generate(...)`，但 Session 会因此累积 Token 和费用。Mock 也走相同链路，只是模型价格为零或无价格配置。

---

## 5. 第三阶段：把平台 Agent 配置变成运行时对象

这一部分是当前项目 Multi-Agent 的装配入口。

### 5.1 默认配置只是教学入口

`index.js` 中：

```js
const agentRegistry = new AgentRegistry(defaultAgentConfig);
const rootAgent = agentRegistry.getRootAgent();
```

`defaultAgentConfig` 位于 `src/agents/default-config.js`，当前用于 CLI 教学演示。真实平台未来可以从数据库、配置服务或 API 下发同构数据。

配置结构为：

```text
Root Agent
├── id / name / description / systemPrompt
├── skillIds
├── toolNames
└── multiAgents
    ├── 子 Agent A：自己的 Prompt、Skill、工具
    └── 子 Agent B：自己的 Prompt、Skill、工具
```

`new AgentRegistry(defaultAgentConfig)` 不只是保存原对象，而会：

1. 创建 `RootAgentDefinition`；
2. 校验主 Agent 公共字段；
3. 将直属子 Agent 转成 `AgentDefinition`；
4. 用 `Map<agentId, AgentDefinition>` 索引子 Agent；
5. 拒绝子 Agent 携带 `multiAgents`。

因此主 Agent 可以调用：

```js
agentRegistry.getSubagent(agentId)
```

而且只会返回它在 `multiAgents` 中显式配置过的直属子 Agent。

### 5.2 为什么先创建空 `Registry`

代码中有一段容易困惑：

```js
let registry = new Registry();
const engine = new AgentEngine(trackedProvider, registry, ...);
// ...
registry = buildAgentRegistry(...);
engine.registry = registry;
```

原因是存在装配依赖环：

```text
RunSubagentTool 需要 engine.runSub()
              ↓
但 Engine 构造函数需要 Registry
              ↓
Registry 最终又要注册 RunSubagentTool
```

构造顺序通过“占位对象 + 回填”解决：

```text
1. 创建空 Registry（占位）
2. 用空 Registry 创建 Engine
3. 有了 Engine 后，构建真正的 Agent Registry
4. 将真正 Registry 回填给 engine.registry
```

这不是业务运行中的动态替换，而是启动装配阶段一次性的依赖解环。

---

## 6. 第四阶段：决定审批策略

工具不是一注册就直接执行。`index.js` 会先决定是否挂载审批中间件：

```js
const shouldApprove =
  args.requireApproval ||
  (args.provider !== 'mock' && !args.autoApprove);

const approvalMiddleware = shouldApprove
  ? makeApprovalMiddleware({ autoApprove: false })
  : null;
```

规则表：

| 场景 | 是否审批 |
| --- | --- |
| `mock` 默认演示 | 否 |
| `mock --require-approval` | 是 |
| `openai` / `claude` 默认 | 是 |
| 真实模型 + `--auto-approve` | 否 |

审批器仅拦截高风险工具：

```js
const APPROVE_NAMES = new Set(['bash', 'write_file', 'edit_file']);
```

当模型请求这些工具时，Registry 会先 `await middleware(call)`。终端用户可输入：

```text
y      仅本次放行
n      拒绝本次
a      本次进程后续全部放行
```

注意中间件返回的是结构化决定：

```js
{ allowed: true }
```

或：

```js
{ allowed: false, rejectReason: '...' }
```

若拒绝，Registry 不执行真实工具，而是构造一个 `ToolResult(isError: true)` 返回给模型。模型能看到拒绝原因，并可选择换方案或询问用户。

---

## 7. 第五阶段：创建 Engine、Reporter 和 Agent 专属工具表

### 7.1 `AgentEngine`：ReAct 的执行者

`index.js` 创建：

```js
const engine = new AgentEngine(
  trackedProvider,
  registry,
  args.thinking,
  args.plan,
  (agentWorkDir, planMode) => buildAgentSystemMessage({
    agent: rootAgent,
    workDir: agentWorkDir,
    planMode,
  })
);
```

参数含义：

| 参数 | 作用 |
| --- | --- |
| `trackedProvider` | 统一模型调用入口，同时记录成本 |
| `registry` | 临时空工具表，随后被真实 Registry 替换 |
| `args.thinking` | 是否先进行无工具的思考阶段 |
| `args.plan` | 是否启用 Plan Mode Prompt 约束 |
| 第五个回调 | 如何按主 Agent 配置构造 System Message |

最后一个箭头函数不是立即执行；它被保存为 `engine.systemMessageFactory`。当 `engine.run(session, reporter)` 真正运行时，Engine 会调用：

```js
this.systemMessageFactory(session.workDir, this.planMode)
```

因此：

```text
session.workDir → agentWorkDir
this.planMode   → planMode
```

回调最终调用 `buildAgentSystemMessage(...)`，将根 Agent 的：

```text
name / description / systemPrompt / skillIds
```

组合为主 Agent 的系统提示词。

### 7.2 `TerminalReporter`：展示过程，而不是参与决策

```js
const reporter = new TerminalReporter();
```

Reporter 用于打印模型响应、工具调用、工具结果和子 Agent 活动。它是观测接口，不控制业务执行；即使 Reporter 不存在，Engine 的核心逻辑仍可运行。

### 7.3 `buildAgentRegistry(...)`：按配置生成工具，不是全量挂载

真正工具表由：

```js
registry = buildAgentRegistry({
  agent: rootAgent,
  workDir,
  engine,
  reporter,
  agentRegistry,
  middleware: approvalMiddleware,
});
engine.registry = registry;
```

生成。

`src/agents/runtime.js` 的规则是：

```text
rootAgent.toolNames
      ↓
只注册声明过的工具
      ↓
每个工具被绑定到 workDir
      ↓
read_skill 再绑定该 Agent 的 skillIds
```

例如主 Agent 配置：

```js
toolNames: ['read_file', 'read_skill', 'write_file', 'run_subagent']
```

则主 Agent 不会自动拥有 `bash` 或 `edit_file`。

对于 `run_subagent`，有额外规则：

```text
只有当前 Agent 是根 Agent，且根 Agent 配置了至少一个子 Agent
→ 才注册 RunSubagentTool
```

这使“主 Agent 可委派、子 Agent 不可再委派”不仅是 Prompt 约定，而且是实际工具可见性限制。

---

## 8. 进入执行：单次模式与 REPL 模式

全部组件装配完成后，`main()` 根据输入决定执行分支：

```text
有 --prompt
  → 单次模式 runOneTurn()

没有 --prompt，且 provider 是 mock
  → 注入固定演示任务，单次执行

没有 --prompt，且是真实 Provider
  → REPL 多轮对话模式 runRepl()
```

### 8.1 `runOneTurn()`：把用户输入写入 Session 后交给 Engine

核心逻辑：

```js
session.append(new Message({ role: Role.USER, content: prompt }));
await engine.run(session, reporter);
session.save();
```

顺序不能颠倒：

```text
先把用户输入保存到 Session
  ↓
Engine 从 Session 取得工作记忆
  ↓
模型才能看到本轮用户任务
```

`finally { session.save(); }` 让成功或失败后的会话状态都尽量落盘，便于排查和断点续传。

### 8.2 `runRepl()`：重复调用 `runOneTurn()`，共用同一个 Session

真实模型未带 `--prompt` 时进入 REPL。终端每输入一行普通文本：

```text
用户输入
  ↓
runOneTurn(text, session, engine, reporter)
  ↓
继续复用同一个 Session
```

因此第二轮模型看到的不仅是第二次输入，还包括第一轮的用户消息、助手消息与工具结果。

REPL 支持：

| 命令 | 作用 |
| --- | --- |
| `/exit`、`/quit` | 退出并打印会话摘要 |
| `/cost` | 查看累计费用与 Token |
| `/history` | 查看消息历史摘要 |
| `/clear` | 清空内存历史 |
| `/yolo` | 清空审批中间件 |
| `/think` | 开关慢思考 |
| `/plan` | 开关 Plan Mode |
| `/help` | 显示帮助 |

REPL 使用 Promise 链 `pending` 串行化所有输入。原因是 readline 的 `line` 事件不会等待 async handler；不串行时，用户快速输入两行，可能让两个 Agent Run 同时操作同一 Session，造成历史和工具调用交错。

---

## 9. `engine.run()` 后真正发生的 ReAct 循环

从 `index.js` 视角，调用只有：

```js
await engine.run(session, reporter);
```

但进入 `src/engine/loop.js` 后，会发生：

```text
1. 构造本轮主 Agent System Message
2. 从 Session 提取工作记忆
3. 调 Provider.generate(messages, tools)
4. 将 Assistant Message 追加进 Session
5. 没有 ToolCall → 结束
6. 有 ToolCall → 并发 Registry.execute(call)
7. 将 ToolResult 写为 Message 追加进 Session
8. 检查重复失败提醒
9. 回到第 2 步
```

可以抽象为：

```text
User Message
    ↓
LLM / Provider
    ↓
Assistant Message + ToolCalls
    ↓
Registry + Middleware
    ↓
ToolResult Messages
    ↓
Session
    ↓
下一次 LLM 调用
```

工具定义传给模型的来源是：

```js
registry.getAvailableTools()
```

工具真正执行的入口是：

```js
registry.execute(call)
```

这两个行为分开很重要：模型只能“看见”被注册的工具；即使模型凭空生成未注册工具名，Registry 仍会返回错误 ToolResult，而不会执行任何未知能力。

---

## 10. Multi-Agent 如何从主 Agent 流向子 Agent

### 10.1 主 Agent 先看到 `run_subagent`

如果根 Agent 有直属子 Agent，运行时会注册 `RunSubagentTool`。主模型因此能看到类似工具：

```js
run_subagent({
  agent_id: 'tiny-harness-worker',
  task: '定位认证失败的调用链并给出文件与行号',
  thread_id: 'optional-thread-id',
})
```

### 10.2 目标 Agent 必须来自主 Agent 的 `multiAgents`

`RunSubagentTool.execute()` 通过：

```js
agentRegistry.getSubagent(args.agent_id)
```

查找目标。它只从根 Agent 的 `multiAgents` Map 中取值；模型不能临时写一个任意 ID 来创建新 Agent。

### 10.3 子 Agent 获得独立 Prompt、Skill、Registry

`run_subagent` 不会把主 Registry 直接传给子 Agent，而是针对目标子 Agent：

```text
子 Agent.systemPrompt
子 Agent.skillIds
子 Agent.toolNames
子 Agent.maxTurns
```

重新构建：

```text
Child System Prompt
Child Tool Registry
Child Skill Catalog
```

特别是：

```text
子 Agent 即使 toolNames 里错误出现 run_subagent
→ createChildRegistry 也会跳过
→ 子 Agent 永远没有继续委派权限
```

子 Agent 可以有写工具。是否允许写完全由该子 Agent 的 `toolNames` 决定；若主运行时挂载了审批中间件，子 Agent 的高风险工具也会经过同一个 middleware。

### 10.4 `engine.runSub()`：子 Agent 的独立 ReAct 循环

目标子 Agent 通过：

```js
engine.runSub(task, childRegistry, reporter, options)
```

执行。它使用独立上下文，而非直接污染主 Session：

```text
主 Session
  └── 保存 run_subagent 的 ToolResult（即最终报告）

子 Thread
  └── 保存子 Agent 自己的 system/task/assistant/tool 历史
```

`agent_id` 与 `thread_id` 承担的是两个不同层面的身份：

| 字段 | 表示什么 | 是否允许重复 |
| --- | --- | --- |
| `agent_id` | 子 Agent 的角色/配置模板，例如 `worker`、`reviewer` | 允许；同一角色可创建多个实例 |
| `thread_id` | 某一个具体子 Agent 实例的上下文与持久化线程 | 同一时刻不允许重复运行 |

若调用方**不传** `thread_id`，`RunSubagentTool` 会为每次委派自动生成：

```text
<agent_id>-<randomUUID()>
```

例如主 Agent 同一轮并发委派三个同类型任务：

```js
run_subagent({ agent_id: 'worker', task: '处理分片 A' })
run_subagent({ agent_id: 'worker', task: '处理分片 B' })
run_subagent({ agent_id: 'worker', task: '处理分片 C' })
```

实际会产生三个独立实例：

```text
worker-550e8400-e29b-41d4-a716-446655440000
worker-02e71b9b-6db7-4b71-8a2e-07cd3e24b6ab
worker-920c448f-76a4-49ea-b4b6-9d3a73f20c55
```

它们拥有相同的角色 Prompt、Skill 和工具权限，但各自的上下文、工具过程和 JSONL 文件完全隔离：

```text
.tiny-harness/threads/<自动生成的 thread_id>.jsonl
```

因此，即使三个调用发生在同一毫秒，也不会因为旧实现中的时间戳碰撞而被误判为同一个运行实例；主 ReAct 循环可通过 `Promise.all()` 并发等待三份报告。

如果希望**续接某一个既有子 Agent 的记忆**，才由调用方显式传入稳定的 `thread_id`：

```js
run_subagent({
  agent_id: 'worker',
  thread_id: 'login-review-001',
  task: '继续核对上一轮发现的异常处理问题',
})
```

下次相同 `thread_id` 的任务会加载旧历史，形成连续子任务。

为避免同一个实例并发写同一个 JSONL，`RunSubagentTool` 使用 `activeThreads` 集合：

```text
相同显式 thread_id 正在执行
→ 第二次请求被拒绝

不同 thread_id（包括同 agent_id 自动创建的 UUID Thread）
→ 可以并发执行
```

也就是说，当前实现支持：

```text
一个角色模板（同一个 agent_id）
  ├── 多个独立实例并发处理同类/分片任务
  └── 一个指定 thread_id 串行续接长期任务
```

子 Agent 最终不再调用工具时，`runSub` 返回其文本。该文本会作为 `run_subagent` 的 ToolResult 返回主 Agent，主 Agent 可继续整合、追问或执行后续工具。

---

## 11. Session、Thread、Trace 三类落盘文件的区别

| 数据 | 存储位置 | 用途 |
| --- | --- | --- |
| 主 Session | `.tiny-harness/sessions/<id>.jsonl` | 主对话、主工具结果、费用与 Token |
| 子 Thread | `.tiny-harness/threads/<thread-id>.jsonl` | 子 Agent 的可续接上下文 |
| Trace | `.tiny-harness/traces/trace_<session>_<timestamp>.json` | 本次运行的调用树与耗时 |

它们的关系：

```text
主 Session: 用户要求“审查认证模块”
  ↓
主 Agent 调用 run_subagent
  ↓
子 Thread: 子 Agent 读取文件、形成审查报告
  ↓
主 Session: 收到子报告 ToolResult，形成最终回答
  ↓
Trace: 记录上述模型调用、工具调用、子 Agent Span 的时间树
```

这三个文件服务不同目标，不能相互替代：

- Session 是“主任务记忆”；
- Thread 是“子 Agent 记忆”；
- Trace 是“执行诊断记录”。

---

## 12. 一次完整运行的时序示例

命令：

```bash
node src/index.js \
  --provider openai \
  --session review-login \
  --prompt "请审查登录模块的异常处理" \
  --dir .
```

执行时序：

```text
Shell
  │
  ├─ Node 执行 src/index.js
  │
  ├─ main()
  │   ├─ loadEnvFile()
  │   ├─ parseArgs(process.argv)
  │   ├─ getOrCreate('review-login', workDir)
  │   ├─ buildProvider('openai')
  │   ├─ new CostTracker(...)
  │   ├─ new AgentRegistry(defaultAgentConfig)
  │   ├─ new AgentEngine(...)
  │   └─ buildAgentRegistry(rootAgent, ...)
  │
  ├─ runOneTurn(prompt, ...)
  │   ├─ session.append(User Message)
  │   └─ engine.run(session, reporter)
  │       ├─ buildAgentSystemMessage(rootAgent)
  │       ├─ provider.generate(..., root tools)
  │       ├─ 模型返回 run_subagent ToolCall
  │       ├─ RunSubagentTool.execute()
  │       │   ├─ getSubagent(agent_id)
  │       │   ├─ createChildRegistry(child toolNames)
  │       │   └─ engine.runSub(...)
  │       │       ├─ provider.generate(..., child tools)
  │       │       ├─ child read_file / bash / edit_file ...
  │       │       └─ 返回子 Agent 报告
  │       ├─ 将报告写为主 Session ToolResult
  │       ├─ provider.generate(..., root tools)
  │       └─ 模型输出最终答案，无 ToolCall，结束
  │
  ├─ session.save()
  ├─ Trace 导出
  └─ printSessionSummary()
```

---

## 13. 学习与改造时应从哪里下手

如果你的目标是理解“项目为何这样搭建”，推荐按下列顺序阅读：

```text
1. src/index.js
   了解所有组件如何被创建和连接。

2. src/agents/default-config.js
   看平台形态的主/子 Agent 配置长什么样。

3. src/agents/agent-registry.js
   理解为什么主 Agent 可以有 multiAgents、子 Agent 不可以。

4. src/agents/runtime.js
   理解配置如何变成 System Prompt 与工具白名单。

5. src/engine/loop.js
   了解主 Agent ReAct 与子 Agent runSub 的执行循环。

6. src/tools/registry.js
   理解工具查找、middleware 审批、ToolResult 包装。

7. src/tools/run-subagent.js
   理解主 Agent 的委派如何创建隔离的子 Agent 运行时。

8. src/context/session.js 与 src/context/thread.js
   理解主/子上下文如何持久化。
```

若要新增一个工具，修改方向通常是：

```text
实现 Tool 类
  → 在 runtime.js 的 TOOL_FACTORIES 增加 factory
  → 将工具名写入某个 Agent 的 toolNames
  → 若高风险，扩展审批中间件的 APPROVE_NAMES
```

若要新增一个子 Agent，通常只需改平台配置：

```text
defaultAgentConfig.multiAgents
  → 添加 name / description / systemPrompt / skillIds / toolNames / maxTurns
```

不应该为了新增角色而在 Engine 内硬编码 `if (agentId === 'xxx')`。角色行为应来自配置，Engine 只负责执行。

---

## 14. 总结：项目是如何被“拼起来”的

tiny-harness 的搭建不是“一个大类完成所有事情”，而是一条明确的装配链：

```text
CLI 参数 + .env
    ↓
Session + Provider + CostTracker
    ↓
Root Agent Config + AgentRegistry
    ↓
Approval Middleware
    ↓
AgentEngine + Reporter
    ↓
根据 Root Agent 配置生成 Tool Registry / System Message
    ↓
runOneTurn 或 REPL
    ↓
Engine ReAct Loop
    ↓
工具执行 / 子 Agent 委派
    ↓
Session、Thread、Trace 落盘
```

`index.js` 的价值正是把这些独立模块按依赖顺序组装成一个可以运行的 Agent 系统。

当你要排查问题时，也可按这条链反向定位：

```text
模型没有工具
→ 看 runtime.js 是否按 toolNames 注册

模型没有子 Agent
→ 看 Root Agent 是否配置 multiAgents，run_subagent 是否被注册

子 Agent 权限不对
→ 看子 Agent toolNames / skillIds，以及 createChildRegistry

历史没有保存
→ 看 runOneTurn 的 finally 中 session.save()

模型配置不生效
→ 看 .env、loadEnvFile、buildProvider

Agent 循环异常
→ 看 engine/loop.js 和 Registry ToolResult
```
