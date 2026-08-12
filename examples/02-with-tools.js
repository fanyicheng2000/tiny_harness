// ===========================================
// examples/02-with-tools.js
// ===========================================
// 演示：四个实用核心工具 + 并发执行
//
// 学习目标：
//   1. read_file / write_file / edit_file / bash 是 Agent 的"四肢"
//   2. 多个 toolCalls 时会被并发执行（Promise.all）
//   3. 每个工具的执行结果会以 USER 角色塞回会话
//
// 运行：node examples/02-with-tools.js
// ===========================================

import { AgentEngine } from '../src/engine/loop.js';
import { MockProvider, scriptWriteAndRead } from '../src/provider/mock.js';
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
console.log('示例 02: 四工具齐全 + 并发执行');
console.log('='.repeat(60));

// 用一个临时工作区，避免污染项目
const workDir = fs.mkdtempSync(path.join('/tmp', 'tiny-harness-demo-02-'));
console.log(`📁 临时工作区: ${workDir}`);
fs.writeFileSync(
  path.join(workDir, 'package.json'),
  JSON.stringify({ name: 'tiny-harness-demo-02', private: true }, null, 2),
  'utf8',
);

const provider = new MockProvider(scriptWriteAndRead());

const registry = new Registry();
registry.register(new ReadFileTool(workDir));
registry.register(new WriteFileTool(workDir));
registry.register(new EditFileTool(workDir));
registry.register(new BashTool(workDir));

const session = new Session('demo-02', workDir);
session.append(new Message({
  role: Role.USER,
  content: '同时做两件事：写 hello.txt 内容是 Hello World，并读取 package.json。',
}));

const engine = new AgentEngine(provider, registry, false, false);
await engine.run(session, new TerminalReporter());

console.log('\n📌 关键观察:');
console.log('  - 模型一次性发起了 2 个 toolCalls（write + read）');
console.log('  - 引擎用 Promise.all 并发执行');
console.log(`  - 看 ${workDir}/hello.txt 应该已经被创建`);

console.log(`\n🗑️  清理临时工作区: rm -rf ${workDir}`);
fs.rmSync(workDir, { recursive: true, force: true });
