# Message、ToolCall、ToolResult、ToolDefinition：一张图讲清四个对象的关系

这四个对象都定义在 `src/schema/message.js`，但它们并不是同一层的东西。最容易记住的方式是把一次工具调用看成一个闭环：

```text
1. 系统先告诉模型“你有哪些工具能用”
       ToolDefinition
            ↓
2. 模型决定“我要调用哪个工具，参数是什么”
       ToolCall
            ↓
3. Harness 实际执行，得到成功结果或错误
       ToolResult
            ↓
4. 将结果包装成一条会话消息，发回给模型阅读
       Message（带 toolCallId）
            ↓
5. 模型根据结果决定继续调用工具或最终回答
```

一句话概括：

- **ToolDefinition**：工具的说明书，给模型看；
- **ToolCall**：模型发出的工具调用请求；
- **ToolResult**：工具执行后的内部结果；
- **Message**：贯穿整个对话历史的通用信封，既能装用户话、模型话，也能装工具结果。

---

## 1. 先看最重要的区别：谁在什么时候产生

| 对象 | 谁创建 | 什么时候创建 | 主要给谁使用 |
|---|---|---|---|
| `ToolDefinition` | 工具实现，例如 `ReadFileTool.definition()` | 模型调用前 | 模型 / Provider |
| `ToolCall` | 模型响应，经 Provider 解析 | 模型决定使用工具时 | Registry / Engine |
| `ToolResult` | Registry | 工具执行后 | Engine 的错误处理与控制逻辑 |
| `Message` | PromptComposer、用户、Provider、Engine | 整个对话过程中 | Session / Provider / 模型 |

因此不要把它们理解为四种“消息”。其中只有 `Message` 是会话历史的通用消息；其余三个分别是工具的**说明、请求、执行结果**。

---

## 2. `ToolDefinition`：模型能做什么

```js
export class ToolDefinition {
  constructor({ name, description, inputSchema }) {
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
  }
}
```

以 `read_file` 为例，工具会提供类似定义：

```js
new ToolDefinition({
  name: 'read_file',
  description: '读取指定路径的文件内容。请提供相对工作区的路径。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
});
```

它的本质是 **API 文档 / 函数签名**，并没有执行任何事情。

Registry 将所有定义收集起来：

```js
getAvailableTools() {
  return Array.from(this.tools.values()).map((tool) => tool.definition());
}
```

随后 Provider 将它翻译给具体模型：

- OpenAI：转成 `tools[].function`；
- Claude：转成 `tools[].input_schema`。

可以把 ToolDefinition 比作餐厅菜单：模型先知道有“读文件”“写文件”“执行命令”这些菜，才知道自己可以点什么。

---

## 3. `ToolCall`：模型想做什么

```js
export class ToolCall {
  constructor({ id, name, arguments: args = {} }) {
    this.id = id;
    this.name = name;
    this.arguments = args;
  }
}
```

当模型看完 ToolDefinition 后，可能决定：

```js
new ToolCall({
  id: 'call_1',
  name: 'read_file',
  arguments: { path: 'README.md' },
});
```

这句话的含义是：

> “请 Harness 执行一次名为 `read_file` 的工具，参数是 `{ path: 'README.md' }`；这次调用的关联编号是 `call_1`。”

**ToolCall 是请求，不是结果，也不是工具本身。**

它通常位于模型返回的 assistant Message 中：

```js
new Message({
  role: Role.ASSISTANT,
  content: '我来读取 README。',
  toolCalls: [toolCall],
});
```

一个 assistant Message 可以有多个 ToolCall，例如同时读多个文件。这也是 `loop.js` 用 `Promise.all()` 并发执行同一轮调用的原因。

---

## 4. `ToolResult`：工具实际上做得怎么样

```js
export class ToolResult {
  constructor({ toolCallId, output, isError = false }) {
    this.toolCallId = toolCallId;
    this.output = output;
    this.isError = isError;
  }
}
```

Registry 接到 ToolCall 后，查找工具、经过审批 middleware、执行真实工具，最后生成 ToolResult。

成功示例：

```js
new ToolResult({
  toolCallId: 'call_1',
  output: '# tiny-harness\n...',
  isError: false,
});
```

失败示例：

```js
new ToolResult({
  toolCallId: 'call_1',
  output: 'Error executing read_file: 打开文件失败: ENOENT ...',
  isError: true,
});
```

`toolCallId` 必须回指请求的 `ToolCall.id`。这是“问题”和“答案”的配对关系：模型发出 `call_1`，Harness 返回 `call_1` 的结果。

