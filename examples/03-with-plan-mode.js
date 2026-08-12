// ===========================================
// examples/03-with-plan-mode.js
// ===========================================
// 演示：Plan Mode（PLAN.md + TODO.md 持久化）
//
// 学习目标：
//   1. Plan Mode 下 System Prompt 会注入"长程任务强制规范"
//   2. 模型会先 ls 检查 PLAN.md 是否存在
//   3. 然后写 PLAN.md（架构） + TODO.md（步骤）
//   4. 每完成一步就 edit_file 把 - [ ] 改成 - [x]
//   5. 这是断点续传的基础：再开会话时，模型 ls 看到 PLAN.md 就能续上
//
// 运行：node examples/03-with-plan-mode.js
// ===========================================

import { AgentEngine } from '../src/engine/loop.js';
import { MockProvider, scriptPlanMode } from '../src/provider/mock.js';
import { Registry } from '../src/tools/registry.js';
import { ReadFileTool } from '../src/tools/read-file.js';
import { WriteFileTool } from '../src/tools/write-file.js';
import { EditFileTool } from '../src/tools/edit-file.js';
import { BashTool } from '../src/tools/bash.js';
import { Session } from '../src/context/session.js';
import { TerminalReporter } from '../src/engine/terminal-reporter.js';
import { Message, Role } from '../src/schema/message.js';
import path from 'node:path';
import fs from 'node:fs';

console.log('='.repeat(60));
console.log('示例 03: Plan Mode 持久化 + 实时打勾');
console.log('='.repeat(60));

const workDir = fs.mkdtempSync(path.join('/tmp', 'tiny-harness-demo-03-'));
console.log(`📁 临时工作区: ${workDir}`);

const provider = new MockProvider(scriptPlanMode());

const registry = new Registry();
registry.register(new ReadFileTool(workDir));
registry.register(new WriteFileTool(workDir));
registry.register(new EditFileTool(workDir));
registry.register(new BashTool(workDir));

const session = new Session('demo-03', workDir);
session.append(new Message({
  role: Role.USER,
  content: '请帮我实现一个 hello world 程序。',
}));

// 关键：开启 planMode
const engine = new AgentEngine(provider, registry, false, true);
await engine.run(session, new TerminalReporter());

// 检查落盘结果
console.log('\n📄 最终 PLAN.md:');
console.log(fs.readFileSync(path.join(workDir, 'PLAN.md'), 'utf8'));
console.log('\n📄 最终 TODO.md:');
console.log(fs.readFileSync(path.join(workDir, 'TODO.md'), 'utf8'));

console.log('\n📌 关键观察:');
console.log('  - 模型先 ls 检查 PLAN.md 是否存在');
console.log('  - 不存在 → 创建 PLAN.md 和 TODO.md');
console.log('  - 每完成一步就 edit_file 把 [ ] 改成 [x]');
console.log('  - 即使会话中断，下次 ls 看到 PLAN.md 就能续上');

fs.rmSync(workDir, { recursive: true, force: true });
