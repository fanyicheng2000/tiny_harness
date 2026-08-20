// ===========================================
// src/index.js
// ===========================================
// CLI 入口：装配所有组件，发起主循环
//
// 用法示例：
//   # 离线演示（推荐，无需 API key）
//   node src/index.js --prompt "读取 README" --provider mock --script read-file
//
//   # OpenAI 兼容协议
//   node src/index.js --prompt "读取 README" --provider openai
//
//   # Claude 兼容协议
//   node src/index.js --prompt "读取 README" --provider claude
//
//   # 开启 Plan Mode + 慢思考
//   node src/index.js --prompt "搭建一个 TODO 应用" --provider openai --plan --thinking
//
//   # 强制要求每个 bash/edit 都人工审批
//   node src/index.js --prompt "..." --provider mock --require-approval
//
//   # 断点续传
//   node src/index.js --prompt "继续做" --session my-task-001
// ===========================================

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import { Message, Role } from './schema/message.js';
import { globalSessionMgr } from './context/session.js';
import { Registry } from './tools/registry.js';
import { ReadFileTool } from './tools/read-file.js';
import { ReadSkillTool } from './tools/read-skill.js';
import { RunSubagentTool } from './tools/run-subagent.js';
import { WriteFileTool } from './tools/write-file.js';
import { EditFileTool } from './tools/edit-file.js';
import { BashTool } from './tools/bash.js';
import {
  DEFAULT_OPENAI_MODEL,
  createOpenAIProviderFromEnv,
} from './provider/openai.js';
import {
  DEFAULT_CLAUDE_MODEL,
  createClaudeProviderFromEnv,
} from './provider/claude.js';
import {
  MockProvider,
  scriptReact,
  scriptWriteAndRead,
  scriptLoop,
  scriptApproval,
  scriptPlanMode,
} from './provider/mock.js';
import { CostTracker } from './observability/tracker.js';
import { AgentEngine } from './engine/loop.js';
import { TerminalReporter } from './engine/terminal-reporter.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { defaultAgentConfig } from './agents/default-config.js';
import { buildAgentRegistry, buildAgentSystemMessage } from './agents/runtime.js';

