# `registry.js` 详细讲解：Registry 到底是什么，为什么 Agent 必须有它

如果把 Coding Agent 想象成一个刚入职的工程师：

- 大模型负责**思考和提出要求**，例如“帮我读 `README.md`”；
- `ReadFileTool`、`WriteFileTool`、`BashTool` 等工具负责**真正动手**；
- `Registry` 则像**工具箱管理员 + 总机 + 安检门**。

模型不能直接调用 JavaScript 对象，更不能直接访问文件系统。它只能输出一段结构化意图：

```js
{
  id: 'call_1',
  name: 'read_file',
  arguments: { path: 'README.md' },
}
```

Registry 的任务是：

1. 事先登记系统有哪些真实工具；
2. 把每个工具的“使用说明书”汇总给模型；
3. 当模型请求工具时，根据工具名找到真实实现；
4. 先经过审批等安全检查；
5. 真正执行工具；
6. 无论成功、失败、未知工具或被拒绝，都转换成统一 `ToolResult` 返回给 Engine。

一句话：**Registry 是模型世界的“工具调用请求”，到本地真实能力“执行结果”之间的唯一中转站。**

---

## 1. 不使用 Registry 会怎样

假设在 `loop.js` 直接写：

```js
if (call.name === 'read_file') {
  return readFileTool.execute(call.arguments);
}
if (call.name === 'write_file') {
  return writeFileTool.execute(call.arguments);
}
if (call.name === 'bash') {
  return bashTool.execute(call.arguments);
}
```

刚开始似乎可用，但会迅速遇到问题：

- 新增工具时必须修改核心 ReAct 循环；
- 每个工具都要各自实现审批、日志、错误转换；
- 不存在的工具如何处理？
- 如何统一把“工具说明”传给模型？
- 测试时如何替换一个工具实现？

Registry 将这些横向问题集中到一个位置。Engine 不需要知道当前有几个工具，也不需要知道 read_file 是 `fs.readFileSync`、bash 是 `spawn`；它只做：

```js
const availableTools = this.registry.getAvailableTools();
const result = await this.registry.execute(call);
```

这就是分层：Engine 管调度，Registry 管工具，具体 Tool 管能力实现。

---

## 2. 先建立完整地图：Registry 在系统中的位置

```text
初始化阶段（src/index.js）
────────────────────────────────────────────
new Registry()
  ├─ register(ReadFileTool)
  ├─ register(WriteFileTool)
  ├─ register(EditFileTool)
  ├─ register(BashTool)
  └─ use(审批中间件，可选)

每一轮 Agent（src/engine/loop.js）
────────────────────────────────────────────
Registry.getAvailableTools()
  → ToolDefinition[]
  → Provider 翻译并发给模型
  → 模型返回 ToolCall[]
  → Registry.execute(ToolCall)
       ├─ 找工具
       ├─ 过中间件
       ├─ 调工具.execute(arguments)
       └─ 返回 ToolResult
  → Engine 将 ToolResult 包装成 Message
  → 下一轮发回模型
```

Registry 同时服务两个方向：

| 方向 | 方法 | 含义 |
|---|---|---|
| Harness → 模型 | `getAvailableTools()` | 告诉模型“你可以做什么” |
| 模型 → Harness | `execute(call)` | 把模型的工具请求真正落地 |

这两个方向缺一不可。只有工具定义、没有执行，模型只能“说我要读文件”；只有工具实现、没有定义，模型不知道存在这些能力。

---

## 3. 两个核心容器：`tools` 和 `middlewares`

构造函数非常小：

```js
constructor() {
  this.tools = new Map();
  this.middlewares = [];
}
```

但它们分别代表两类不同的问题。

### 3.1 `tools`：工具名到真实工具实例的映射

例如初始化后可以理解成：

```js
Map {
  'read_file'  => ReadFileTool 实例,
  'write_file' => WriteFileTool 实例,
  'edit_file'  => EditFileTool 实例,
  'bash'       => BashTool 实例,
}
```

Map 的 key 是字符串工具名，value 是可执行的 JavaScript 对象。模型返回 `call.name = 'read_file'` 时，Registry 就能用：

