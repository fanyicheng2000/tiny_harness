# `mock.js` 详细讲解：无 API Key 的可控 Agent 演示 Provider

`src/provider/mock.js` 提供 `MockProvider` 与一组预设剧本。它不调用真实大模型，而是按顺序返回预先写好的 assistant 响应和工具调用，用于离线教学、可重复演示和回归测试。

## 1. 为什么需要 Mock Provider

真实 LLM 演示会受 API Key、网络、费用、响应延迟和输出随机性影响。Mock 把这些不确定性消除：

- 分享或教学环境无需密钥；
- 每次执行的调用序列固定；
- 能稳定复现工具并发、死循环、审批、Plan Mode 等边界；
- 测试不会产生真实模型费用。

它仍继承 `BaseProvider`，所以 Engine 不需要特殊分支：

```js
const response = await provider.generate(messages, availableTools);
```

对于 Engine 而言，Mock 与真实 Provider 都返回内部 `Message`。

## 2. `MockProvider` 的状态机

```js
constructor(script = []) {
  super('mock');
  this.script = script;
  this.cursor = 0;
}
```

`script` 是按轮排列的响应数组，每一项通常有：

```js
{
  content: '给用户或日志展示的文本',
  toolCalls: [
    { id: 'call_1', name: 'read_file', arguments: { path: 'README.md' } }
  ]
}
```

`cursor` 是当前消费位置，因此 Mock 实际上是一个有限状态机：第 N 次 `generate()` 返回剧本第 N 项。

## 3. `generate()`：模拟模型响应

```js
async generate(messages, availableTools) {
  await new Promise((resolve) => setTimeout(resolve, 200));

  if (this.cursor >= this.script.length) {
    return new Message({
      role: 'assistant',
      content: '任务已完成。',
      toolCalls: [],
    });
  }

  const item = this.script[this.cursor++];
  return new Message({
    role: 'assistant',
    content: item.content || '',
    toolCalls: (item.toolCalls || []).map((toolCall) => new ToolCall(toolCall)),
  });
}
```

### 3.1 为什么仍声明为 async

真实 Provider 是异步网络调用。Mock 使用 200ms 延迟模拟响应节奏，使 UI 与 Trace 演示更接近真实模型，并保证它和真实 Provider 满足同一 Promise 契约。

### 3.2 为什么不使用 `messages` 和 `availableTools`

Mock 的目标是精确复现预设步骤，不是推理。参数保留在签名中是为了契约兼容。若要做更高级测试，可检查输入消息或工具声明，并根据输入动态选择剧本。

### 3.3 剧本耗尽如何结束

剧本耗尽后返回空 `toolCalls` 的 assistant Message。`AgentEngine` 将其视为任务完成信号，退出 ReAct 循环。这使调用方即便提供的剧本缺少结尾，也不会无限循环。

### 3.4 `reset()`

`reset()` 将 cursor 重置为 0，使同一 Provider 实例可从第一个剧本步骤重跑。它不会深拷贝 script；如果外部修改剧本对象，后续运行会看到修改。

## 4. 剧本分组与教学目的

文件中的函数返回不同剧本。典型例子：

| 函数 | 演示重点 |
|---|---|
| `scriptReact` | 最小 ReAct：工具调用后下一轮结束 |
| `scriptProviderSwitch` | 引擎只依赖内部 Message，不依赖厂商文风 |
| `scriptFirstTool` | bash 与 read_file 的连续调用 |
| `scriptEditFuzzy` | 编辑工具的模糊匹配降级 |
| `scriptWriteAndRead` | 一轮多个工具，通过 Promise.all 并发 |
| `scriptSessionResume` | JSONL Session 与工作记忆概念 |
| `scriptLoop` | 同一失败调用三次，触发 Reminder |
| `scriptApproval` | 危险命令被审批中间件拒绝后调整策略 |
| `scriptSystemPrompt` | 核心规则、AGENTS.md、SKILL.md 三层注入 |
| `scriptCompactor` | 上下文压缩概念演示 |
| `scriptPlanMode` | PLAN.md / TODO.md 创建、执行和打勾 |
| `scriptObservabilitySpan` | Span 树与 CostTracker 说明 |

大部分剧本最后一项都明确给出空 `toolCalls`，使得结束时机可读、可控。

## 5. `MOCK_SCRIPTS`：给演示层的索引

文件底部导出的 `MOCK_SCRIPTS` 将短名称映射为：

```js
{
  fn: scriptReact,
  section: 1,
  title: 'ReAct 主循环',
  hint: '看轮次切换：思考→工具→结果→结束'
}
```

这让 `demos/server.js` 等调用方无需写长串 switch，只要按 key 查表即可获得剧本函数及 UI 展示元数据。

## 6. Mock 的局限

- 不验证模型是否真的会根据上下文选择正确工具；
- 不验证 OpenAI / Claude 的真实 HTTP 序列化；
- 不返回 usage，因此 CostTracker 只能按 mock 定价或未返回 usage 的路径展示；
- 200ms 延迟是演示效果，不等于真实网络延迟；
- 剧本中的工具参数仍会真正交给 Registry 执行，尤其 write/bash 类示例需要在安全工作区运行。

因此 Mock 适合验证 Harness 控制流和教学机制；Provider 序列化、真实 API 错误和模型行为仍需单独集成测试。

## 7. 总结

`mock.js` 把“不稳定且昂贵的模型推理”替换为“确定且可复现的响应状态机”。它让 Agent Harness 的循环、工具、审批、会话和观测能力可以离线演示，也让开发者能先验证编排逻辑，再接入真实 LLM。