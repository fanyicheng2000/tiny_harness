# `index.js` 详细讲解：CLI 入口、依赖装配与 REPL 控制台

`src/index.js` 是 tiny-harness 的组合根（Composition Root）：它不实现 ReAct、Provider 协议或具体工具，而是负责从命令行读取配置、构造各模块、安装安全策略，并选择单次执行或多轮 REPL。

```text
命令行 / .env
  → 参数解析、工作区与 Session
  → Provider（Mock / OpenAI / Claude）
  → CostTracker 装饰器
  → Registry + 文件/Shell 工具
  → 审批 middleware
  → AgentEngine + TerminalReporter
  → 单次 runOneTurn 或 REPL runRepl
```

## 1. 导入依赖：入口如何连接全部模块

文件导入 Node 内置模块：

- `path`：将 `--dir` 规范化为绝对工作区路径；
- `fs`、`fileURLToPath`：定位项目根并加载 `.env`；
- `readline`：实现审批输入与 REPL。

业务模块覆盖完整执行链：

- `Message` / `Role`：把用户输入放入内部会话格式；
- `globalSessionMgr`：恢复或创建 Session；
- `Registry` 和四个工具：构建 Agent 可操作的外设；
- OpenAI / Claude / Mock Provider：模型来源；
- `CostTracker`：给 Provider 加 Token/金额统计；
- `AgentEngine`：真正运行 ReAct 循环；
- `TerminalReporter`：将引擎事件打印到 CLI。

入口集中装配依赖的好处是：`loop.js` 等核心模块无需 import 命令行、环境变量或具体 Provider，便于复用和测试。

## 2. `parseArgs()`：零依赖命令行解析

默认参数对象：

```js
{
  prompt: '', dir: '.', session: 'cli_default_session',
  provider: process.env.TINY_HARNESS_PROVIDER || 'auto',
  thinking: false, plan: false,
  requireApproval: false, autoApprove: false,
  script: 'read-file'
}
```

随后从 `argv[2]` 开始扫描。带值选项（`--prompt`、`--dir`、`--session`、`--provider`、`--script`）取下一个 token 并跳过；布尔开关直接设为 true。

别名包括：

| 参数 | 作用 |
|---|---|
| `--prompt` / `-p` | 单次任务输入 |
| `--dir` / `-d` | 工作区 |
| `--session` / `-s` | 会话 ID |
| `--provider` | `mock` / `openai` / `claude` / `auto` |
| `--script` | Mock 剧本 |
| `--thinking` | 启用两阶段慢思考 |
| `--plan` | 启用 Plan Mode |
| `--require-approval` | 强制审批危险工具 |
| `--auto-approve` / `--yolo` | 跳过审批 |

它适合教学和小型 CLI，但没有处理参数缺值、`--key=value`、重复参数、未知位置参数等复杂情况。工业场景可换成熟 CLI 库并为参数写 schema 校验。

## 3. `printHelp()`：运行时文档

帮助文本与当前默认模型常量拼接，因此用户能看到实际默认模型。它通过 `--help` / `-h` 调用后立即 `process.exit(0)`，不会继续初始化 Session 或 Provider。

## 4. `loadEnvFile()`：无 dotenv 的简单配置加载

项目以 ESM 运行，`import.meta.url` 是文件 URL；`fileURLToPath()` 先转换成本地路径，再向上定位到项目根：

```js
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
```

加载器逐行读取 `.env`：忽略空行和 `#` 注释，在第一个 `=` 处分割 key/value，去除两端单/双引号。仅当 `process.env[key]` 尚未存在时才写入，故系统环境变量优先级高于 `.env`。

该实现足以支撑示例，但不是完整 dotenv 语法：不支持多行值、变量展开、复杂转义。并且 catch 会静默吞掉“文件不存在”和“文件不可读”等所有错误，开发排障时可增加 debug 日志。

## 5. `buildProvider()`：选择模型来源

返回统一结构：

```js
{ provider, modelName }
```

`provider` 交给 Engine，`modelName` 交给 CostTracker 查价格表。

### `auto`

优先使用有 `CLAUDE_API_KEY` 的 Claude，其次才是 OpenAI；均未配置时抛出带离线 Mock 建议的错误。

### `mock`

`--script` 被映射到预设剧本函数，例如 `write-and-read`、`loop`、`approval`、`plan-mode`。构造 `new MockProvider(scriptFn())`，其响应可重复、无需网络。

### `openai` / `claude`

分别调用从环境变量构造的工厂函数，并返回当前模型名或默认模型名。入口不处理协议细节，这些都封装在 Provider 文件中。

## 6. 终端审批 middleware

`makeApprovalMiddleware()` 构建一个闭包，状态 `allApproved` 只在当前进程/当前 middleware 生命周期有效。它只拦截：

```js
new Set(['bash', 'write_file', 'edit_file'])
```