```js
const tool = this.tools.get(call.name);
```

精确找到对应实现。

### 3.2 `middlewares`：执行前的检查链

`middlewares` 是一个函数数组，例如：

```js
[
  approvalMiddleware,
  auditMiddleware,
  rateLimitMiddleware,
]
```

当前项目实际只可选地安装审批 middleware，但结构本身支持多个横切策略。它们不关心某个工具如何读文件，而关心“这个调用是否允许发生”。

可以把 tools 看成“操作人员”，middlewares 看成“进门前的安检、审批、登记”。

---

## 4. `register(tool)`：把真实工具装入工具箱

```js
register(tool) {
  const name = tool.name();
  if (this.tools.has(name)) {
    console.warn(`[Warning] 工具 '${name}' 已经被注册，将被覆盖。`);
  }
  this.tools.set(name, tool);
  console.log(`[Registry] 成功挂载工具: ${name}`);
}
```

在 `src/index.js` 中，工具被装配：

```js
const registry = new Registry();
registry.register(new ReadFileTool(workDir));
registry.register(new WriteFileTool(workDir));
registry.register(new EditFileTool(workDir));
registry.register(new BashTool(workDir));
```

每个工具实例都带有同一个 `workDir`，所以文件类工具在执行时知道自己的边界在哪里。

### 4.1 一个工具必须满足什么形状

Registry 不要求工具继承某个基类，但依赖约定：

```js
class SomeTool {
  name() {
    return 'some_tool';
  }

  definition() {
    return new ToolDefinition(/* 给模型的说明 */);
  }

  async execute(args) {
    return '真实执行结果';
  }
}
```

- `name()`：内部路由键，必须和模型最终请求的 `call.name` 对应；
- `definition()`：模型可见的说明书；
- `execute(args)`：真实能力，接收对象参数并返回字符串或 Promise 字符串。

### 4.2 重复注册为什么是覆盖而不是报错

同名工具会警告后覆盖。这对教学和测试有用：可以把真实 `BashTool` 替换为假的测试工具，不必改 Engine。

但生产场景中，同名覆盖也可能意外替换安全工具。更严格的实现可以默认 throw，只有显式允许替换时才覆盖。

---

## 5. `getAvailableTools()`：给模型一份“菜单”

```js
getAvailableTools() {
  return Array.from(this.tools.values()).map((tool) => tool.definition());
}
```

注意它返回的不是工具实例，而是 `ToolDefinition[]`。例如模型看到的是：

```js
[
  {
    name: 'read_file',
    description: '读取指定路径的文件内容。请提供相对工作区的路径。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  // write_file、edit_file、bash ...
]
```

这一步发生在每个 ReAct Turn 开头：

```js
const availableTools = this.registry.getAvailableTools();
const actionResp = await this.provider.generate(contextHistory, availableTools);
```

Provider 再将统一 ToolDefinition 翻译为厂商格式：

- OpenAI 使用 `tools: [{ type: 'function', function: { ... } }]`；
- Claude 使用 `tools: [{ name, description, input_schema }]`。

所以 Registry 不关心协议，Provider 不关心真实本地工具，职责边界非常清晰。

---

## 6. `use(middleware)`：把安检装到统一入口

```js
use(middleware) {
  this.middlewares.push(middleware);
}
```

当前 CLI 在真实 Provider 默认安装审批：

```js
registry.use(makeApprovalMiddleware({ autoApprove: false }));
```

middleware 的约定是：

```js
async function middleware(call) {
  return {
    allowed: true,
    rejectReason: '',
  };
}
```

返回 `allowed: true` 表示放行，`allowed: false` 表示拒绝；`rejectReason` 会变成模型下一轮可读的观察结果。

### 6.1 middleware 为什么要放 Registry，而不放具体工具中

假如审批逻辑写进 `BashTool.execute()`，那 `WriteFileTool`、`EditFileTool` 也要复制一份；后续加审计、权限、限流会不断重复。

放在 Registry 意味着所有调用都经过同一个关口：

```text
ToolCall
  → middleware 1
  → middleware 2
  → ...
  → real tool.execute()
```

这是一种典型的中间件/责任链设计。

