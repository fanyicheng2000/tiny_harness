# `read-file.js` 详细讲解：受工作区限制的文件读取工具

`ReadFileTool` 将本地文件内容作为工具观察返回模型。它的关键不是 `readFileSync` 本身，而是读取前的双重路径检查与读取后的长度限制。

## 工具声明

`name()` 返回 `read_file`；`definition()` 返回 JSON Schema，要求模型提供相对工作区的 `path`。这个 schema 会经 Registry 与 Provider 发送给模型。

## 执行流程

```js
const fullPath = resolveWorkspacePath(this.workDir, args.path);
const safePath = assertExistingPathInsideWorkspace(this.workDir, fullPath);
const content = fs.readFileSync(safePath, 'utf-8');
```

第一步阻止 `..` 和绝对路径逃逸；第二步解析符号链接，避免工作区内链接到外部文件。两步都通过后才读取。

## 为什么截断

```js
if (content.length > MAX_LEN) {
  return content.slice(0, MAX_LEN) + '...已截断...';
}
```

`MAX_LEN = 8000`，按 JavaScript 字符统计。文件日志可能极大，完整塞入模型上下文会浪费 Token 并触发压缩；教学版保留文件头部，提示模型内容被截断。需要尾部日志时，模型应使用 bash 的 `tail` 或未来的 offset/limit 参数。

## 错误设计

所有异常被包装为 `打开文件失败: ...` 后抛出，Registry 会转成 `ToolResult.isError`，RecoveryManager 可据 ENOENT 等关键词提示模型先 `ls` / `find`，而不是猜路径。

## 边界

同步读取在小型 CLI 教学项目中简单可靠，但读取大文件仍会短暂阻塞事件循环；截断发生在内容已全部读入之后。生产版本可先 `stat` 检查大小、使用流式读取或支持行范围。

## 总结

该工具将“读取文件”限制为工作区内、可控长度、可诊断失败的模型能力，而不是裸露的 fs 访问。