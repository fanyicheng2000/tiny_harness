# `registry.js` 详细讲解：工具注册、路由与中间件边界

`Registry` 是模型工具调用与真实工具实现之间的总入口。它保存工具实例、向模型暴露 JSON Schema，并在执行前运行审批等中间件。

## 数据结构

```js
this.tools = new Map();
this.middlewares = [];
```

`tools` 以工具名映射实现实例；`middlewares` 按挂载顺序保存拦截函数。工具需要提供 `name()`、`definition()`、`execute(args)` 三个能力。

## 注册与声明

`register(tool)` 取得 `tool.name()` 并写入 Map。同名工具会输出警告后覆盖旧实现，这便利于替换测试替身，但生产环境可改为拒绝重复注册。

`getAvailableTools()` 调用每个工具的 `definition()`，得到 `ToolDefinition[]` 交给 Provider。这里区分了“模型看到的契约”与“本地实际执行对象”。

## `execute(call)` 的三阶段

### 1. 按名称路由

```js
const tool = this.tools.get(call.name);
```

未知工具不抛异常，而是返回 `ToolResult(isError: true)`。错误会作为观察消息回传模型，使其换用正确工具。

### 2. 执行中间件链

```js
for (const mw of this.middlewares) {
  const { allowed, rejectReason } = await mw(call);
  if (!allowed) return new ToolResult(...);
}
```

中间件可同步或异步；`await` 同时兼容普通返回值与终端审批 Promise。任何一个拒绝都会短路，真实工具不会执行。拒绝同样转为 `isError: true`，让模型理解是系统/用户拒绝，不是工具消失。

### 3. 执行真实工具并归一化异常

```js
try {
  const output = await tool.execute(call.arguments);
  return new ToolResult({ toolCallId: call.id, output, isError: false });
} catch (err) {
  return new ToolResult({ toolCallId: call.id, output: err.message, isError: true });
}
```

`toolCallId` 保留模型原始调用 ID，Provider 可正确将结果配对回 OpenAI/Claude 的协议格式。

## 设计价值与边界

Registry 让审批、审计、限流等横切逻辑只有一个安装点，避免在每个工具内复制。它不做参数 schema 校验，也不排序/锁定并发工具调用；这些可作为未来中间件或工具层能力扩展。

## 总结

`registry.js` 是工具系统的控制面：模型从它获得工具目录，调用从它路由，风险操作从它拦截，异常从它转为模型可理解的结果。