### 6.2 为什么代码对 middleware 使用 `await`

```js
const { allowed, rejectReason } = await mw(call);
```

中间件可以是同步策略：

```js
(call) => ({ allowed: call.name !== 'bash' })
```

也可以是异步策略：终端审批、远程策略服务、数据库权限查询。`await` 同时兼容普通对象和 Promise。

### 6.3 短路行为

只要一个中间件拒绝：

```js
if (!allowed) {
  return new ToolResult({ isError: true, ... });
}
```

后续 middleware 和真实工具都不会运行。这可以防止“审批拒绝后工具仍被执行”的安全漏洞。

---

## 7. `execute(call)`：一次模型工具请求的完整旅程

`execute` 是 Registry 最重要的方法。输入是模型请求的 ToolCall，输出永远是 ToolResult。

```js
async execute(call) {
  // 1. 找工具
  // 2. 过 middleware
  // 3. 调真实工具
  // 4. 将任何结果归一化为 ToolResult
}
```

下面按真实执行顺序拆解。

### 7.1 第一关：按 `call.name` 找工具

```js
const tool = this.tools.get(call.name);
if (!tool) {
  return new ToolResult({
    toolCallId: call.id,
    output: `Error: 系统中不存在名为 '${call.name}' 的工具。`,
    isError: true,
  });
}
```

如果模型虚构 `delete_database`，而 Registry 只登记了 read/write/edit/bash，就不会执行任何未知能力。

这里**返回错误对象，而不是 throw**，原因是：模型需要在下一轮看到“工具不存在”，才能改用正确工具。若直接 throw，Engine 可能中断整个任务，模型失去自我修正机会。

### 7.2 第二关：依次通过所有 middleware

```js
for (const mw of this.middlewares) {
  const { allowed, rejectReason } = await mw(call);
  if (!allowed) {
    return new ToolResult({
      toolCallId: call.id,
      output: `执行被系统拦截。原因: ${rejectReason}`,
      isError: true,
    });
  }
}
```

例如模型提出：

```js
{
  id: 'call_2',
  name: 'bash',
  arguments: { command: 'rm -rf /tmp/logs' },
}
```

审批 middleware 可以向人询问。若用户拒绝，Registry 返回：

```js
new ToolResult({
  toolCallId: 'call_2',
  isError: true,
  output: '执行被系统拦截。原因: 用户在审批环节拒绝了这次 bash 调用。...',
});
```

这和“bash 命令执行失败”在数据结构上同为 `isError`，但内容明确说明是人为/系统拒绝。模型可以据此换成安全方案。

### 7.3 第三关：执行真实工具

```js
try {
  const output = await tool.execute(call.arguments);
  return new ToolResult({
    toolCallId: call.id,
    output,
    isError: false,
  });
} catch (err) {
  return new ToolResult({
    toolCallId: call.id,
    output: `Error executing ${call.name}: ${err.message}`,
    isError: true,
  });
}
```

重点有三个：

1. Registry 只传 `call.arguments`，并不将完整 ToolCall 交给工具；工具只需关心业务参数。
2. 工具可以是异步的，Registry 统一 `await`。
3. 工具抛出的所有异常被转换为 ToolResult，保持 Engine 输入稳定。

以 `read_file` 为例：

```text
ToolCall:   { id: 'call_1', name: 'read_file', arguments: { path: 'README.md' } }
执行对象:   ReadFileTool
调用方法:   ReadFileTool.execute({ path: 'README.md' })
ToolResult: { toolCallId: 'call_1', output: '# tiny-harness...', isError: false }
```

---

## 8. 为什么 Registry 必须“永远返回 ToolResult”

Registry 接住四类结果：

| 情况 | 是否执行真实工具 | 返回的 ToolResult |
|---|---:|---|
| 工具不存在 | 否 | `isError: true`，说明未知工具 |
| middleware 拒绝 | 否 | `isError: true`，说明拒绝原因 |
| 工具成功 | 是 | `isError: false`，带 output |
| 工具抛异常 | 是 | `isError: true`，带错误文本 |

这样 `loop.js` 不需要为每种失败写不同的 try/catch，只要统一处理：

