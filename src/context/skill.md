# `skill.js` 详细讲解：渐进式加载 Agent Skills

`src/context/skill.js` 定义了 `Skill` 数据对象和 `SkillLoader`。它管理工作区中的 `.tiny-harness/skills/**/SKILL.md`，但**不会再把所有技能正文一次性注入 System Prompt**。

当前实现采用渐进式加载（Progressive Disclosure）：

```text
启动 Agent
  ↓
SkillLoader 扫描技能文件，只读取 name / description
  ↓
PromptComposer 注入轻量「技能目录」到 System Prompt
  ↓
模型发现任务命中某项技能
  ↓
模型调用 read_skill({ skill_name })
  ↓
SkillLoader 仅读取该技能的完整正文
  ↓
工具结果回到模型上下文，模型遵循对应指南执行
```

这个设计把“我有哪些技能”和“某个技能具体怎么执行”拆开：前者始终很小，后者只有真正需要时才加载。

---

## 1. 为什么从全量加载改为渐进式加载

旧实现的逻辑是：扫描到所有 `SKILL.md` 后，将每一个文件的 `name`、`description` 和**完整正文**拼接为一个大字符串，再注入 System Prompt。

如果有 20 个技能，每个技能有 5,000 字，即使当前用户只是让 Agent 读一个文件，模型也会在每轮看到约 100,000 字的无关技能指南。问题包括：

- **上下文浪费**：每次模型调用都会带上全部技能正文，消耗 Token；
- **模型干扰**：大量无关指令可能降低模型对当前任务和核心规则的注意力；
- **扩展性差**：增加一个技能会让所有任务的 Prompt 变长；
- **安全面扩大**：所有工作区技能都会立即成为模型可见的高优先级指令；
- **难以观测**：无法从工具调用历史判断模型实际使用了哪些技能。

渐进式加载后，常驻上下文只保留目录信息：

```markdown
### 可用专业技能（按需加载）
以下仅为技能目录，未加载任何技能正文。当任务匹配某项触发条件时，先调用 `read_skill` 获取完整执行指南。

- `git-review`：当用户要求审查 Git 改动时使用
- `deploy-helper`：当需要部署测试环境时使用
```

完整正文会在模型明确调用 `read_skill` 后，以普通 ToolResult 的方式进入本次任务的后续上下文。

---

## 2. Skill 文件约定

预期目录结构：

```text
<workDir>/.tiny-harness/skills/<skill-name>/SKILL.md
```

一个标准技能文件示例：

```markdown
---
name: deploy-helper
description: 当需要部署测试环境时使用
---

1. 先检查构建状态。
2. 再确认目标环境与分支。
3. 执行部署并验证健康检查。
```

三个部分的职责：

| 内容 | 在何时使用 | 用途 |
| --- | --- | --- |
| `name` | 启动扫描时 | 作为 `read_skill` 的精确 `skill_name` |
| `description` | 启动扫描时 | 注入技能目录，帮助模型判断是否命中 |
| frontmatter 后的正文 | 调用 `read_skill` 时 | 作为完整执行指南返回给模型 |

没有 frontmatter 时，解析器会使用默认名称 `Unknown Skill`、默认描述 `No description provided.`，并把整个文件当成正文。实际项目应尽量提供 `name` 和 `description`；否则多个无 frontmatter 文件会得到重复的默认名称，后发现的重复项会被跳过。

---

## 3. `Skill`：技能在内存中的数据形态

```js
export class Skill {
  constructor({ name, description, filePath, body } = {}) {
    this.name = name;
    this.description = description;
    this.filePath = filePath;
    this.body = body;
  }
}
```

字段含义：

- `name`：唯一技能名，如 `git-review`；
- `description`：简短触发条件；
- `filePath`：该 `SKILL.md` 在本机的实际路径，仅供 Loader 内部定位文件；
- `body`：完整执行指南。

注意：调用 `listSkills()` 时返回的目录项会刻意让 `body` 保持空字符串。这样即使 `PromptComposer` 拿到目录项，也不会误将完整技能正文拼入 System Prompt。

---

## 4. `listSkills()`：只扫描目录元数据

```js
const skills = new SkillLoader(workDir).listSkills();
```

执行过程：

