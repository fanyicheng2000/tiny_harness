# `skill.js` 详细讲解：从工作区加载 Agent Skills

`src/context/skill.js` 定义 `Skill` 数据对象与 `SkillLoader`。它递归查找工作区 `.tiny-harness/skills/` 下的 `SKILL.md`，解析少量 frontmatter 信息，并拼接成可注入 System Prompt 的文本。

## 1. Skill 文件约定

预期目录结构：

```text
<workDir>/.tiny-harness/skills/<skill-name>/SKILL.md
```

可选 frontmatter：

```markdown
---
name: deploy-helper
description: 当需要部署测试环境时使用
---
执行步骤……
```

- `name`：展示给模型的技能名；
- `description`：触发条件；
- 正文：具体执行指南。

没有 frontmatter 时，整份文件作为正文，名称和描述使用默认值。

## 2. `loadAll()`：找到、读取、格式化

```js
const skillBaseDir = path.join(this.workDir, '.tiny-harness', 'skills');
if (!fs.existsSync(skillBaseDir)) return '';
```

技能目录不存在时返回空字符串，PromptComposer 因此可在没有技能的项目正常工作。

若存在目录，`_findSkillFiles()` 递归收集所有文件名恰为 `SKILL.md` 的路径。随后逐个读取和解析，格式化为：

```markdown
#### 技能名称: <name>
**触发条件**: <description>

**执行指南**:
<body>
```

单个文件读取/解析失败会被 catch 并跳过，不会阻止 Agent 启动。最终不足 50 字符时返回空串，避免只注入无意义标题。

## 3. 递归搜索

```js
const entries = fs.readdirSync(dir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) results.push(...this._findSkillFiles(fullPath));
  else if (entry.name === 'SKILL.md') results.push(fullPath);
}
```

它允许技能按多级目录组织。当前无最大递归深度、文件数量或文件大小限制；不可信或巨大工作区可能造成启动耗时与 Prompt 膨胀，生产系统应增加限制和忽略规则。

## 4. 简化 frontmatter 解析

`_parseSkillMD()` 只在内容以 `---` 开头时解析，随后通过 `content.split('---')` 拆分，逐行匹配 `name:` 与 `description:`。

这不是完整 YAML 解析器：不支持嵌套、引号转义、多行字段或正文中复杂分隔符。优势是零依赖、教学直观；若需兼容通用 Skill 生态，应使用可靠 YAML parser 并校验 schema。

## 5. 安全语义

Skill 正文会被直接注入 system prompt，因此 SKILL.md 本质上是高权限指令来源。只能从可信工作区加载，且应审查外部仓库携带的技能。文件读取失败被静默吞掉便于可用性，但可能隐藏配置问题；调试模式可记录被跳过的路径和原因。

## 6. 总结

`skill.js` 将专业操作指南从引擎和固定提示词中分离出来，形成“文件即能力包”的扩展机制。PromptComposer 负责把它纳入模型上下文，Agent 则根据 description 与任务匹配后遵循正文步骤。