// ===========================================
// 1. 简单的命令行参数解析（不引第三方库）
// ===========================================
function parseArgs(argv) {
  const args = {
    prompt: '',
    dir: '.',
    session: 'cli_default_session',
    provider: process.env.TINY_HARNESS_PROVIDER || 'auto',
    thinking: false,
    plan: false,
    requireApproval: false,
    autoApprove: false,
    script: 'read-file',
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--prompt':
      case '-p':
        // 例如参数是 ["--prompt", "读取 README"]：当前 i 指向 --prompt，next 是它的值。
        // i++ 手动跳过刚刚取作值的 argv[i + 1]，避免下一轮 for 又把 "读取 README" 当成独立参数。
        args.prompt = next; i++;
        // break 只跳出 switch，不会跳出外层 for 循环。
        // 若没有它，代码会继续向下贯穿执行后续 case（例如错误地再执行 --dir 的赋值）。
        // switch 结束后，for 自己会执行 i++ 并开始解析下一个真正的选项。
        break;
      case '--dir':
      case '-d':
        // 例如：node src/index.js --dir ./demos/test-harness。
        // 将工具可访问的工作目录从默认的当前目录 '.' 改为 ./demos/test-harness。
        args.dir = next; i++; break;
      case '--session':
      case '-s':
        // 例如：node src/index.js --session fix-login-bug；后续用同一 session 可加载该任务的持久化历史。
        args.session = next; i++; break;
      case '--provider':
        // 例如：node src/index.js --provider openai；指定本次使用 OpenAI 协议而非 auto / claude / mock。
        args.provider = next; i++; break;
      case '--script':
        // 例如：node src/index.js --provider mock --script loop；选择 mock Provider 预设的 loop 演示脚本。
        args.script = next; i++; break;
      case '--thinking':
        // 例如：node src/index.js --thinking；开启慢思考模式，让模型先生成思考结果再进入工具行动阶段。
        args.thinking = true; break;
      case '--plan':
        // 例如：node src/index.js --plan；开启 Plan Mode，先通过只读工具调研，再产出并执行实施计划。
        args.plan = true; break;
      case '--require-approval':
        // 例如：node src/index.js --require-approval；即使当前 Provider 是 mock，也要求 bash / 写文件操作逐次人工确认。
        args.requireApproval = true; break;
      case '--auto-approve':
      case '--yolo':
        // 例如：node src/index.js --auto-approve（或 --yolo）；启动时直接放行所有需要审批的工具调用。
        args.autoApprove = true; break;
      case '--help':
      case '-h':
        // 例如：node src/index.js --help；打印帮助文本后立刻以成功状态结束 CLI，不再启动 Agent。
        printHelp();
        process.exit(0);
        break; // process.exit 已结束进程，实际不会走到这里；保留是 switch 分支的防御性写法。
      default:
        // 例如：node src/index.js --colour blue；--colour 不被支持，会提示未知参数。
        // 普通位置参数（不以 -- 开头）则忽略，避免将 --prompt 的值误报为未知选项。
        if (a.startsWith('--')) {
          console.warn(`[警告] 未知参数: ${a}`);
        }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
tiny-harness (Node.js 版) - 极简 Agent Harness

用法:
  node src/index.js --prompt "你的任务" [选项]

选项:
  --prompt, -p <text>      任务描述（必填，除非用 --script 演示）
  --dir, -d <path>         工作区目录（默认: 当前目录）
  --session, -s <id>       会话 ID（用于断点续传）
  --provider <name>        协议: mock | openai | claude (默认: mock)
  --script <name>          Mock 模式剧本: read-file | write-and-read | loop | approval | plan-mode
  --thinking               开启慢思考两阶段（先想后做）
  --plan                   开启 Plan Mode（PLAN.md + TODO.md 持久化）
  --require-approval       强制对 bash / edit_file / write_file 人工审批
  --auto-approve, --yolo   跳过工具人工审批（mock 模式默认启用）
  --help, -h               显示此帮助

执行环境变量:
  TINY_HARNESS_EXECUTION_BACKEND   local（默认）| docker
  TINY_HARNESS_DOCKER_IMAGE        Docker 镜像（默认: alpine:3.20）
  TINY_HARNESS_DOCKER_MEMORY       单容器内存上限（默认: 512m）
  TINY_HARNESS_DOCKER_CPUS         单容器 CPU 上限（默认: 1）
  TINY_HARNESS_DOCKER_PIDS_LIMIT   单容器 PID 上限（默认: 128）

环境变量（在 .env 中配置）:
  TINY_HARNESS_PROVIDER    默认协议
  OPENAI_API_KEY           OpenAI 兼容协议 API key
  OPENAI_MODEL             OpenAI 兼容协议模型（默认: ${DEFAULT_OPENAI_MODEL}）
  OPENAI_BASE_URL          OpenAI 兼容协议地址
  CLAUDE_API_KEY           Claude 兼容协议 API key
  CLAUDE_MODEL             Claude 兼容协议模型（默认: ${DEFAULT_CLAUDE_MODEL}）
  CLAUDE_BASE_URL          Claude 兼容协议地址
`);
}

// ===========================================
// 2. 加载 .env（不引 dotenv，简化）
// ===========================================
// 将项目根目录 `.env` 中的配置读入 process.env，供后续 Provider 读取 API Key、模型名和地址。
//
// `.env` 只是一个本地文本配置文件，常见内容如：
//   OPENAI_API_KEY=sk-xxx
//   OPENAI_MODEL=gpt-5.6-sol
// 程序本身只能通过 process.env 读取环境变量，不能自动识别 `.env`；因此 main() 启动时先调用本函数。
// 本项目为保持依赖精简，手动实现了 dotenv 的最基础功能，而没有安装 dotenv 包。
function loadEnvFile() {
  // 从项目根目录（package.json 同级）找 .env
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const envPath = path.join(projectRoot, '.env');
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // 去掉两端引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // 没有 .env，跳过
  }

}

// ===========================================
// 3. 根据 provider 名构造 Provider 实例
// ===========================================
function buildProvider(name, script, session) {
  switch (name) {
    case 'auto': {
      // 自动选择：哪个协议配好了 key 就用哪个
      // 优先 Claude（Agent/工具调用场景更稳），其次 OpenAI
      if (process.env.CLAUDE_API_KEY) return buildProvider('claude', script, session);
      if (process.env.OPENAI_API_KEY) return buildProvider('openai', script, session);
      throw new Error(
        '未找到可用的 LLM 配置：请在 .env 填写 OPENAI_API_KEY 或 CLAUDE_API_KEY 后再运行。\n' +
        '（如果你只想离线体验，可用 npm start 跑 mock 演示）'
      );
    }
    case 'mock': {
      // let 用于声明「之后会重新赋值」的块级变量，作用域仅限当前 case 的花括号内。
      // 这里先声明 scriptFn，再由下面 switch 根据 --script 参数为它选择不同的脚本函数，
      // 例如 --script loop 会执行 scriptFn = scriptLoop。
      //
      // 不能用 const：const 必须声明时立刻赋初值，且之后不可重新赋值；
      // 不能用旧式 var：var 是函数级作用域，容易意外泄漏到其他代码块。一般优先 const，
      // 确实需要改变「变量指向的值」时才使用 let。
      let scriptFn;
      switch (script) {
        case 'write-and-read': scriptFn = scriptWriteAndRead; break;
        case 'loop':           scriptFn = scriptLoop; break;
        case 'approval':       scriptFn = scriptApproval; break;
        case 'plan-mode':      scriptFn = scriptPlanMode; break;
        case 'read-file':
        default:               scriptFn = scriptReact; break;
      }
      return { provider: new MockProvider(scriptFn()), modelName: 'mock' };
    }
    case 'openai': {
      const p = createOpenAIProviderFromEnv();
      return { provider: p, modelName: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL };
    }
    case 'claude': {
      const p = createClaudeProviderFromEnv();
      return {
        provider: p,
        modelName: process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
      };
    }
    default:
      throw new Error(`未知 provider: ${name}（支持: mock | openai | claude）`);
  }
}

// ===========================================
// 4. 终端审批中间件
// ===========================================
//
// 设计：
//   - 默认对 bash 和 write_file/edit_file 都要审批（rm 等危险命令不可逆）
//   - 用户输入 y 放行，n 拦截，a 全部放行（本次运行内）
//   - 拦截后返回 ToolResult(isError=true)，让模型看到拒绝理由
//
//   这里会通过 readline 异步等待终端输入；但工具执行链会 await 这个中间件，
//   因而当前这一次工具调用会暂停，直到用户输入并按下回车。
function makeApprovalMiddleware({ autoApprove }) {
  let allApproved = autoApprove;
  const APPROVE_NAMES = new Set(['bash', 'write_file', 'edit_file']);

  // 返回真正注册到 Registry 的中间件函数。call 不是在这里凭空创建的：
  // 模型通过 Provider 返回 ToolCall 后，AgentEngine 会调用 registry.execute(call)；
  // Registry 在执行工具前依次调用每个中间件：await mw(call)，于是这个 call 被传到这里。
  // 它通常长这样：{ id: 'call_123', name: 'bash', arguments: { command: 'npm test' } }。
  return async (call) => {
    // 用户之前输入过 a 后，allApproved 会变为 true；此时所有工具调用都直接放行。
    if (allApproved) return { allowed: true };

    // read_file 等低风险工具无需人工确认，直接结束本中间件。
    if (!APPROVE_NAMES.has(call.name)) {
      return { allowed: true };
    }

    // promptUser 立即返回的不是输入文本，而是一个「将来会得到输入文本」的 Promise。
    // await 会暂停这个 async 中间件的后续代码，并将控制权还给 Node.js 事件循环：
    // readline 仍在监听 process.stdin，其他可运行的异步任务也仍有机会继续执行。
    //
    // 用户尚未输入时：本次 registry.execute(call) 正在 await mw(call)，所以危险工具不会执行；
    // 用户输入 y / n / a 并按回车时：readline 调用 promptUser 内部的回调，Promise 被兑现，
    // answer 才成为用户键入的普通字符串，例如 'y'。
    const answer = await promptUser(
      `\n[审批] 即将执行 ${call.name}，参数: ${JSON.stringify(call.arguments).slice(0, 200)}\n` +
      `(y=放行 / n=拦截 / a=本次运行全部放行): `
    );

    // 统一清理输入：允许用户输入 ' Y ' 或 'YES'，分别归一化为 'y' 和 'yes' 再进行判断。
    const cmd = (answer || '').trim().toLowerCase();

    if (cmd === 'a') {
      allApproved = true;
      console.log('[审批] 已切换到 YOLO 模式，本次运行后续工具全部放行。');
      return { allowed: true };
    }
    if (cmd === 'y' || cmd === 'yes') {
      return { allowed: true };
    }
    return {
      allowed: false,
      rejectReason: `用户在审批环节拒绝了这次 ${call.name} 调用。请换一种方式或调整参数后重试。`,
    };
  };
}

// 在终端显示 question，并等待用户输入一行文字后返回该文字。
//
// 虽然调用方可以写 `const answer = await promptUser(...)`，但此函数本身不是同步阻塞函数：
// 它返回 Promise；Node.js 会继续运行事件循环，直到 readline 收到用户按下回车后的输入，
// 再将 Promise 兑现。这里主要给审批中间件读取 y / n / a。
function promptUser(question) {
  // 创建一次性的终端读写接口：
  // process.stdin 是标准输入（键盘输入、管道输入），process.stdout 是标准输出（终端显示）。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // readline.question 使用回调风格；这里手动包装为 Promise，调用方就可以使用 await。
  return new Promise((resolve) => {
    // new Promise(...) 会立刻把一个由 JavaScript 运行时提供的函数传进来；这个函数就是 resolve。
    //
    // Promise 可以理解为「未来才会拿到的结果盒子」：
    //   1. 此处刚创建时，盒子状态是 pending（等待中）；
    //   2. 稍后调用 resolve(某个值)，盒子状态变为 fulfilled（已成功完成）；
    //   3. 所有 `await promptUser(...)` 的地方随即恢复执行，并收到该值。
    //
    // 因此 resolve 不是我们定义的普通变量，也不负责读取键盘；它是「把最终结果交回 Promise」的开关。
    // resolve 只能让同一个 Promise 成功完成一次；后续重复调用不会覆盖第一次的结果。
    // 先把 question 打印到终端；用户输入内容并按回车后，answer 回调参数就是输入的字符串。
    rl.question(question, (answer) => {
      // 本次提问完成后必须关闭接口；否则 stdin 监听仍存在，CLI 可能无法正常结束或重复占用输入。
      rl.close();

      // 将 Promise 从 pending 改为 fulfilled，并把用户输入的 answer（例如 'y'）保存为它的结果。
      // 于是 `const answer = await promptUser(question)` 中的 await 结束，左侧 answer 得到同一个字符串。
      resolve(answer);
    });
  });
}

// ===========================================
// 5. 主函数
// ===========================================
async function main() {
  loadEnvFile();

  // process 是 Node.js 在启动程序时自动提供的全局对象，不需要 import，也不是本项目创建的变量。
  // process.argv（argument vector，参数向量）是 Node.js 从操作系统接收到的「启动命令」拆分出的字符串数组。
  //
  // 例如在终端输入：
  //   node src/index.js --provider openai --session task-1
  // 操作系统启动 node 进程时，会把后面的文字传给 Node.js；Node.js 随即自动准备：
  //   process.argv === [
  //     '/实际路径/node',       // [0]：Node.js 可执行程序自身的位置
  //     '/实际路径/src/index.js', // [1]：当前执行的脚本文件
  //     '--provider',           // [2] 起：用户在命令中输入的参数
  //     'openai',
  //     '--session',
  //     'task-1',
  //   ]
  //
  // args 是将这种「一串位置参数」解析后得到的配置对象。parseArgs(process.argv) 会忽略前两个固定项，
  // 识别 --provider / --session 等选项，转换为：
  // { provider: 'openai', session: 'task-1', prompt: '', thinking: false, ... }。
  // 后续 main() 根据 args 决定模型协议、工作目录、会话 ID、是否审批、是否开启 Plan Mode 等行为。
  const args = parseArgs(process.argv);

  // 工作区绝对路径
  const workDir = path.resolve(args.dir);

  console.log('==================================================');
  console.log('🚀 启动 tiny-harness (Node.js 版) CLI 引擎...');
  console.log(`📁 锁定工作区: ${workDir}`);
  console.log(`🧠 Provider: ${args.provider}`);
  console.log(`🛠️ 慢思考: ${args.thinking ? 'ON' : 'OFF'} | Plan Mode: ${args.plan ? 'ON' : 'OFF'}`);
  console.log('==================================================');

  // 拿到 Session（断点续传基础）
  const session = globalSessionMgr.getOrCreate(args.session, workDir);

  // 构造 Provider
  const { provider: realProvider, modelName } = buildProvider(
    args.provider,
    args.script,
    session
  );

  // 用 CostTracker 装饰一层（mock 也会走，但单价 0）
  const trackedProvider = new CostTracker(realProvider, modelName, session);

  // CLI 使用教学默认主 Agent 配置；平台接入时可替换为数据库/API 下发的同构配置。
  const agentRegistry = new AgentRegistry(defaultAgentConfig);
  const rootAgent = agentRegistry.getRootAgent();
  // 引擎构造前 Registry 尚不可用，因此先创建空 Registry；随后由配置驱动运行时构造最终 Registry。
  let registry = new Registry();

  // 决定本次运行是否要在 bash / write_file / edit_file 真正执行前询问用户。
  //
  // shouldApprove 为 true 的两种情况：
  // 1. args.requireApproval 为 true：用户显式传了 --require-approval，任何 Provider 都强制审批；
  // 2. 使用真实模型且未传 --auto-approve：provider 不是 mock，并且 autoApprove 为 false。
  //
  // 具体例子：
  // - --provider mock                         → false，演示脚本默认直接执行（YOLO）；
  // - --provider mock --require-approval      → true，mock 也逐次询问；
  // - --provider openai / --provider claude   → true，真实模型默认需要确认；
  // - --provider openai --auto-approve        → false，真实模型也跳过确认。
  const shouldApprove =
    args.requireApproval ||
    (args.provider !== 'mock' && !args.autoApprove);

  const approvalMiddleware = shouldApprove ? makeApprovalMiddleware({ autoApprove: false }) : null;
  console.log(shouldApprove ? '🛡️ 已挂载终端审批中间件（bash/write/edit 需确认）' : '🛡️ 已跳过审批（YOLO 模式）');

  // 先创建引擎，再按 rootAgent 配置建立最终 Registry 并回填引擎。
  const engine = new AgentEngine(
    trackedProvider,
    registry,
    args.thinking,
    args.plan,
    (agentWorkDir, planMode) => buildAgentSystemMessage({ agent: rootAgent, workDir: agentWorkDir, planMode })
  );
  const reporter = new TerminalReporter();
  registry = buildAgentRegistry({
    agent: rootAgent,
    workDir,
    engine,
    reporter,
    agentRegistry,
    middleware: approvalMiddleware,
  });
  engine.registry = registry;

  // ===========================================
  // 两种输入模式：由是否传入「非空的 --prompt」触发，而不是由 Agent 内部调用几次工具决定。
  //
  // 1. 单次模式：命令中带 --prompt / -p，例如：
  //    node src/index.js --provider openai --prompt "读取 package.json 并总结"
  //    parseArgs 会将文字写入 args.prompt；if (args.prompt) 为真，于是只调用一次 runOneTurn()。
  //    注意「一次」指一次用户任务 / 一次 engine.run()；Agent 在这一次任务内部仍可进行很多 ReAct 轮：
  //    模型 → 工具 → 工具结果 → 模型，直到模型不再请求工具。任务完成后打印摘要并让 CLI 进程自然退出。
  //
  // 2. 多次模式（REPL）：命令不带 --prompt，例如：
  //    node src/index.js --provider openai
  //    此时 args.prompt 保持默认空字符串 ''，if 不成立，进入 runRepl()；它循环读取终端的每一条新输入，
  //    每输入一次就调用一次 runOneTurn()。所有次 runOneTurn 共用同一个 session，所以模型可看到之前的对话和工具结果。
  // ===========================================
  if (args.prompt) {
    // 因为命令行已经一次性给出了任务文本，所以无需等待下一条终端输入：执行该任务、保存 Session、输出摘要后结束。
    await runOneTurn(args.prompt, session, engine, reporter);
    printSessionSummary(session, workDir);
  } else if (args.provider === 'mock') {
    // mock 的目标是自动演示预设脚本；即使用户没传 --prompt，也注入固定任务并按单次模式跑完退出，避免演示时卡在交互输入。
    await runOneTurn('请按剧本执行演示任务。', session, engine, reporter);
    printSessionSummary(session, workDir);
  } else {
    // 真实 Provider 未传 --prompt：进入 REPL，持续接收多条用户消息，直到用户输入 /exit 或 quit。
    await runRepl(args, session, engine, reporter, workDir, registry);
  }
}

// ===========================================
// 单次执行一轮
// ===========================================
async function runOneTurn(prompt, session, engine, reporter) {
  console.log(`\n🎯 收到任务: ${prompt}\n`);
  session.append(new Message({ role: Role.USER, content: prompt }));

  const startTime = Date.now();
  try {
    await engine.run(session, reporter);
  } catch (err) {
    console.error(`\n💥 引擎运行崩溃: ${err.message}`);
    console.error(err.stack);
    throw err;
  } finally {
    session.save();
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n⏱️  本轮耗时: ${elapsed}s`);
}

