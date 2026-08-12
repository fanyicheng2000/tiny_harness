// ===========================================
// demos/server.js
// ===========================================
// 交互式演示服务器
//
// 功能：
//   1. 提供 GET / → 返回 harness.html
//   2. 提供 GET /api/run?script=xxx → SSE 流式返回 Agent 运行事件
//   3. 提供 GET /api/session?sessionId=xxx&workDir=xxx → 返回 JSONL 解析后的行数组
//   4. 提供 GET /api/source/:tool → 返回 src/tools 下对应工具源码
//
// 设计思路：
//   - 用 Node 原生 http 模块，0 依赖
//   - SSE (Server-Sent Events) 流式推送，比 WebSocket 简单
//   - 自定义 SSEReporter，把引擎事件转成 SSE 事件
//   - 引擎代码完全不改，只换 Reporter
//
// 用法：
//   node demos/server.js
//   浏览器打开 http://localhost:3000
// ===========================================

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentEngine } from '../src/engine/loop.js';
import { MockProvider, MOCK_SCRIPTS } from '../src/provider/mock.js';
import { DEFAULT_OPENAI_MODEL, createOpenAIProviderFromEnv } from '../src/provider/openai.js';
import { DEFAULT_CLAUDE_MODEL, createClaudeProviderFromEnv } from '../src/provider/claude.js';
import { Registry } from '../src/tools/registry.js';
import { ReadFileTool } from '../src/tools/read-file.js';
import { WriteFileTool } from '../src/tools/write-file.js';
import { EditFileTool } from '../src/tools/edit-file.js';
import { BashTool } from '../src/tools/bash.js';
import { Session } from '../src/context/session.js';
import { Message, Role } from '../src/schema/message.js';
import { Reporter } from '../src/engine/reporter.js';
import { CostTracker } from '../src/observability/tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ===========================================
// 加载 .env（真调 provider 需要 API key）
// ===========================================
function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  try {
    const text = fsSync.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // 没有 .env，跳过
  }
}
loadEnvFile();

// ===========================================
// calc-app 初始模板（黄金状态，硬编码避免模板被改）
// 真调 test-harness 时每次启动会重置回这套内容，保证实验可复现
// ===========================================
const CALC_APP_FILES = {
  'README.md': `# calc-app

一个命令行计算器小工具，支持加减乘除。

## 文件
- \`src/index.js\` — 入口，解析命令行参数并输出结果

## 运行
\`\`\`bash
node src/index.js add 2 3   # 输出 5
node src/index.js sub 5 2   # 输出 3
node src/index.js mul 4 5   # 输出 20
node src/index.js div 10 2  # 输出 5
\`\`\`

## 已知问题
除法（div）运算结果不对，待修复。
`,
  'src/index.js': `// calc-app: 命令行计算器
const [op, ...nums] = process.argv.slice(2);
const a = Number(nums[0]);
const b = Number(nums[1]);

function calc(op, a, b) {
  switch (op) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'div': return a * b;   // BUG: 应该是 a / b
    default: return '未知操作';
  }
}

if (!op) {
  console.log('用法: node src/index.js <add|sub|mul|div> <a> <b>');
} else {
  console.log(calc(op, a, b));
}
`,
};

