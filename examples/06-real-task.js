// ===========================================
// examples/06-real-task.js
// ===========================================
// 演示：通过 OpenAI 兼容协议或 Claude 兼容协议真调 LLM
//
// 学习目标：
//   1. mock 是教学用的，真实场景需要真调 LLM
//   2. 切换 provider 只需要改环境变量，引擎代码零修改
//   3. 真调会产生真实花费（CostTracker 会打印每次的金额）
//   4. 真调可能触发各种异常（限流、超时、参数错误），RecoveryManager 会注入救援指南
//
// 前置条件：
//   - 复制 .env.example 为 .env
//   - 在 .env 里填上你的 API key
//   - 设置 TINY_HARNESS_PROVIDER=openai（或 claude）
//
// 运行：node examples/06-real-task.js
//
// 注意：真调每次都会扣费，请按服务商价格选择模型
// ===========================================

import 'node:process';  // 确保 process 可用
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AgentEngine } from '../src/engine/loop.js';
import { DEFAULT_OPENAI_MODEL, createOpenAIProviderFromEnv } from '../src/provider/openai.js';
import { DEFAULT_CLAUDE_MODEL, createClaudeProviderFromEnv } from '../src/provider/claude.js';
import { CostTracker } from '../src/observability/tracker.js';
import { Registry } from '../src/tools/registry.js';
import { ReadFileTool } from '../src/tools/read-file.js';
import { WriteFileTool } from '../src/tools/write-file.js';
import { EditFileTool } from '../src/tools/edit-file.js';
import { BashTool } from '../src/tools/bash.js';
import { Session } from '../src/context/session.js';
import { TerminalReporter } from '../src/engine/terminal-reporter.js';
import { Message, Role } from '../src/schema/message.js';

console.log('='.repeat(60));
console.log('示例 06: 真调 LLM');
console.log('='.repeat(60));

// 简易 .env 加载
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const envPath = path.join(projectRoot, '.env');
try {
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const eq = t.indexOf('=');
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
} catch {
  console.warn('⚠️ 没找到 .env，将使用系统环境变量');
}

const providerName = process.env.TINY_HARNESS_PROVIDER || 'openai';
let realProvider, modelName;
try {
  switch (providerName) {
    case 'openai':
      realProvider = createOpenAIProviderFromEnv();
      modelName = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
      break;
    case 'claude':
      realProvider = createClaudeProviderFromEnv();
      modelName = process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
      break;
    default:
      console.error(`未知 provider: ${providerName}（支持: openai | claude）`);
      process.exit(1);
  }
} catch (err) {
  console.error(`❌ 初始化 ${providerName} provider 失败: ${err.message}`);
  console.error('   请检查 .env 是否配置了对应的 API key');
  process.exit(1);
}

console.log(`🧠 Provider: ${providerName} (model: ${modelName})`);

// 工作区 = 当前项目根
const workDir = projectRoot;

// CostTracker 装饰器
const session = new Session('demo-06-real', workDir);
const trackedProvider = new CostTracker(realProvider, modelName, session);

const registry = new Registry();
registry.register(new ReadFileTool(workDir));
registry.register(new WriteFileTool(workDir));
registry.register(new EditFileTool(workDir));
registry.register(new BashTool(workDir));

// 真调模式下默认要审批（bash 危险！）
// 这里示例简单起见不挂审批，实际生产请务必挂上
// 想看审批效果：去掉下面这行的注释
// registry.use(/* 你的审批中间件 */);

const taskPrompt =
  '请读取本项目的 package.json 文件，告诉我项目名和版本号。然后用 write_file 在 /tmp/tiny-harness-real-task-output.txt 写一个简单的执行报告。';

session.append(new Message({ role: Role.USER, content: taskPrompt }));

const engine = new AgentEngine(trackedProvider, registry, true /* thinking */, true /* plan */);

console.log(`\n🎯 任务: ${taskPrompt}\n`);

const startTime = Date.now();
try {
  await engine.run(session, new TerminalReporter());
} catch (err) {
  console.error(`\n💥 引擎运行崩溃: ${err.message}`);
  console.error(err.stack);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('\n==================================================');
console.log(`✨ 完成。耗时: ${elapsed}s`);
const estimatedCost = Object.entries(session.estimatedCosts || {})
  .map(([currency, amount]) => `${currency} ${amount.toFixed(6)}`)
  .join(', ') || '未配置';
console.log(`💰 总估算费用: ${estimatedCost}`);
console.log(`📊 Token: 输入 ${session.totalPromptTokens} / 输出 ${session.totalCompletionTokens}`);
console.log('==================================================');
