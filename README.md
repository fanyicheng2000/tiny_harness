# tiny-harness (Node.js 版)

> 一个用 Node.js 实现的极简 Agent Harness
>
> 一套覆盖 15 讲的教学实现 / 0 运行时依赖 / 离线可演示。
>
> 适合 300 人 2 小时技术分享的演示和教学材料。

## 一句话介绍

**Agent ≠ 大模型**。大模型只能"想"，不能"做"。要让大模型真正干活，需要给它套一层"外骨骼"——记忆系统、工具调用、错误恢复、审批拦截、可观测性。这层外骨骼就叫 **Harness**。本项目就是这层 Harness 的最小可用实现。

## 项目特色

- 🎯 **教学优先**：每个源码文件头都有 ~30 行注释解释"为什么这么写"
- 🪶 **离线可跑**：内置 Mock Provider，0 成本演示每个机制，无需 API key
- 🔄 **代码对照**：每个文件标注对应的 Go 源码，方便交叉阅读
- 🎨 **交互演示**：HTML + SSE 实时显示 Agent 思考过程和 Span 树
- 🏗️ **工程导向**：覆盖常见的 Agent 可靠性问题与应对机制
- 🔌 **可扩展**：Provider / Tool / Reporter 都是接口，照葫芦画瓢能加新能力

## 5 分钟跑通

```bash
# 1. 克隆项目
git clone <this-repo>
cd new-harness

# 2. 直接跑（mock 模式，无需 API key）
npm start

# 3. 看死循环检测
node src/index.js --provider mock --script loop

# 4. 看 Plan Mode 持久化
node src/index.js --provider mock --script plan-mode --plan --dir /tmp/test

# 5. 启动交互式 HTML 演示
node demos/server.js
# 浏览器打开 http://localhost:3000
```

## 真调 LLM

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env，选择一种协议并填写对应配置
# OpenAI 兼容协议：OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL
# Claude 兼容协议：CLAUDE_API_KEY / CLAUDE_MODEL / CLAUDE_BASE_URL

# 真调 OpenAI 兼容协议
node src/index.js --provider openai --prompt "请读取 README.md" --thinking --plan
```

## 多轮对话（REPL）

像 Claude Code 一样持续对话，跨轮共享上下文，会话自动落盘、可断点续传：

```bash
# 1. 在 .env 里填好任一 key（配哪个用哪个，自动判断）
#    OPENAI_API_KEY=sk-...   或   CLAUDE_API_KEY=sk-ant-...

