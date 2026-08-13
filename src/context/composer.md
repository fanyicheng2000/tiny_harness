# `composer.js` 详细讲解：三层 System Prompt 组装器

`PromptComposer` 负责在 Agent 运行开始时构造内部 `Role.SYSTEM` 消息。它将通用行为规则、项目规则和技能规则整合为模型每轮都会看到的上下文。

## 输入与输出

```js
const composer = new PromptComposer(workDir, planMode);
const systemMessage = composer.build();
```

- `workDir`：当前任务工作区，用于寻找 `AGENTS.md` 和 `.tiny-harness/skills/`。
- `planMode`：是否加入长程任务状态外化规则。
- 输出：`new Message({ role: Role.SYSTEM, content: prompt })`。

`loop.js` 在 `run()` 开始时构造一次并复用该消息；Compactor 保证它不被压缩。

## 第一层：核心身份与纪律

代码直接写入通用规则，包括：查目录用 bash、建文件用 write_file、编辑前先读、工具报错先看 stderr、始终中文回复等。

这层的特点是与仓库无关、每次必定存在。它相当于 Harness 的最低行为基线，而不是用户临时输入。

## Plan Mode：条件注入

当 `planMode` 为真，Prompt 追加一段强制工作流：

1. 先检查 `PLAN.md` 与 `TODO.md`；
2. 新任务创建计划和 checkbox 待办；
3. 续传时读取已有文件，不能覆盖；
4. 每完成一步立即打勾；
5. 出错或迷失时重新读取 TODO。

它不是独立调度器，而是“提示词纪律 + 文件工具 + Session”组合实现的轻量长期任务机制。优势是简单、文件可读；缺点是模型仍可能不遵守，生产场景可增加硬校验。

## 第二层：项目级 `AGENTS.md`

```js
const agentsMdPath = path.join(this.workDir, 'AGENTS.md');
try {
  const content = fs.readFileSync(agentsMdPath, 'utf-8');
  prompt += `...${content}...`;
} catch {
  // 不存在时跳过
}
```

每个项目可用 AGENTS.md 写入构建命令、目录约定、测试要求等。缺失或读取失败被静默跳过，保证任何项目都能启动。

## 第三层：动态 Skills

```js
const skillsContent = this.skillLoader.loadAll();
if (skillsContent) prompt += skillsContent;
```

SkillLoader 会递归读取 `.tiny-harness/skills/*/SKILL.md`，将触发条件和执行指南注入。它把可复用专业操作从核心提示词中拆出，避免所有项目共享同一大段规则。

## 工程注意点

- 文件读取采用同步 API，因为只在一次 Agent Run 初始化时执行，简化实现；若技能很多或在高并发服务中可换异步/缓存。
- 直接将 AGENTS 和 Skill 正文拼入 prompt，意味着它们属于可执行指令来源，应只加载可信工作区内容。
- 固定核心规则与项目规则可能冲突，当前没有优先级解析；模型只能通过文本顺序理解。

## 总结

`composer.js` 将 Agent 行为从硬编码循环中抽离：核心纪律提供底线，AGENTS.md 提供仓库语境，Skills 提供按需专业能力，Plan Mode 为长任务补充持久化流程。