1. 计算技能根目录：`<workDir>/.tiny-harness/skills`；
2. 目录不存在时返回 `[]`，没有技能不应导致 Agent 启动失败；
3. `_findSkillFiles()` 递归找出所有文件名为 `SKILL.md` 的普通文件；
4. `_readMetadata()` 读取文件并通过 `_parseSkillMD()` 提取 `name`、`description`；
5. 返回 `Skill[]`，其中仅含 `name`、`description`、`filePath`，不保留 `body`；
6. 若同名技能重复，保留先发现的一个，后发现的跳过并打印警告。

这里仍会读取一次文件，因为当前简单 frontmatter 格式没有独立元数据文件，必须从 `SKILL.md` 头部解析 `name` 和 `description`。但读取后的正文不会进入模型 Prompt，也不会长时间保存在目录项中。

### 为什么要去重

`read_skill` 只接受技能名称，不接受任意文件路径。若同名技能对应多个文件，模型无法明确要加载哪一个，因此 Loader 用 `seenNames` 保证名称到文件路径是一对一映射。

生产系统可以更严格：重复名称直接在启动时失败，或要求使用命名空间，例如 `team-a/git-review`。

---

## 5. `buildCatalog()`：注入 System Prompt 的内容

`PromptComposer.build()` 中调用：

```js
const skillCatalog = this.skillLoader.buildCatalog();
if (skillCatalog) {
  prompt += skillCatalog;
}
```

`buildCatalog()` 会把 `listSkills()` 的结果格式化为：

```markdown
### 可用专业技能（按需加载）
以下仅为技能目录，**未加载任何技能正文**。当用户任务明显符合某项触发条件时，先调用 `read_skill` 工具并传入对应 `skill_name`，获取完整执行指南后再执行；不匹配时不要加载。

- `git-review`：当用户要求审查 Git 改动时使用
- `deploy-helper`：当需要部署测试环境时使用
```

它故意不包含：

- `skill.body`；
- 技能文件路径；
- 所有技能的完整 Markdown 正文。

因此 Agent 只知道“有哪些能力”和“什么时候值得加载”，不知道“具体步骤是什么”。这正是渐进式加载的边界。

---

## 6. `read_skill`：按需读取完整正文

`src/tools/read-skill.js` 定义 `ReadSkillTool`，在 `src/index.js` 中注册到主 `Registry`：

```js
registry.register(new ReadSkillTool(workDir));
```

因此模型可看到下面的工具定义：

```text
read_skill({ skill_name: string })
```

当用户说“审查当前 Git 改动”时，模型先从目录看到 `git-review` 的触发条件匹配，再调用：

```js
read_skill({ skill_name: 'git-review' })
```

工具内部流程：

```text
ReadSkillTool.execute(args)
  ↓
SkillLoader.loadSkill(args.skill_name)
  ↓
在已扫描目录中按精确 name 查找
  ↓
确认对应 SKILL.md 的真实路径仍在 skills 根目录内
  ↓
读取这个文件、解析正文
  ↓
返回「技能名 + 触发条件 + 完整执行指南」
```

返回示例：

```text
技能名称: git-review
触发条件: 当用户要求审查 Git 改动时使用

完整执行指南:
1. 执行 git diff。
2. 检查测试。
3. 按风险等级输出结论。
```

这个结果会像 `read_file` 的结果一样，通过 `ToolResult` 写入当前 Session，模型在下一轮便能根据指南继续执行。

### 为什么不让模型传文件路径

错误设计会是：

```js
read_skill({ path: '.tiny-harness/skills/xxx/SKILL.md' })
```

模型就可以猜测任意路径，工具也会退化成又一个通用读文件接口。当前设计只接受 `skill_name`，并只在 `listSkills()` 已发现的目录项中查找，这样名称是受控的，技能加载边界清楚。

---

## 7. 路径与输出安全边界

### 7.1 技能路径边界

`loadSkill(name)` 不是只信任扫描到的 `filePath`。读取前会执行：

```js
const baseReal = fs.realpathSync(this._skillBaseDir());
const fileReal = fs.realpathSync(skill.filePath);
const relative = path.relative(baseReal, fileReal);
```

`realpathSync()` 会解析符号链接。如果表面上位于 `.tiny-harness/skills` 下的 `SKILL.md` 实际链接到工作区外，`relative` 会以 `..` 开头，Loader 会拒绝加载。

