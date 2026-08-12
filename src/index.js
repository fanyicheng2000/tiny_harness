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
        args.prompt = next; i++; break;
      case '--dir':
      case '-d':
        args.dir = next; i++; break;
      case '--session':
      case '-s':
        args.session = next; i++; break;
      case '--provider':
        args.provider = next; i++; break;
      case '--script':
        args.script = next; i++; break;
      case '--thinking':
        args.thinking = true; break;
      case '--plan':
        args.plan = true; break;
      case '--require-approval':
        args.requireApproval = true; break;
      case '--auto-approve':
      case '--yolo':
        args.autoApprove = true; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
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
//   这里用 readline 同步等用户输入
function makeApprovalMiddleware({ autoApprove }) {
  let allApproved = autoApprove;
  const APPROVE_NAMES = new Set(['bash', 'write_file', 'edit_file']);

  return (call) => {
    if (allApproved) return { allowed: true };

    if (!APPROVE_NAMES.has(call.name)) {
      return { allowed: true };
    }

    // 同步阻塞读 stdin
    const answer = promptUser(
      `\n[审批] 即将执行 ${call.name}，参数: ${JSON.stringify(call.arguments).slice(0, 200)}\n` +
      `(y=放行 / n=拦截 / a=本次运行全部放行): `
    );
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

// 同步读一行（用 readline 的 promise 接口）
function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ===========================================
// 5. 主函数
// ===========================================
async function main() {
  loadEnvFile();
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

  // 构造工具注册表
  const registry = new Registry();
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new EditFileTool(workDir));
  registry.register(new BashTool(workDir));

  // 挂审批中间件
  // - mock 模式默认 YOLO（除非显式 --require-approval）
  // - 真调模式默认要审批（除非显式 --auto-approve）
  const shouldApprove =
    args.requireApproval ||
    (args.provider !== 'mock' && !args.autoApprove);
  if (shouldApprove) {
    registry.use(makeApprovalMiddleware({ autoApprove: false }));
    console.log('🛡️ 已挂载终端审批中间件（bash/write/edit 需确认）');
  } else {
    console.log('🛡️ 已跳过审批（YOLO 模式）');
  }

  // 构造引擎
  const engine = new AgentEngine(
    trackedProvider,
    registry,
    args.thinking,
    args.plan
  );

  // 终端输出器
  const reporter = new TerminalReporter();

  // ===========================================
  // 两种模式：
  //   1. 单次模式（--prompt）→ 跑完就退
  //   2. REPL 模式（无 --prompt）→ 像 claude code / pi agent 一样多轮对话
  // ===========================================
  if (args.prompt) {
    // 单次模式
    await runOneTurn(args.prompt, session, engine, reporter);
    printSessionSummary(session, workDir);
  } else if (args.provider === 'mock') {
    // mock 模式没传 prompt，跑默认剧本
    await runOneTurn('请按剧本执行演示任务。', session, engine, reporter);
    printSessionSummary(session, workDir);
  } else {
    // REPL 多轮对话模式
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