# 2. 一键进入多轮对话
npm run chat
```

`npm run chat` 会自动选用配好 key 的协议（两个都配了时优先 Claude）。进入后逐行输入即可多轮对话，跨轮保留工具调用历史。

REPL 里的特殊命令：

| 命令 | 作用 |
|------|------|
| `/exit` `/quit` | 退出 |
| `/cost` | 查看累计花费 |
| `/history` | 查看会话历史条数 |
| `/clear` | 清空当前会话历史 |
| `/yolo` | 切换到 YOLO（不再审批） |
| `/think` | 切换慢思考 ON/OFF |
| `/plan` | 切换 Plan Mode ON/OFF |
| `/help` | 显示帮助 |

退出后会话仍保留在 `.tiny-harness/sessions/`，下次用 `--session <id>` 可断点续传。

## 15 讲核心模块

> 教程见 [`docs/TUTORIAL_NEW.md`](./docs/TUTORIAL_NEW.md)（新教程，与源码逐行核对）。老教程 `docs/TUTORIAL.md` 保留作参考。

| # | 讲 | 一句话 | 源码 |
|---|------|--------|------|
| 01 | [ReAct 主循环](./docs/TUTORIAL_NEW.md) | `while(true) { 想 → 做 → 看 → 退出判断 }` | `src/engine/loop.js` |
| 02 | [慢思考两阶段](./docs/TUTORIAL_NEW.md) | Phase 1 思考（不传 tools）+ Phase 2 行动 | `loop.js` Phase 1/2 |
| 03 | [Provider 抽象](./docs/TUTORIAL_NEW.md) | OpenAI ↔ Claude 双向翻译 | `provider/*.js` |
| 04 | [Tool Registry](./docs/TUTORIAL_NEW.md) | 注册表 + 中间件 + isError 不抛 | `registry.js` |
| 05 | [工具四件套](./docs/TUTORIAL_NEW.md) | read/write/edit/bash 边界处理 | `tools/*.js` |
| 06 | [Edit 容错](./docs/TUTORIAL_NEW.md) | fuzzyReplace 四级渐进匹配 | `edit-file.js` |
| 07 | [并发执行](./docs/TUTORIAL_NEW.md) | Promise.all + toolCallId 回填 | `loop.js` |
| 08 | [System Prompt 三层注入](./docs/TUTORIAL_NEW.md) | 核心 / AGENTS.md / Skills | `composer.js` |
| 09 | [Session 持久化](./docs/TUTORIAL_NEW.md) | Working Memory + JSONL 三分支 | `session.js` |
| 10 | [上下文压缩](./docs/TUTORIAL_NEW.md) | 三档阶梯降级防爆 | `compactor.js` |
| 11 | [Plan Mode](./docs/TUTORIAL_NEW.md) | PLAN.md + TODO.md 三纪律 | `composer.js` |
| 12 | [失败处理两道防线](./docs/TUTORIAL_NEW.md) | Recovery 软引导 + Reminder 硬叫醒 | `recovery.js` + `reminder.js` |
| 13 | [人类审批](./docs/TUTORIAL_NEW.md) | 中间件拦截 + readline 异步 | `index.js` |
| 14 | [可观测性](./docs/TUTORIAL_NEW.md) | Span 树 + CostTracker 装饰器 | `observability/*.js` |
| 15 | [实战真调](./docs/TUTORIAL_NEW.md) | 把 14 讲拼起来跑真实任务 | `index.js` 全装配 |

详见 [完整教程](./docs/TUTORIAL_NEW.md)。

## 项目结构

```
new-harness/
├── README.md                  ← 你正在看的就是这个
├── package.json               ← 项目配置（0 依赖）
├── .env.example               ← 环境变量模板
│
├── src/                       ← 源码（~1800 行）
│   ├── index.js               ← CLI 入口 + 终端审批
│   ├── schema/
│   │   └── message.js         ← 数据结构层（Message / ToolCall / ...）
│   ├── provider/
│   │   ├── interface.js       ← BaseProvider 接口
│   │   ├── openai.js          ← OpenAI 兼容协议 Provider
│   │   ├── claude.js          ← Claude 兼容协议 Provider
│   │   └── mock.js            ← Mock Provider（教学用，5 个剧本）
│   ├── context/
│   │   ├── session.js         ← 会话管理 + Working Memory
│   │   ├── composer.js        ← System Prompt 三层注入
│   │   ├── compactor.js       ← 上下文压缩
│   │   ├── recovery.js        ← 错误自愈
│   │   └── skill.js           ← SKILL.md 加载器
│   ├── tools/
│   │   ├── registry.js        ← 工具注册表 + Middleware
│   │   ├── read-file.js       ← 读文件（8KB 截断）
│   │   ├── write-file.js      ← 写文件（自动 mkdir）
│   │   ├── edit-file.js       ← 改文件（4 级 fuzzyReplace）
│   │   └── bash.js            ← 跑命令（30s 超时）
│   ├── engine/
│   │   ├── loop.js            ← ReAct 主循环（最核心）
│   │   ├── reminder.js        ← 死循环检测
│   │   ├── reporter.js        ← Reporter 接口
│   │   └── terminal-reporter.js ← 终端输出
│   └── observability/
│       ├── trace.js           ← Span 树（AsyncLocalStorage）
│       └── tracker.js         ← CostTracker 装饰器
│
├── examples/                  ← 6 个可跑示例
│   ├── 01-simple-loop.js      ← 最简 ReAct
│   ├── 02-with-tools.js       ← 4 工具 + 并发
│   ├── 03-with-plan-mode.js   ← Plan Mode
│   ├── 04-loop-detection.js   ← 死循环检测
│   ├── 05-approval.js         ← 人类审批
│   └── 06-real-task.js        ← 真调 LLM
│
├── docs/
│   ├── TUTORIAL_NEW.md        ← 15 讲新教程（与源码逐行核对）
│   └── TUTORIAL.md            ← 老教程（保留参考）
│
└── demos/                     ← 交互式演示
    ├── server.js              ← SSE 流式推送服务器
    └── interactive.html       ← 单页 UI（控制台 + Trace 树 + 文件查看）
```

## CLI 用法

```bash
node src/index.js [选项]

选项:
  --prompt, -p <text>      任务描述（必填，除非用 --script 演示）
  --dir, -d <path>         工作区目录（默认: 当前目录）
  --session, -s <id>       会话 ID（用于断点续传）
  --provider <name>        协议: mock | openai | claude | auto (默认: auto)
                           auto = 自动选用配好 key 的协议（Claude 优先）
  --script <name>          Mock 模式剧本: read-file | write-and-read | loop | approval | plan-mode
  --thinking               开启慢思考两阶段
  --plan                   开启 Plan Mode（PLAN.md + TODO.md 持久化）
  --require-approval       强制对 bash / edit_file / write_file 人工审批
  --auto-approve, --yolo   跳过工具人工审批（不提供系统隔离）
  --help, -h               显示帮助
```

## 6 个示例速览

```bash
npm run demo:1   # 最简 ReAct 循环（mock + read-file）
npm run demo:2   # 4 工具齐全 + 并发执行
npm run demo:3   # Plan Mode 持久化 + 实时打勾
npm run demo:4   # 死循环检测（连续 3 次失败 → 干预）
npm run demo:5   # 人类审批中间件
npm run demo:6   # 真调 OpenAI 兼容协议 / Claude 兼容协议
```

### 其他常用命令

```bash
npm run chat     # 进入真 LLM 多轮对话（自动选配好 key 的协议）
npm start        # 离线 mock 演示（无需 API key）
npm run server   # 启动交互式 HTML 演示（浏览器打开 localhost:3000）
```

## 安全与计费边界

- 文件工具会拒绝明显的工作区路径穿越；读取和编辑已有文件还会检查符号链接的真实目标。这是路径边界保护，不是完整沙箱，也不消除所有符号链接竞态。
- `bash` 只把默认工作目录设为 `--dir`，不会隔离进程；命令仍拥有当前 Node.js 进程的系统权限。面对不可信任务时应使用容器或操作系统级隔离。
- Session 仅以 JSONL 追加写方式持久化到 `.tiny-harness/sessions/`，可跨进程恢复；进程中断时最多丢失最后一行。同一 session ID 的并发写入不受支持。
- Token 用量来自供应商响应。金额是按代码内价格快照计算的本地估算，按币种分别展示；未知模型显示“未配置”，最终以供应商账单为准。

## 演示服务器

```bash
npm run server
# 或
node demos/server.js
# 浏览器打开 http://localhost:3000
```

5 个内置剧本（mock 模式，0 成本）：
1. **ReAct 循环**：最简单的"思考 → 工具 → 结束"
2. **并发工具执行**：同时写 + 读，演示 Promise.all
3. **死循环检测**：连续 3 次失败触发 Reminder 干预
4. **人类审批**：`rm -rf` 危险命令被中间件拦截
5. **Plan Mode**：PLAN.md + TODO.md 全流程 + 实时打勾

界面分三栏：
- 左栏：剧本选择 + 启动按钮 + 运行统计
- 中栏：实时控制台输出（彩色 + 时间戳）
- 右栏：Trace Span 树可视化 + 生成的文件预览

## 与 Go 原版的对照

| 维度 | Go 原版 (ch22) | Node.js 版 |
|------|---------------|-----------|
| 代码量 | 2195 行（23 文件） | ~1800 行（20 文件） |
| 并发模型 | goroutine + WaitGroup | Promise.all |
| Context 传递 | context.Context | AsyncLocalStorage |
| 互斥锁 | sync.RWMutex | 不需要（单线程） |
| 接口表达 | interface + struct | class + extends |
| 离线演示 | 无 | ✅ Mock Provider |
| 审批方式 | 飞书机器人 | 终端 readline |
| HTML 演示 | 无 | ✅ SSE + 单页 UI |
| 工作目录限制 | 当前目录 | 任意 `--dir` |

主要源码对照：

| Node.js 文件 | 对应 Go 文件 |
|-------------|-------------|
| `src/engine/loop.js` | `internal/engine/loop.go` |
| `src/engine/reminder.js` | `internal/engine/reminder.go` |
| `src/provider/openai.js` | `internal/provider/openai.go` |
| `src/provider/claude.js` | `internal/provider/claude.go` |
| `src/tools/edit-file.js` | `internal/tools/edit_file.go` |
| `src/context/compactor.js` | `internal/context/compactor.go` |
| `src/context/session.js` | `internal/context/session.go`（Node 版增加 JSON 落盘） |
| `src/context/composer.js` | `internal/context/composer.go` |
| `src/context/recovery.js` | `internal/context/recovery.go` |
| `src/observability/trace.js` | `internal/observability/trace.go` |
| `src/observability/tracker.js` | `internal/observability/tracker.go` |

## 技术栈

- **运行时**：Node.js ≥ 18（用了原生 fetch / AsyncLocalStorage / ESM）
- **依赖**：0 个运行时依赖（全用 Node 内置模块）
- **可选依赖**：`openai` SDK（如果要用官方 SDK 替代 fetch）
- **测试**：Node.js 内置测试运行器（`npm test`）+ examples / demos 回归

## 你能学到什么

读完这个项目，你将能：

1. **看懂任何 Agent 框架**的底层逻辑（LangChain / AutoGen / Claude Code）
2. **自己从零搭一个**可运行、可扩展的教学版 Agent Harness
3. **识别 Agent 系统的常见坑**：死循环、上下文爆炸、幻觉、烧钱
4. **把这些机制迁移到任意语言**：Python / Rust / Go / Java 都行

## 适合谁

- 想理解 Agent 内部机制的开发者
- 准备做技术分享 / 培训的讲师
- 评估 Agent 框架选型的架构师
- 学习 Node.js 异步编程的工程师

## 进一步学习

### 阅读其他 Agent 框架源码

- [Aider](https://github.com/Aider-AI/aider) —— edit 工具的 fuzzyReplace 进阶版
- [Claude Code](https://docs.claude.com/en/docs/build-with-claude/overview) —— 工业级 Harness 设计
- [OpenHands](https://github.com/All-Hands-AI/OpenHands) —— 多 Agent 协作
- [LangGraph](https://github.com/langchain-ai/langgraph) —— 状态机式编排

### 经典论文

- [ReAct](https://arxiv.org/abs/2210.03629) (Yao et al., 2022) —— Reasoning + Acting 交替
- [Toolformer](https://arxiv.org/abs/2302.04761) (Schick et al., 2023) —— 模型自学用工具
- [Reflexion](https://arxiv.org/abs/2303.11366) (Shinn et al., 2023) —— 自反思 + 外部记忆
- [Self-Refine](https://arxiv.org/abs/2303.17651) (Madaan et al., 2023) —— 迭代精化
- [Tree of Thoughts](https://arxiv.org/abs/2305.10601) (Yao et al., 2023) —— 多路径探索
- [Lost in the Middle](https://arxiv.org/abs/2307.03172) (Liu et al., 2023) —— 长上下文失效

## License

MIT

## 致谢

- ReAct 论文：Yao et al., 2022
- 工业实践：Anthropic Claude Code、OpenAI Codex、Cursor、Aider
