# `write-file.js` 详细讲解：在工作区创建或覆盖文件

`WriteFileTool` 提供 `write_file`，用于创建新文件或以完整 content 覆盖已有文件。它适合新文件生成；对已有大文件的局部修改应优先使用 `edit_file`。

## 模型契约

`definition()` 用 JSON Schema 要求：

- `path`：相对工作区的目标路径；
- `content`：完整文件内容。

该约束很重要：写入工具不会自动合并旧内容，模型若只给片段会覆盖原文件。

## 执行流程

```js
const fullPath = resolveWorkspacePath(this.workDir, args.path);
fs.mkdirSync(path.dirname(fullPath), { recursive: true });
fs.writeFileSync(fullPath, args.content, 'utf-8');
```

`resolveWorkspacePath()` 阻止普通路径穿越；`mkdirSync(..., { recursive: true })` 自动创建缺失父目录；随后以 UTF-8 整体写入。成功返回简短确认文本。

异常统一包装为 `写入文件失败: ...`，由 Registry 转为 isError，供 RecoveryManager 解释路径/权限问题。

## 为什么没有符号链接真实路径检查

写入新文件时目标可能尚不存在，无法调用 `realpath`。当前实现仅有词法边界保护。若目标已存在且是工作区内指向外部的符号链接，写入仍可能跟随链接；这是比 read/edit 更弱的安全点。生产实现可对存在目标先 realpath 校验，对新文件使用安全目录遍历或沙箱。

## 同步 API 与风险

尽管 `execute()` 标记为 async，内部是同步 mkdir/write；返回 Promise 是为了符合统一工具接口。小文件教学场景简单，但大内容会阻塞 Node 事件循环。写入是直接覆盖，未使用临时文件 + rename，因此进程中断可能留下部分内容；关键配置文件可采用原子写入策略。

## 总结

`write-file.js` 将文件创建简化为“路径边界 + 自动建目录 + 完整覆盖”，功能直接但风险明确：模型应先读再改，危险写入应由 Registry 中间件审批。