读文件默认放行；写、编辑、Shell 需要 y/n/a 决策：

- `y` / `yes`：本次调用放行；
- `n` 或其他输入：返回 `{ allowed: false, rejectReason }`；
- `a`：后续调用都放行，相当于本次运行 YOLO。

Registry 会 `await middleware(call)`，所以 middleware 可以返回普通对象或 Promise。拒绝不会直接抛出，而会被 Registry 转成 `ToolResult.isError=true`，让模型看到用户拒绝理由并尝试替代方案。

### 当前代码的重要实现问题

`promptUser()` 返回 Promise：

```js
return new Promise((resolve) => rl.question(question, resolve));
```

但 `makeApprovalMiddleware()` 的返回函数没有声明 `async`，也没有 `await promptUser(...)`：

```js
const answer = promptUser(...);
const cmd = (answer || '').trim().toLowerCase();
```

此处 `answer` 实际是 Promise，Promise 没有 `.trim()`，真实需要审批时会抛出 `TypeError`。正确写法应为：

```js
return async (call) => {
  // ...
  const answer = await promptUser(question);
  const cmd = (answer || '').trim().toLowerCase();
  // ...
};
```

注释“同步阻塞读 stdin”也不准确：实现使用的是异步 readline Promise；语义上是等待用户决定，但不会同步阻塞 Node 事件循环。

## 7. `main()`：构造完整 Agent

初始化顺序体现依赖关系：

1. 加载 `.env`，解析 CLI 参数，解析 `workDir`；
2. `globalSessionMgr.getOrCreate()` 恢复或创建会话；
3. `buildProvider()` 选模型；
4. `new CostTracker(realProvider, modelName, session)` 加观测装饰器；
5. 创建 Registry，注册 read/write/edit/bash；
6. 按安全策略挂审批 middleware；
7. 创建 `AgentEngine(trackedProvider, registry, thinking, plan)`；
8. 创建 TerminalReporter；
9. 进入单次任务、Mock 默认任务或 REPL。

审批策略是：Mock 默认跳过审批方便自动化 demo，除非显式 `--require-approval`；真实 Provider 默认审批，除非 `--auto-approve`。注意策略判断使用原始 `args.provider`：若为 `auto` 且实际选择真实 Provider，也会默认审批，符合安全预期。

## 8. `runOneTurn()`：单次任务的会话边界

```js
session.append(new Message({ role: Role.USER, content: prompt }));
try {
  await engine.run(session, reporter);
} finally {
  session.save();
}
```

用户输入先作为 user Message 加入历史；引擎运行期间会继续追加 assistant 与工具结果。`finally` 确保即使引擎抛错也会保存当前会话，方便排障或续传。之后打印耗时。

若 `session.save()` 自己抛错，会覆盖原始引擎错误；生产系统可显式区分主错误与持久化错误。

## 9. `runRepl()`：多轮对话与串行队列

无 `--prompt` 且不是 Mock 时进入 REPL，复用同一 Session、Engine、Registry，因此模型能跨轮看到历史。

### 特殊命令

- `/cost`：显示 Token 与按币种金额；
- `/history`：显示历史条数和预览；
- `/clear`：清空内存 history，下一次 save 将触发 Session 全量重写；
- `/yolo`：清空 `registry.middlewares`；
- `/think`、`/plan`：直接更新 Engine 开关；
- `/exit`：关闭 readline，等待队列结束后输出总结。

`/yolo` 直接清空所有 middlewares，注释称“只清审批”并不完全成立：未来若挂载审计、限流等中间件，也会被一起移除。更好的方式是为 middleware 增加标识并只移除审批层。

### 为什么需要 `pending` Promise 队列

readline 的 `line` 事件不会等待 async handler。管道输入可能瞬间触发多行，导致多个 `runOneTurn()` 并发读写同一 Session。代码用 Promise 链串行化：

```js
let pending = Promise.resolve();
const enqueue = (task) => {
  pending = pending.then(() => task()).catch(handleError);
  return pending;
};
```

每项任务只有上一项完成后才启动。`close` 事件 `await pending`，确保 `/exit` 不会立即杀死队列中的模型调用。

`busy` 变量被设置但未使用，可删除；`safePrompt()` 防止 readline 已关闭后再次 prompt 抛错。

## 10. 总结与错误出口

`printSessionSummary()` 汇总会话成本、Session ID 和 Trace 目录。`formatEstimatedCosts()` 按币种格式化金额，避免混币种相加。

文件末尾：

```js
main().catch((err) => {
  console.error('未捕获错误:', err);
  process.exit(1);
});
```

统一处理未捕获的异步错误并返回非零退出码。

总之，`index.js` 将可复用模块编排为一个安全边界明确的 CLI：参数决定策略，Session 承担连续性，Provider/工具构成能力，Tracker/Reporter 提供可见性，REPL 队列保证多轮状态不发生并发竞争。