# `session.js` 详细讲解：Agent 会话、工作记忆与 JSONL 持久化

`src/context/session.js` 是 Agent 的长期记忆层。它保存完整消息历史、Token/费用累计，提供给模型的近期 Working Memory，并把会话持久化到工作区 `.tiny-harness/sessions/<id>.jsonl`，从而支持进程重启后的断点续传。

## 1. Session 的核心状态

```js
this.id;
this.workDir;
this.createdAt;
this.updatedAt;
this.totalPromptTokens;
this.totalCompletionTokens;
this.estimatedCosts;
this.history;
this.appendedCount;
```

`history` 保存完整内部 `Message` 序列；`appendedCount` 表示其中已有多少条成功写入 JSONL，用于增量保存。`estimatedCosts` 按币种保存，避免把不同币种错误相加。

## 2. 安全 Session ID 与文件路径

```js
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
```

`sessionFile()` 拒绝包含路径分隔符、空格等字符的 id，再拼接到工作区绝对路径下。这样 `--session ../../x` 无法越界写文件。

## 3. `append()` 与 Working Memory

`append(...msgs)` 将消息追加到完整历史并更新 `updatedAt`。

`getWorkingMemory(limit = 20)` 返回最近 N 条，而不是全量历史。截断可能从工具结果开始，而工具结果必须对应前面的 assistant tool call；函数会持续剔除开头带 `toolCallId` 的 user 消息，防止向 Provider 发送无主工具结果。

这是“长期记录”和“短期模型上下文”的分离：完整历史用于恢复，近期窗口用于控制模型输入。

## 4. 使用量与元数据

`recordUsage()` 被 CostTracker 调用，累加输入/输出 Token 和可选金额估算。

`_metaObject()` 生成 JSONL 元数据行，包含 id、工作目录、时间、Token、费用和 history count。JSONL 可以存在多个 meta 行，加载时最后一行生效，因此增量保存无需修改文件头。

## 5. JSONL 格式与保存策略

每行是一个独立 JSON 对象：

```json
{"__type":"meta","id":"demo", "count":2}
{"__type":"message","role":"user","content":"..."}
```

### 新文件或历史被缩短：全量重写

当文件不存在，或 `history.length < appendedCount`（如 REPL `/clear` 清空历史）时，写入临时文件后 `renameSync()` 替换正式文件。临时文件加 rename 提高全量更新的原子性。

### 常规保存：增量追加

`history.slice(appendedCount)` 得到新消息，只追加这些 message 行，再追加最新 meta 行。旧 meta 不需修改，最后一个 meta 自动代表最新状态。

若没有新消息但 Token/费用变化，仍追加一条新 meta。

### `appendToStore()`

该方法可实时追加单条消息，但主 CLI 当前主要使用 `save()`。调用它时要确保调用方也正确维护 `appendedCount`，否则后续 save 的增量范围可能与预期不同。

## 6. 加载与容错

`Session.load()` 有文件则调用 `_loadFromJsonl()`，否则返回新 Session。

加载时逐行 JSON.parse；坏行直接跳过，适合处理进程在 append 中断留下的半行。所有 meta 行中最后一个生效；消息行重新构造成 `new Message(m)`，恢复类实例行为。最后将 `appendedCount` 设为历史长度，之后 save 只会写新增内容。

## 7. `SessionManager`

```js
getOrCreate(id, workDir) {
  if (this.sessions.has(id)) return this.sessions.get(id);
  const session = Session.load(id, workDir);
  this.sessions.set(id, session);
  return session;
}
```

同一进程内同一个 ID 复用同一实例，避免同一会话反复加载。`globalSessionMgr` 是 CLI 使用的全局管理器。

## 8. 边界与注意点

- 同一 session ID 的多进程并发写入未受锁保护，可能交错写入。
- 加载使用 `readFileSync` 全量读入，超大历史并非真正流式。
- JSONL 可容忍最后坏行，但不保证任意磁盘故障下数据一致。
- 工作记忆只按条数，不按 Token；Compactor 继续承担字符长度控制。
- 会话文件可含用户任务、工具输出和路径，应由工作区权限保护。

## 总结

`session.js` 用 JSONL 追加日志实现低成本的 Agent 记忆：完整历史可恢复，近期窗口可调用，元数据可累计，坏尾行可容忍。它是多轮对话、费用统计和断点续传的基础。