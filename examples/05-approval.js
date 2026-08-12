// ===========================================
// examples/05-approval.js
// ===========================================
// 演示：人类审批中间件（终端交互版）
//
// 学习目标：
//   1. 不是所有工具调用都能放手让模型自己跑
//      - bash rm -rf / 一旦执行不可逆
//      - write_file 覆盖关键文件可能毁掉工作
//   2. 在 Registry.execute 前挂一个 Middleware，可以拦截危险调用
//   3. 拦截后返回 isError=true 的 ToolResult，模型会"看到拒绝理由"
//   4. 模型有机会调整策略（改用更安全的命令）

//   核心机制一致：Middleware 拦截 + ToolResult 反馈
//
// 运行：node examples/05-approval.js
//   交互：会问你 y/n，输入 n 看模型怎么应对
// ===========================================

import { AgentEngine } from '../src/engine/loop.js';
import { MockProvider, scriptApproval } from '../src/provider/mock.js';
import { Registry } from '../src/tools/registry.js';
import { ReadFileTool } from '../src/tools/read-file.js';
import { WriteFileTool } from '../src/tools/write-file.js';
import { EditFileTool } from '../src/tools/edit-file.js';
import { BashTool } from '../src/tools/bash.js';
import { Session } from '../src/context/session.js';
import { TerminalReporter } from '../src/engine/terminal-reporter.js';
import { Message, Role } from '../src/schema/message.js';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';

console.log('='.repeat(60));
console.log('示例 05: 人类审批（终端交互）');
console.log('='.repeat(60));

const workDir = fs.mkdtempSync(path.join('/tmp', 'tiny-harness-demo-05-'));
const provider = new MockProvider(scriptApproval());

const registry = new Registry();
registry.register(new ReadFileTool(workDir));
registry.register(new WriteFileTool(workDir));
registry.register(new EditFileTool(workDir));
registry.register(new BashTool(workDir));

// 挂审批中间件：对 bash 都要审
registry.use((call) => {
  if (call.name !== 'bash') return { allowed: true };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `\n[审批] 即将执行 bash: ${call.arguments.command}\n` +
      `(y=放行 / n=拦截): `,
      (answer) => {
        rl.close();
        const ok = answer.trim().toLowerCase().startsWith('y');
        if (ok) {
          resolve({ allowed: true });
        } else {
          resolve({
            allowed: false,
            rejectReason: `用户拒绝执行 rm -rf，请改用更安全的方式（如先 mv 到 /tmp，或加 -i 交互确认）`,
          });
        }
      }
    );
  });
});

const session = new Session('demo-05', workDir);
session.append(new Message({
  role: Role.USER,
  content: '请帮我清理 /tmp/old_logs 目录。',
}));

const engine = new AgentEngine(provider, registry, false, false);
await engine.run(session, new TerminalReporter());

console.log('\n📌 关键观察:');
console.log('  - 模型想跑 rm -rf /tmp/old_logs');
console.log('  - 你输入 n → 返回 isError=true 的 ToolResult + 拒绝理由');
console.log('  - 模型看到拒绝理由后有机会调整策略');
console.log('  - 这是 Agent 防御性设计的关键一层');

fs.rmSync(workDir, { recursive: true, force: true });
