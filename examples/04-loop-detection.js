// ===========================================
// examples/04-loop-detection.js
// ===========================================
// 演示：死循环检测 + 强力干预
//
// 学习目标：
//   1. Agent 容易陷入"相同参数失败 → 重试 → 又失败"的死循环
//   2. ReminderInjector 用 MD5 指纹 + 计数器识别
//   3. 同一指纹连续失败 ≥3 次 → 注入 SYSTEM REMINDER
//   4. 成功一次就清零（说明 Agent 走出来了）
//
// 运行：node examples/04-loop-detection.js
// ===========================================

import { AgentEngine } from '../src/engine/loop.js';
import { MockProvider, scriptLoop } from '../src/provider/mock.js';
import { Registry } from '../src/tools/registry.js';
import { ReadFileTool } from '../src/tools/read-file.js';
import { WriteFileTool } from '../src/tools/write-file.js';
import { EditFileTool } from '../src/tools/edit-file.js';
import { BashTool } from '../src/tools/bash.js';
import { Session } from '../src/context/session.js';
import { TerminalReporter } from '../src/engine/terminal-reporter.js';
import { Message, Role } from '../src/schema/message.js';
import path from 'node:path';

console.log('='.repeat(60));
console.log('示例 04: 死循环检测（连续 3 次同参数失败 → 干预）');
console.log('='.repeat(60));

const workDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const provider = new MockProvider(scriptLoop());

const registry = new Registry();
registry.register(new ReadFileTool(workDir));
registry.register(new WriteFileTool(workDir));
registry.register(new EditFileTool(workDir));
registry.register(new BashTool(workDir));

const session = new Session('demo-04', workDir);
session.append(new Message({
  role: Role.USER,
  content: '请帮我读取 不存在.txt 文件的内容。',
}));

const engine = new AgentEngine(provider, registry, false, false);
await engine.run(session, new TerminalReporter());

console.log('\n📌 关键观察:');
console.log('  - 前 3 次：read_file 失败，Reminder 计数 1→2→3');
console.log('  - 第 3 次后：注入 SYSTEM REMINDER 警告');
console.log('  - 第 4 次：模型在提醒下放弃了无效重试');
console.log('  - 如果没有这个机制，模型会一直烧 API 配额');
