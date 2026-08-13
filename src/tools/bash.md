# `bash.js` 详细讲解：受超时与输出限制的 Shell 工具

`BashTool` 允许 Agent 在工作目录运行 shell 命令，用于查看目录、运行测试、执行脚本等。它是能力最强也最危险的工具之一：设置 cwd 不等于安全沙箱，命令仍拥有 Node 进程可访问的系统权限。

## 工具声明与配置

默认常量：

```js
const MAX_OUTPUT_BYTES = 8000;
const TIMEOUT_MS = 30_000;
```

构造函数允许注入 `timeoutMs`，便于测试缩短等待。JSON Schema 只接受必填字符串 `command`。

## 为什么用 `spawn` 而非 `execSync`

```js
const child = spawn('sh', ['-c', command], {
  cwd: this.workDir,
  env: process.env,
});
```

`spawn` 提供 stdout/stderr 流事件，可异步收集输出并配合 `setTimeout` 强制终止；`execSync` 会阻塞 Node 事件循环，不适合 Agent 的异步工具接口。实现面向 macOS/Linux 使用 `sh -c`，Windows 需改为 `cmd /c` 或 PowerShell。

## 生命周期与 `settled`

stdout/stderr chunk 被合并到 Buffer。`settled` 防止 timeout、close、error 等多个事件竞争 resolve/reject：第一个完成路径将其设为 true，后续事件直接返回。

- timeout：`SIGKILL` 子进程，携带已有输出及超时提示 reject；
- close 且退出码非 0：合并 stdout/stderr 与退出码 reject；
- close 且退出码为 0：resolve 输出；没有输出时返回成功占位文本；
- child error：包装后 reject。

Registry 会把 reject 转为 `ToolResult.isError`，模型能看到 stderr 并由 Recovery 获取建议。

## `formatOutput()`：保留诊断信息但控制上下文

函数先拼 stdout，再以 `[stderr]` 标识拼 stderr。合并后的 UTF-8 字节超过 8000 时，保留前 4000 和后 4000 字节，并插入截断说明。保留尾部很重要：测试错误、堆栈和退出提示通常在结尾。

按字节截断可严格限制上下文体积，但多字节中文恰好被从中切开时可能显示替换字符；对于教学工具是可接受权衡。

## 安全边界

- `cwd: workDir` 仅设定默认目录，命令可写绝对路径、访问网络或启动进程；不是沙箱。
- 真正的高风险命令应由 Registry middleware 做人工审批；不可信任务应使用容器/OS 隔离。
- 当前 timeout 只 kill 直接子进程，复杂 shell 命令的孙进程可能残留；可使用进程组管理。
- 继承完整 `process.env`，可能把敏感环境变量暴露给命令；生产场景可使用 allowlist。

## 总结

`bash.js` 不是让 Shell 变安全，而是为 Agent 提供可等待、可诊断、有限时间与有限输出的 Shell 执行接口。安全仍需要审批、最小权限和外部隔离共同保证。