// ===========================================
// observability/trace.js
// ===========================================
// 链路追踪：把一次 Agent 运行记录成 Span 树
//
// 为什么需要：
//   - 调试时想看 "模型思考了多久" + "工具执行了多久"
//   - 出问题时想看 "哪一步慢了" + "哪一步花了钱"
//   - 复盘时想把整棵调用树导出来给同事看
//
// 数据结构：树
//   RootSpan (一次 Run)
//     ├── Span (一次 LLM 调用)
//     │     attributes: { model, prompt_tokens, completion_tokens, cost }
//     ├── Span (一次工具调用)
//     │     attributes: { tool, args, output_len }
//     └── Span (子 Agent 调用)
//           └── ...
//
// ===========================================

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';

const traceStorage = new AsyncLocalStorage();

export class Span {
  constructor(name) {
    this.name = name;
    this.startTime = Date.now();
    this.endTime = null;
    this.durationMs = 0;
    this.attributes = {};
    this.children = [];
  }

  end() {
    this.endTime = Date.now();
    this.durationMs = this.endTime - this.startTime;
  }

  addAttribute(key, value) {
    this.attributes[key] = value;
  }

  addChild(child) {
    this.children.push(child);
  }
}

// 开启一个新 Span，自动挂到父 Span 下
// 用法：await startSpan('LLM 调用', async (span) => { ... span.addAttribute(...); });
export async function startSpan(name, fn) {
  const parent = traceStorage.getStore();
  const span = new Span(name);

  if (parent) {
    parent.addChild(span);
  }

  try {
    return await traceStorage.run(span, () => fn(span));
  } finally {
    span.end();
  }
}

// 把根 Span 导出成 JSON 文件
export async function exportTraceToFile(rootSpan, workDir, sessionId) {
  const traceDir = path.join(workDir, '.tiny-harness', 'traces');
  await fs.mkdir(traceDir, { recursive: true });

  // Date.now() 返回毫秒时间戳；教学版文件名保持简单。
  const filename = `trace_${sessionId}_${Date.now()}.json`;
  const fullPath = path.join(traceDir, filename);

  const data = JSON.stringify(rootSpan, null, 2);
  await fs.writeFile(fullPath, data, 'utf8');
  return fullPath;
}

// 拿到当前 Span（用于在工具内部 addAttribute）
export function getCurrentSpan() {
  return traceStorage.getStore();
}