ToolResult 是 Engine 的中间对象：

- `isError` 为 true 时，RecoveryManager 注入修复建议；
- ReminderInjector 用它判断是否发生重复失败；
- Reporter 用它决定显示成功还是失败。

它一般**不会直接存入 Session**，因为不同 Provider 对工具结果的表达方式不同。

---

## 5. `Message`：所有对话历史的统一信封

```js
export class Message {
  constructor({
    role,
    content = '',
    toolCalls = [],
    toolCallId = '',
    usage = null,
    isError = false,
  }) {
    // ...
  }
}
```

Message 是最宽泛的对象。Session 的 `history` 保存的就是 `Message[]`。

### 5.1 四种常见的 Message 形态

#### A. System Message：系统规则

```js
new Message({
  role: Role.SYSTEM,
  content: '你是 tiny-harness，编辑文件前先读取文件。',
});
```

由 PromptComposer 创建，通常每次运行放在模型上下文最前。

#### B. User Message：用户任务

```js
new Message({
  role: Role.USER,
  content: '请读取 README.md 并总结。',
});
```

由 CLI / REPL 接收用户输入后创建。

#### C. Assistant Message：模型回复，可能附带 ToolCall

```js
new Message({
  role: Role.ASSISTANT,
  content: '我先读取 README。',
  toolCalls: [
    new ToolCall({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'README.md' },
    }),
  ],
});
```

这里的 `toolCalls` 是模型“准备采取的动作”。

#### D. 工具结果 Message：将 ToolResult 重新包装回会话

`loop.js` 会把 ToolResult 转成 Message：

```js
new Message({
  role: Role.USER,
  content: finalOutput,
  toolCallId: call.id,
  isError: result.isError,
});
```

从内部角色看它是 `user`；但语义上它是“工具观察结果”。Provider 会根据 `toolCallId` 再翻译：

- OpenAI Provider → `{ role: 'tool', tool_call_id: 'call_1', content: ... }`；
- Claude Provider → `{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', ... }] }`。

因此，**Message 是跨 Provider 的统一表示；ToolResult 是工具层的统一表示。**

---

## 6. 把一次真实调用串起来

假设用户说：“读取 `README.md`。”

### 第一步：模型先拿到工具菜单

```js
const tools = [
  new ToolDefinition({
    name: 'read_file',
    description: '读取指定路径的文件内容',
    inputSchema: { /* path 必填 */ },
  }),
];
```

### 第二步：模型返回动作请求

Provider 将厂商响应转换成：

```js
const call = new ToolCall({
  id: 'call_1',
  name: 'read_file',
  arguments: { path: 'README.md' },
});

const assistantMessage = new Message({
  role: Role.ASSISTANT,
  content: '我来读取 README。',
  toolCalls: [call],
});
```

Engine 立即将这条 assistant Message 放入 Session，保留“模型为什么、打算做什么”。

### 第三步：Registry 执行请求

```js
const result = await registry.execute(call);
```

Registry 的返回是：

```js
new ToolResult({
  toolCallId: 'call_1',
  output: '# tiny-harness\n...',
  isError: false,
});
```

### 第四步：Engine 将结果变成下一轮对话消息

```js
const observationMessage = new Message({
  role: Role.USER,
  content: result.output,
  toolCallId: result.toolCallId,
  isError: result.isError,
});

session.append(observationMessage);
```

### 第五步：下一轮模型收到完整因果链

```text
用户：读取 README
助手：我来读取 README（toolCall: call_1）
工具：call_1 的结果是 # tiny-harness ...
```

模型现在有真实文件内容，可以选择继续调用工具或直接总结。

---

## 7. 最终对照表：别再混淆

| 名称 | 可以类比成 | 是否进入 Session.history | 是否直接给模型 | 核心字段 |
|---|---|---:|---:|---|
| `ToolDefinition` | 菜单 / API 文档 | 否 | 是 | name、description、inputSchema |
| `ToolCall` | 点菜单 / 函数调用请求 | 作为 assistant Message 的字段进入 | 是 | id、name、arguments |
| `ToolResult` | 后厨执行结果 | 否，需包装 | 否，需转换 | toolCallId、output、isError |
| `Message` | 对话信封 / 会话记录 | 是 | 是 | role、content、toolCalls、toolCallId |

最后再记一个最短口诀：

> **Definition 先告诉模型“有什么”；Call 表示模型“要什么”；Result 表示工具“做完了什么”；Message 负责把前面所有信息放进对话历史。**