// 重置 calc-app 到初始黄金状态：清空目录后重建模板文件
async function resetCalcApp(workDir) {
  // 清掉整个工作目录（含模型改动、.tiny-harness 残留、PLAN.md 等生成物），再重建
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  for (const [relPath, content] of Object.entries(CALC_APP_FILES)) {
    const fullPath = path.join(workDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
  }
}

// mock 示例工作区的种子文件：让依赖现成文件的示例（§1/§2/§3/§5/§9）能正常运行
const MOCK_SEED_FILES = {
  'README.md': `# tiny-harness-demo

这是一个演示用项目。

## 说明
本工作区由 mock 模式自动创建，供演示 ReAct 循环、工具调用等能力使用。

## 运行
\`\`\`bash
node index.js
\`\`\`
`,
  'package.json': `{
  "name": "tiny-harness-demo",
  "version": "1.0.0",
  "description": "演示用项目",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  }
}
`,
  'AGENTS.md': `# 项目专属指南

## 代码规范
- 使用 ES Module（import/export），不使用 CommonJS
- 函数命名用 camelCase
- 每个工具调用后检查返回值的 isError 字段

## 注意事项
- 危险操作（rm -rf 等）需要人类审批
- 不要凭空猜测文件路径，先用 bash ls 确认
`,
};

// 给 mock 临时工作区注入种子文件 + 一个示例技能（供 §9 演示三层注入）
async function seedMockWorkspace(workDir) {
  for (const [relPath, content] of Object.entries(MOCK_SEED_FILES)) {
    await fs.writeFile(path.join(workDir, relPath), content, 'utf8');
  }
  // §9 第三层技能注入：.tiny-harness/skills/<name>/SKILL.md
  const skillDir = path.join(workDir, '.tiny-harness', 'skills', 'demo-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 演示用技能\n---\n# demo-skill\n这是一个演示技能，说明 SKILL.md 会被注入到 system prompt。\n', 'utf8');
}

const PORT = process.env.PORT || 3001;

// ===========================================
// 工具名 → 源码文件路径 映射（供 /api/source/:tool 使用）
// ===========================================
const TOOL_SOURCE_MAP = {
  bash: 'src/tools/bash.js',
  read_file: 'src/tools/read-file.js',
  write_file: 'src/tools/write-file.js',
  edit_file: 'src/tools/edit-file.js',
  registry: 'src/tools/registry.js',
  // 也允许查看引擎/上下文相关源码（教学场景）
  loop: 'src/engine/loop.js',
  reporter: 'src/engine/reporter.js',
  session: 'src/context/session.js',
  tracker: 'src/observability/tracker.js',
  trace: 'src/observability/trace.js',
  reminder: 'src/engine/reminder.js',
  compactor: 'src/context/compactor.js',
  composer: 'src/context/composer.js',
  recovery: 'src/context/recovery.js',
};

// ===========================================
// SSEReporter：把引擎事件转成 SSE 事件
// ===========================================
// 增强：tool_call / tool_result 携带 toolCallId，
// 让前端可以把同一次调用的请求和响应关联成卡片
// ===========================================
class SSEReporter extends Reporter {
  constructor(sendEvent) {
    super();
    this.sendEvent = sendEvent;  // (eventName, data) => void
  }

  onThinking() {
    this.sendEvent('thinking', { at: Date.now() });
  }

  onToolCall(toolName, args, toolCallId) {
    this.sendEvent('tool_call', { toolName, args, toolCallId, at: Date.now() });
  }

  onToolResult(toolName, result, isError, toolCallId) {
    this.sendEvent('tool_result', { toolName, result, isError, toolCallId, at: Date.now() });
  }

  onMessage(content) {
    if (!content) return;
    this.sendEvent('message', { content, at: Date.now() });
  }

  onSubAgentToolCall(toolName, args, toolCallId) {
    this.sendEvent('tool_call', { toolName: `[Sub] ${toolName}`, args, toolCallId, at: Date.now() });
  }

  onSubAgentToolResult(toolName, result, isError, toolCallId) {
    this.sendEvent('tool_result', { toolName: `[Sub] ${toolName}`, result, isError, toolCallId, at: Date.now() });
  }
}

// ===========================================
// ContextSpy：装饰 Provider，拦截每次 generate 的 messages
// ===========================================
// 这是第 13 讲 CostTracker 装饰器模式的再现——只是拦截的不是 usage 而是 messages。
// 用途：让前端"上下文流转"Tab 看到每轮 turn 传给模型的真实 messages 数组，
//       直观展示"上下文怎么拼出来、工具结果怎么塞回、多轮怎么累积"。
//
// 关键细节：
//   1. 深拷贝 messages 快照（JSON.parse(JSON.stringify)）——不然后续 append 会改坏原数组
//   2. 超长内容截断（复用第 04 讲思路）：> 1500 字符就头 600 + 尾 600 + 标注原长度
//      避免单条工具结果（如 read 10MB 文件）撑爆 SSE
//   3. 统计本轮总字符数 + 是否触发 Compactor（前端高亮压缩点）
class ContextSpy {
  constructor(realProvider, sendEvent) {
    this.real = realProvider;
    this.name = realProvider.name;
    this.sendEvent = sendEvent;
    this.turn = 0;
    this.prevTotalLen = 0;
  }

  async generate(messages, tools) {
    this.turn++;
    // 深拷贝 + 截断超长内容（避免 SSE 撑爆 + 避免改坏原数组）
    const snapshot = messages.map((m, i) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      const origLen = content.length;
      const truncated = origLen > 1500
        ? content.slice(0, 600) + `\n\n...[已截断，原始 ${origLen} 字符]...\n\n` + content.slice(-600)
        : content;
      return {
        index: i,
        role: m.role,
        content: truncated,
        origLen,
        toolCalls: m.toolCalls && m.toolCalls.length
          ? m.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments }))
          : undefined,
        toolCallId: m.toolCallId || undefined,
        isError: m.isError || undefined,
      };
    });

    const totalLen = snapshot.reduce((s, m) => s + (m.origLen || 0), 0);
    const event = {
      turn: this.turn,
      messages: snapshot,
      toolCount: tools ? tools.length : 0,
      toolNames: tools ? tools.map(t => t.name || (t.definition && t.definition().name)).filter(Boolean) : [],
      totalLen,
      prevTotalLen: this.prevTotalLen,
      compactorLikelyTriggered: this.prevTotalLen > 0 && totalLen < this.prevTotalLen * 0.7, // 明显变短 → 可能压缩了
      at: Date.now(),
    };
    this.sendEvent('context_snapshot', event);
    this.prevTotalLen = totalLen;

    // 透传给真实 Provider
    const resp = await this.real.generate(messages, tools);
    return resp;
  }
}