这与文件工具中的工作区路径防护思想相同：不能只校验字面路径，还要校验符号链接解析后的真实路径。

### 7.2 输出长度边界

`ReadSkillTool` 设置：

```js
const MAX_SKILL_CHARS = 16000;
```

若单个技能正文超过这个长度，工具只返回前 16,000 个字符，并追加截断提示。它不能替代更合理的技能拆分，但能防止一个异常大的 `SKILL.md` 一次撑爆模型上下文。

### 7.3 信任边界

渐进式加载降低了无关技能对每个任务的影响，但**不会让不可信 Skill 自动变安全**。一旦模型调用 `read_skill`，正文仍会作为指导模型行为的文本进入上下文。

因此：

- 只应加载可信工作区中的 Skills；
- 接入外部仓库前应审查其 `.tiny-harness/skills/`；
- 高风险 Skill 中的写文件、Shell、部署步骤仍应通过 Registry middleware 和人工审批；
- 不要因为内容来自 Skill 就绕过路径、工具权限、审批和审计。

---

## 8. 与全量加载的对比

| 维度 | 旧版：`loadAll()` | 当前：目录 + `read_skill` |
| --- | --- | --- |
| System Prompt | 所有技能完整正文 | 仅名称与触发条件 |
| 完整正文进入上下文 | 每次运行一开始 | 模型命中后按需调用 |
| Token 成本 | 与所有技能总长度线性相关 | 与实际使用的技能数量相关 |
| 无关指令干扰 | 高 | 低 |
| 工具调用数 | 少一次 | 每次加载技能多一次 ToolCall |
| 审计能力 | 不易知道使用了哪项技能 | 可通过 `read_skill` ToolCall 精确追踪 |
| 适合场景 | 技能极少且都很短 | 技能多、正文长、专业领域多的项目 |

渐进式加载不是免费的：模型需要先从 `description` 正确识别技能，再额外调用一次工具。为确保它能正确选择，`name` 应稳定、`description` 应简洁但具体，不能只写“有帮助时使用”。

---

## 9. 测试覆盖

新增 `test/skill-loader.test.js` 覆盖了关键契约：

1. `buildCatalog()` 包含技能名和触发条件，但不包含正文；
2. `read_skill` 能按名称加载一个技能的完整正文；
3. 不在目录中的技能名会被拒绝；
4. `PromptComposer` 注入的是目录而不是完整正文。

运行：

```bash
node --test test/skill-loader.test.js
```

当前测试结果为 4 个通过、0 个失败。

---

## 10. 可继续改进的方向

当前实现是教学项目中的安全最小版本，后续可以增强：

1. **元数据独立化**：用 `skill.json` / `skill.yaml` 存 name 和 description，目录扫描时不必读取 Markdown 正文；
2. **缓存与失效策略**：为频繁加载的 metadata 缓存文件 mtime，减少重复扫描；
3. **更完整的 YAML 解析**：使用可靠 parser 并校验 schema，支持引号、多行 description、版本和权限声明；
4. **权限元数据**：在 frontmatter 声明 `allowed_tools`、风险等级、是否需要人工确认；
5. **技能检索**：技能达到几百个时，不宜把所有 description 都放入目录；可加关键词 / 向量检索工具；
6. **一次任务内的已加载标记**：提示模型已读取的技能，避免重复调用 `read_skill`；
7. **技能版本与来源**：在 ToolResult 返回版本、哈希、来源，支持审计和复现；
8. **更严格的大小和数量限制**：限制目录深度、技能数量、frontmatter 大小和单技能正文大小。

---

## 11. 总结

`skill.js` 现在不是“把技能全文塞入 Prompt 的拼接器”，而是一个受控的技能目录与按需正文加载器：

```text
SkillLoader.listSkills()
  → 只取 name / description / filePath
  → buildCatalog()
  → System Prompt 只得到目录

模型命中技能
  → ReadSkillTool.execute({ skill_name })
  → SkillLoader.loadSkill(name)
  → ToolResult 返回一个技能的完整正文
```

这使 Agent Skills 从“全量常驻上下文”变为“按需获取的专业操作手册”，在技能规模增长时显著降低 Token 成本、上下文噪声和无关指令影响，同时让每次技能使用都可通过工具调用记录追踪。
