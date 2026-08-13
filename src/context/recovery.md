# `recovery.js` 详细讲解：把工具报错转化为下一步行动建议

`RecoveryManager` 不负责重试工具，也不修改文件。它接收一次工具失败的原始错误文本，根据工具名和错误特征追加“系统救援指南”，再由 `loop.js` 将增强结果写回模型上下文。

## 在主循环中的位置

```js
let finalOutput = result.output;
if (result.isError) {
  finalOutput = this.recovery.analyzeAndInject(call.name, result.output);
}
```

Registry 已经把异常转成 `ToolResult(isError: true)`，所以引擎不会崩溃。Recovery 在此基础上补充如何纠正，下一轮模型能够从失败中学习，而不是盲目重复。

## `analyzeAndInject()` 的工作方式

函数先保留原始错误：

```js
let hint = '';
const lowerError = rawError.toLowerCase();
```

再按工具名进行有限的特征匹配；没有命中时原样返回，命中时返回：

```text
原始错误

[系统救援指南]: 可执行的修正建议
```

原始 stderr 不被删除，因为它是最可靠的诊断证据。

## 已覆盖的规则

| 工具 | 错误特征 | 注入建议 |
|---|---|---|
| `edit_file` | 找不到 old_text / 代码片段 | 重新 read_file 获取最新内容 |
| `edit_file` | 命中多处 | 增加 old_text 周边上下文保证唯一 |
| `read_file` / `write_file` | ENOENT / 文件不存在 | 用 `ls`、`find` 找实际路径，不要猜 |
| `read_file` / `write_file` | 权限不足 | 检查工作区限制或换目标 |
| `bash` | command not found | 使用替代命令或考虑安装 |
| `bash` | timeout / 超时 | 常驻服务应转后台，避免阻塞 |
| `bash` | syntax error | 检查引号、转义和特殊字符 |

文本匹配同时包含中文提示和常见英文系统错误，适配工具自定义报错与 Node/Unix 错误。

## Recovery 与 Reminder 的区别

Recovery 是**单次失败的软引导**：告诉模型如何修。`engine/reminder.js` 是**多次重复失败的硬干预**：达到阈值后要求模型停止原样重试、换策略或求助。

二者搭配：第一次失败先给精确建议；模型仍忽略建议重复失败时，Reminder 再打断循环。

## 局限与改进

- 规则是字符串包含匹配，依赖错误文案稳定性；可逐步改为错误码或结构化错误类型。
- 未覆盖未知工具、网络请求、JSON 解析等更多错误类型。
- 建议文本直接进入模型上下文，应避免包含不可信错误输出导致提示注入；生产系统可区分可信系统错误与外部内容。
- 它不应取代重试策略：网络临时失败可由 Provider 层做有限退避重试，工具语义错误则交给模型修正。

## 总结

`recovery.js` 将“机器可读但模型未必会行动的错误”转为“保留原证据、附带具体下一步”的观察消息，是 Agent 自愈能力的轻量实现。