// ===========================================
// 拦截 console.log，转成 SSE 事件
// ===========================================
// 因为引擎里很多地方用 console.log 打日志（如 [Engine], [Tracker], [Reminder]），
// 我们把这些日志也推给前端显示
function patchConsole(sendEvent) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    sendEvent('log', { level: 'info', text, at: Date.now() });
    originalLog.apply(console, args);
  };
  console.warn = (...args) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    sendEvent('log', { level: 'warn', text, at: Date.now() });
    originalWarn.apply(console, args);
  };
  console.error = (...args) => {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    sendEvent('log', { level: 'error', text, at: Date.now() });
    originalError.apply(console, args);
  };

  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

// ===========================================
// 解析 session JSONL 文件为行数组（供前端展示）
// 每行：{ lineNo, raw, type, parsed }
// type: meta / user / assistant / tool_call / tool_result / unknown
// ===========================================
function parseSessionJsonl(content) {
  const lines = content.split('\n');
  const result = [];
  let lineNo = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    lineNo++;
    let parsed = null;
    let type = 'unknown';
    try {
      parsed = JSON.parse(line);
      if (parsed.__type === 'meta') {
        type = 'meta';
      } else if (parsed.__type === 'message' || parsed.role) {
        if (parsed.role === 'user' && parsed.toolCallId) type = 'tool_result';
        else if (parsed.role === 'assistant' && parsed.toolCalls && parsed.toolCalls.length > 0) type = 'tool_call';
        else if (parsed.role === 'user') type = 'user';
        else if (parsed.role === 'assistant') type = 'assistant';
        else type = parsed.role || 'unknown';
      }
    } catch {
      // 坏行原样返回
      parsed = null;
    }
    result.push({ lineNo, raw: line, type, parsed });
  }
  return result;
}