```js
const result = await this.registry.execute(call);

if (result.isError) {
  finalOutput = this.recovery.analyzeAndInject(call.name, result.output);
}
```

然后将结果变成会话消息：

```js
new Message({
  role: Role.USER,
  content: finalOutput,
  toolCallId: call.id,
  isError: result.isError,
});
```

于是工具异常不会“把程序炸掉”，而会成为模型下一轮思考的输入。这就是 Agent 具有自我修正能力的前提。

---

## 9. 用一次 `read_file` 调用串起来

假设用户说：**“读取 README.md 并总结。”**

### 初始化：工具登记

```js
registry.register(new ReadFileTool(workDir));
```

Registry 内部现在有：

```text
'read_file' → ReadFileTool 实例
```

### 第 1 轮：把菜单给模型

```js
const definitions = registry.getAvailableTools();
```

模型知道 `read_file(path)` 可以用。

### 模型决定调用

Provider 解析模型响应，得到：

```js
const call = new ToolCall({
  id: 'call_1',
  name: 'read_file',
  arguments: { path: 'README.md' },
});
```

### Registry 路由并执行

```js
const result = await registry.execute(call);
```

内部发生：

```text
Map.get('read_file')
  → 找到 ReadFileTool
  → 依次跑 middleware（读文件通常直接放行）
  → ReadFileTool.execute({ path: 'README.md' })
  → 返回 ToolResult(call_1, 文件内容, false)
```

### Engine 回传给模型

Engine 把结果写入 Session，下一轮模型看到：

```text
assistant：我来读取 README（调用 call_1）
tool：call_1 的结果是 README 的完整内容
```

模型因此才能真的总结文件。没有 Registry，模型的 `read_file` 只会停留在一段文字意图，无法触达真实文件系统。

---

## 10. Registry 不做什么

理解边界同样重要。

Registry **不负责**：

- 定义如何读文件：这是 `ReadFileTool` 的责任；
- 定义 OpenAI/Claude 的工具协议：这是 Provider 的责任；
- 决定模型该调用什么工具：这是模型的责任；
- 决定下一轮何时结束：这是 AgentEngine 的责任；
- 持久化工具调用历史：这是 Session 的责任；
- 自动校验 `arguments` 是否完全符合 JSON Schema：当前版本没有实现；
- 给并发写操作加锁：当前版本没有实现。

Registry 是“统一入口和统一结果格式”，不是所有工具逻辑的集合。

---

## 11. 当前实现的边界与可演进方向

### 11.1 参数 schema 只用于提示模型

ToolDefinition 的 `inputSchema` 被发给模型，但 Registry 没有在本地再次校验。例如模型可能给 `read_file` 传 `{}`，最终由具体工具报错。

生产环境可在 execute 前加入 JSON Schema validator middleware，尽早返回清晰参数错误。

### 11.2 middleware 没有名字或卸载能力

`middlewares` 是普通数组。REPL 的 `/yolo` 直接：

```js
registry.middlewares = [];
```

这会移除所有中间件，而不仅是审批。未来可为 middleware 增加 ID、优先级、标签和 `remove(id)`，从而精确禁用审批而保留审计/限流。

### 11.3 并发冲突由上层/工具自行处理

Engine 会用 `Promise.all` 并发调用 Registry。若同一轮两个 `write_file` 同时写同一文件，Registry 不加锁，最终结果取决于时序。可扩展资源锁 middleware，或让工具声明读写资源。

### 11.4 错误被结构化但仍是字符串

ToolResult 使用 `output + isError`，简单且便于模型阅读；但生产系统可添加 errorCode、retryable、severity 等字段，以便自动策略更可靠。

---

## 12. 最短记忆口诀

> **Tool 是干活的人，Registry 是工具箱管理员。**
>
> **注册时：把工具放进箱子。**
>
> **调用前：把工具说明给模型。**
>
> **调用时：按名字找人，先过安检，再去干活。**
>
> **调用后：无论成败，都带着同一个 call ID 返回结果给模型。**

只要记住 Registry 是“模型工具请求到真实执行能力之间的总关口”，就能理解它为什么同时有 `register`、`getAvailableTools`、`use` 与 `execute` 四类方法。