// ===========================================
// REPL 多轮对话模式
// ===========================================
// 像 claude code / pi agent 一样：
//   - 用一个持久的 Session（多轮共享上下文）
//   - 每轮用户输入 → 引擎跑 → 等下一轮
//   - 支持特殊命令退出 / 切换模式 / 查看会话
//   - 跨轮保留工具调用历史，模型能"记得"前面干过什么
async function runRepl(args, session, engine, reporter, workDir, registry) {
  console.log('\n==================================================');
  console.log('💬 进入多轮对话模式（REPL）');
  console.log('   特殊命令:');
  console.log('     /exit / quit    退出');
  console.log('     /cost            查看累计花费');
  console.log('     /history         查看会话历史条数');
  console.log('     /clear           清空当前会话历史');
  console.log('     /yolo            切换到 YOLO（不再审批）');
  console.log('     /think           切换慢思考 ON/OFF');
  console.log('     /plan            切换 Plan Mode ON/OFF');
  console.log('     /help            显示帮助');
  console.log('==================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '🧑 ',
  });

  // 用闭包管理可变状态
  let thinkFlag = args.thinking;
  let planFlag = args.plan;

  // 给 engine 加 setter
  const setEngineFlags = () => {
    engine.enableThinking = thinkFlag;
    engine.planMode = planFlag;
  };

  // ===========================================
  // 串行化队列：保证上一轮没跑完前，下一轮不会并发触发
  // 原因：readline 的 'line' 事件是同步触发的，如果 handler 是 async，
  //   readline 不会 await，下一行输入会立即并发执行。
  //   管道输入（printf '...' | node ...）会把所有行一次性塞进 stdin，
  //   导致 /exit 立刻触发 close → process.exit，把还没完成的 API 调用杀掉。
  // 解决：用一个 Promise 链把所有 line handler 串起来，前一轮跑完才跑下一轮。
  // ===========================================
  let pending = Promise.resolve();
  const enqueue = (task) => {
    pending = pending.then(() => task()).catch((err) => {
      console.error(`[REPL] 内部错误: ${err.message}`);
    });
    return pending;
  };

  // 标记是否正在处理任务（用于 close 事件判断是否要等）
  let busy = false;
  let wantExit = false;

  // 安全的 prompt：readline 关闭后调 prompt 会抛 'readline was closed'
  const safePrompt = () => {
    if (!wantExit && !rl.closed) {
      try { rl.prompt(); } catch { /* ignore */ }
    }
  };

  rl.prompt();

  const handleLine = async (input) => {
    const text = input.trim();

    // 空行直接跳过
    if (!text) {
      safePrompt();
      return;
    }

    // 特殊命令
    if (text.startsWith('/')) {
      const cmd = text.toLowerCase();
      switch (cmd) {
        case '/exit':
        case '/quit':
        case '/q':
          wantExit = true;
          rl.close();
          return;
        case '/cost':
          console.log(`💰 累计估算: ${formatEstimatedCosts(session)} | ` +
                      `Token: 输入 ${session.totalPromptTokens}, 输出 ${session.totalCompletionTokens}`);
          break;
        case '/history':
          console.log(`📜 会话 ${session.id} 共 ${session.history.length} 条消息`);
          for (let i = 0; i < session.history.length; i++) {
            const m = session.history[i];
            const preview = (m.content || '').slice(0, 60).replaceAll('\n', ' ');
            console.log(`  [${i}] ${m.role}${m.toolCallId ? '(tool)' : ''}: ${preview}...`);
          }
          break;
        case '/clear':
          session.history = [];
          console.log('🧹 已清空会话历史');
          break;
        case '/yolo':
          // 直接清空 middlewares（只清审批，保留其他）
          registry.middlewares = [];
          console.log('🛡️ 已切换到 YOLO 模式，后续不再审批');
          break;
        case '/think':
          thinkFlag = !thinkFlag;
          setEngineFlags();
          console.log(`🧠 慢思考: ${thinkFlag ? 'ON' : 'OFF'}`);
          break;
        case '/plan':
          planFlag = !planFlag;
          setEngineFlags();
          console.log(`📋 Plan Mode: ${planFlag ? 'ON' : 'OFF'}`);
          break;
        case '/help':
          console.log('命令: /exit /cost /history /clear /yolo /think /plan /help');
          break;
        default:
          console.log(`❓ 未知命令: ${text}（输入 /help 查看）`);
      }
      safePrompt();
      return;
    }

    // 普通输入：当作新一轮 prompt
    busy = true;
    try {
      await runOneTurn(text, session, engine, reporter);
    } catch (err) {
      console.error(`本轮出错: ${err.message}`);
    }
    console.log('');  // 空行分隔
    busy = false;
    safePrompt();
  };

  rl.on('line', (input) => {
    enqueue(() => handleLine(input));
  });

  rl.on('close', async () => {
    // 等待所有排队的任务跑完再退出
    await pending;
    console.log('\n');
    printSessionSummary(session, workDir);
    process.exit(0);
  });
}

function printSessionSummary(session, workDir) {
  console.log('\n==================================================');
  console.log(`💰 Session 累计估算: ${formatEstimatedCosts(session)} | ` +
              `Token: 输入 ${session.totalPromptTokens}, 输出 ${session.totalCompletionTokens}`);
  console.log(`📂 会话 ID: ${session.id}（可用 --session ${session.id} 断点续传）`);
  console.log(`📊 Trace 已保存: ${workDir}/.tiny-harness/traces/`);
  console.log('==================================================');
}

function formatEstimatedCosts(session) {
  return Object.entries(session.estimatedCosts || {})
    .map(([currency, amount]) => `${currency} ${Number(amount).toFixed(6)}`)
    .join(', ') || '未配置';
}

main().catch((err) => {
  console.error('未捕获错误:', err);
  process.exit(1);
});