// ===========================================
// HTTP Server
// ===========================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 通用 CORS 头
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // ===== 路由 1: 首页 =====
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await fs.readFile(path.join(__dirname, 'harness.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`加载 HTML 失败: ${err.message}`);
    }
    return;
  }

  // ===== 路由 1.2: 精修版 UI（Linear/Vercel 风重做，功能与首页一致）=====
  if (url.pathname === '/harness' || url.pathname === '/harness.html') {
    try {
      const html = await fs.readFile(path.join(__dirname, 'harness.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`加载 HTML 失败: ${err.message}`);
    }
    return;
  }

  // ===== 路由 1.5: 列出所有 mock 剧本元数据 =====
  if (url.pathname === '/api/scripts') {
    const list = Object.entries(MOCK_SCRIPTS).map(([key, entry]) => ({
      key,
      section: entry.section,
      title: entry.title,
      hint: entry.hint,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scripts: list }));
    return;
  }

  // ===== 路由 2: SSE 启动 Agent =====
  if (url.pathname === '/api/run') {
    const script = url.searchParams.get('script') || 'react';
    const planMode = url.searchParams.get('plan') === '1';
    const providerName = url.searchParams.get('provider') || 'mock';
    const userPrompt = url.searchParams.get('prompt') || '';
    const autoApprove = url.searchParams.get('auto') === '1' || providerName !== 'mock';
    const requestedWorkDir = url.searchParams.get('workDir'); // 可选：真调指定固定项目目录

    // 设置 SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (eventName, data) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 准备临时工作区 + sessionId
    const sessionId = `demo-${Date.now()}`;

    // 发个 start 事件（携带 sessionId，前端可据此轮询 session JSONL）
    sendEvent('start', { script, planMode, provider: providerName, prompt: userPrompt, sessionId, at: Date.now() });

    // 拦截 console
    const restoreConsole = patchConsole(sendEvent);

    let workDir;
    try {
      // 准备工作区：真调可指定固定项目目录，否则用临时空目录
      if (requestedWorkDir) {
        workDir = path.resolve(PROJECT_ROOT, requestedWorkDir);
        // 安全校验：必须在项目根下，防路径穿越（如 ../../etc）
        if (!workDir.startsWith(PROJECT_ROOT + path.sep)) {
          sendEvent('error', { message: 'workDir 必须在项目根目录下', at: Date.now() });
          res.end();
          return;
        }
        // calc-app 实验环境：每次启动重置回初始黄金状态，保证可复现
        if (requestedWorkDir === 'demos/test-harness') {
          await resetCalcApp(workDir);
        } else {
          await fs.mkdir(workDir, { recursive: true });
        }
      } else {
        workDir = await fs.mkdtemp(path.join('/tmp', 'tiny-harness-demo-'));
        // 给 mock 工作区注入种子文件（README/package.json/AGENTS.md/技能），让依赖现成文件的示例正常运行
        await seedMockWorkspace(workDir);
      }
      sendEvent('workdir', { workDir, sessionId, at: Date.now() });

      // ===== 构造 Provider =====
      // 先创建 session（真调模式下 CostTracker 要用它累计花费）
      const session = new Session(sessionId, workDir);

      let provider;
      let modelName;
      let firstUserContent;

      if (providerName === 'mock') {
        // mock 剧本模式（12 个剧本，对应教程 12 节）
        const scriptEntry = MOCK_SCRIPTS[script];
        if (!scriptEntry) {
          sendEvent('error', { message: `未知剧本: ${script}（可用: ${Object.keys(MOCK_SCRIPTS).join(', ')}）`, at: Date.now() });
          restoreConsole();
          res.end();
          return;
        }
        provider = new MockProvider(scriptEntry.fn());
        modelName = 'mock';
        firstUserContent = `演示剧本 [${scriptEntry.section}/${scriptEntry.title}]: ${script}`;
      } else {
        // 真调模式
        try {
          if (providerName === 'openai') {
            provider = createOpenAIProviderFromEnv();
            modelName = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
          } else if (providerName === 'claude') {
            provider = createClaudeProviderFromEnv();
            modelName = process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
          } else {
            throw new Error(`未知 provider: ${providerName}（支持: mock | openai | claude）`);
          }
        } catch (err) {
          sendEvent('error', { message: `Provider 初始化失败: ${err.message}`, at: Date.now() });
          restoreConsole();
          res.end();
          return;
        }

        if (!userPrompt) {
          sendEvent('error', { message: '真调模式需要 prompt 参数', at: Date.now() });
          restoreConsole();
          res.end();
          return;
        }
        firstUserContent = userPrompt;

        // 用 CostTracker 包装一层（让前端看到花费估算）
        provider = new CostTracker(provider, modelName, session);
      }

      const registry = new Registry();
      registry.register(new ReadFileTool(workDir));
      registry.register(new WriteFileTool(workDir));
      registry.register(new EditFileTool(workDir));
      registry.register(new BashTool(workDir));
      // 审批中间件：拦截 rm -rf 等危险命令（演示 §8 人类审批）
      // registry 会把 {allowed:false} 转成 isError:true 返回给模型
      registry.use((call) => {
        if (call.name === 'bash' && /\brm\s+-rf\b/.test(String(call.arguments?.command || ''))) {
          return { allowed: false, rejectReason: 'rm -rf 是危险操作，已被审批中间件拦截。请改用更安全的方式（如 find -delete）。' };
        }
        return { allowed: true };
      });

      // ===== 关键增强：包装 session.append，实现实时持久化 =====
      // 这样前端轮询 /api/session 时可以看到每轮 append 的增量，
      // 用于演示 JSONL 的断点续传特性
      const origAppend = session.append.bind(session);
      session.append = (...msgs) => {
        origAppend(...msgs);
        for (const msg of msgs) {
          try {
            session.appendToStore(msg);
          } catch (e) {
            // 持久化失败不影响主流程
          }
        }
      };

      session.append(new Message({
        role: Role.USER,
        content: firstUserContent,
      }));

      // ===== 关键增强：用 ContextSpy 包一层 Provider =====
      // 装饰器模式（和 CostTracker 同构），拦截每次 generate 的 messages，
      // 推 context_snapshot 事件给前端"上下文流转"Tab。
      // 必须包在最外层（在 CostTracker 之后），保证看到的就是引擎实际传给 Provider 的内容。
      provider = new ContextSpy(provider, sendEvent);

      const engine = new AgentEngine(provider, registry, false, planMode);
      const reporter = new SSEReporter(sendEvent);

      const startTime = Date.now();
      await engine.run(session, reporter);
      const elapsed = Date.now() - startTime;

      // 全量再保存一次（meta 行会更新成最终统计）
      try { session.save(); } catch {}

      // 读取生成的 trace 文件，发给前端
      const traceDir = path.join(workDir, '.tiny-harness', 'traces');
      try {
        const traceFiles = await fs.readdir(traceDir);
        if (traceFiles.length > 0) {
          const traceData = await fs.readFile(path.join(traceDir, traceFiles[traceFiles.length - 1]), 'utf8');
          sendEvent('trace', { trace: JSON.parse(traceData), at: Date.now() });
        }
      } catch {
        // trace 读取失败不影响主流程
      }

      // 列出工作区生成的文件
      try {
        const files = await fs.readdir(workDir);
        const fileList = [];
        for (const f of files) {
          if (f === '.tiny-harness') continue;
          try {
            const stat = await fs.stat(path.join(workDir, f));
            if (stat.isFile()) {
              const content = await fs.readFile(path.join(workDir, f), 'utf8');
              fileList.push({ name: f, content, size: content.length });
            }
          } catch {}
        }
        sendEvent('files', { files: fileList, at: Date.now() });
      } catch {}

      sendEvent('done', {
        elapsed,
        estimatedCosts: session.estimatedCosts,
        totalPromptTokens: session.totalPromptTokens,
        totalCompletionTokens: session.totalCompletionTokens,
        sessionId,
        workDir,
        at: Date.now(),
      });

      // 延迟清理临时工作区（固定项目目录不删）：给前端 60 秒拉取 session JSONL 的时间
      if (!requestedWorkDir) {
        setTimeout(() => {
          fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }, 60_000);
      }
    } catch (err) {
      sendEvent('error', { message: err.message, stack: err.stack, at: Date.now() });
    } finally {
      restoreConsole();
      res.end();
    }
    return;
  }

  // ===== 路由 3: 获取 Session JSONL 内容 =====
  // GET /api/session?sessionId=xxx&workDir=xxx
  // 返回解析后的行数组（含行号、类型、原始 JSON）
  if (url.pathname === '/api/session') {
    const sessionId = url.searchParams.get('sessionId');
    const workDir = url.searchParams.get('workDir');
    if (!sessionId || !workDir) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: '缺少 sessionId 或 workDir' }));
      return;
    }
    // 防止路径穿越：sessionId 只允许字母数字._-
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: '非法 sessionId' }));
      return;
    }
    const safeWorkDir = path.resolve(workDir);
    const isTmp = safeWorkDir.startsWith('/tmp/') || safeWorkDir.startsWith('/var/folders/');
    const isInProject = safeWorkDir.startsWith(PROJECT_ROOT + path.sep);
    if (!isTmp && !isInProject) {
      // 演示服务器只允许读取临时目录或项目根下的工作区
      res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'workDir 必须位于临时目录或项目根下' }));
      return;
    }
    const jsonlPath = path.join(safeWorkDir, '.tiny-harness', 'sessions', `${sessionId}.jsonl`);
    try {
      const content = await fs.readFile(jsonlPath, 'utf8');
      const lines = parseSessionJsonl(content);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
      res.end(JSON.stringify({ sessionId, workDir: safeWorkDir, path: jsonlPath, lines, totalLines: lines.length }));
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
      res.end(JSON.stringify({ error: `读取 session 失败: ${err.message}`, lines: [], totalLines: 0 }));
    }
    return;
  }

  // ===== 路由 4: 获取工具/模块源码 =====
  // GET /api/source/:tool
  // 返回纯文本源码（前端用 <pre> 展示）
  const sourceMatch = url.pathname.match(/^\/api\/source\/([A-Za-z0-9_-]+)$/);
  if (sourceMatch) {
    const tool = sourceMatch[1];
    const relPath = TOOL_SOURCE_MAP[tool];
    if (!relPath) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
      res.end(JSON.stringify({ error: `未知工具/模块: ${tool}`, available: Object.keys(TOOL_SOURCE_MAP) }));
      return;
    }
    const fullPath = path.resolve(PROJECT_ROOT, relPath);
    // 防止路径穿越：必须在 PROJECT_ROOT/src 下
    if (!fullPath.startsWith(path.join(PROJECT_ROOT, 'src') + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: '禁止访问 src 之外的文件' }));
      return;
    }
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: `不是文件: ${relPath}` }));
        return;
      }
      const code = await fs.readFile(fullPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-File-Path': relPath,
        ...corsHeaders,
      });
      res.end(code);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
      res.end(JSON.stringify({ error: `读取源码失败: ${err.message}` }));
    }
    return;
  }

  // ===== 路由 5: 列出可用工具/模块（供前端"查看源码"按钮初始化）=====
  if (url.pathname === '/api/tools') {
    const tools = Object.entries(TOOL_SOURCE_MAP).map(([name, relPath]) => ({ name, path: relPath }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
    res.end(JSON.stringify({ tools }));
    return;
  }

  // ===== 路由 6: 静态文件 - 让 ../README.md 等链接能在浏览器打开 =====
  // 仅放行 docs/ 和根目录下的 .md 文件，防止任意文件读取
  if (url.pathname.startsWith('/docs/') || /^\/[^/]+\.md$/.test(url.pathname)) {
    const relPath = url.pathname.slice(1);
    const fullPath = path.resolve(PROJECT_ROOT, relPath);
    if (!fullPath.startsWith(PROJECT_ROOT + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const content = await fs.readFile(fullPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
      res.end(content);
    } catch (err) {
      res.writeHead(404);
      res.end('Not Found');
    }
    return;
  }

  // ===== 路由 7: 404 =====
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('🌐 tiny-harness 交互式演示服务器已启动');
  console.log(`   浏览器打开: http://localhost:${PORT}`);
  console.log('='.repeat(60));
  console.log('\n可用剧本:');
  console.log('  - read-file       最简单的 ReAct 循环')
  console.log('  - write-and-read  并发工具执行')
  console.log('  - loop            死循环检测')
  console.log('  - approval        人类审批')
  console.log('  - plan-mode       Plan Mode 持久化')
  console.log('\nAPI 路由:');
  console.log('  GET /                       首页 HTML');
  console.log('  GET /api/run?script=xxx     SSE 流式运行');
  console.log('  GET /api/session?sessionId=&workDir=');
  console.log('                              读取会话 JSONL');
  console.log('  GET /api/source/:tool       读取工具源码');
  console.log('  GET /api/tools              列出可用工具');
  console.log('\n快捷键（浏览器内）:');
  console.log('  1-5 切剧本 / R 重跑 / S 停止 / J,K 滚动 / ? 帮助');
  console.log('\n按 Ctrl+C 停止\n');
});
