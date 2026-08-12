// ===========================================
// examples/01-simple-loop.js
// ===========================================
// 演示：最简单的 ReAct 循环
//
// 学习目标：
//   1. 知道 Agent = 大模型 + Harness
//   2. 看懂主循环骨架：while + 模型生成 + 工具调用 + 退出条件
//   3. 退出条件：模型不再调工具 = 任务结束
//
// 运行：node examples/01-simple-loop.js
// ===========================================

import { AgentEngine } from '../src/engine/loop.js';
import { MockProvider, scriptReact } from '../src/provider/mock.js';
import { Registry } from '../src/tools/registry.js';
import { ReadFileTool } from '../src/tools/read-file.js';
import { Session } from '../src/context/session.js';
import { TerminalReporter } from '../src/engine/terminal-reporter.js';
import { Message, Role } from '../src/schema/message.js';
import path from 'node:path';

console.log('='.repeat(60));
console.log('示例 01: 最简单的 ReAct 循环');
console.log('='.repeat(60));

// 1. 准备一个 mock 模型，预设它会读 README.md 然后结束
const provider = new MockProvider(scriptReact('package.json'));

// 2. 准备工作区 = 当前项目根
const workDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// 3. 注册一个工具
const registry = new Registry();
registry.register(new ReadFileTool(workDir));

// 4. 准备一个一次性 Session
const session = new Session('demo-01', workDir);
session.append(new Message({ role: Role.USER, content: '请读取 package.json 并告诉我版本号。' }));

// 5. 启动引擎
const engine = new AgentEngine(provider, registry, false, false);
await engine.run(session, new TerminalReporter());

console.log('\n📌 关键观察:');
console.log('  - 模型第一轮调用了 read_file');
console.log('  - 第二轮没有再调工具，循环退出');
console.log('  - 这就是 ReAct 模式的最小骨架');
