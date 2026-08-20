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

  addEvent(name, attributes = {}) {
    if (!this.events) this.events = [];
    this.events.push({ name, timestamp: Date.now(), attributes });
  }
}

// 开启一个新 Span，自动挂到父 Span 下
// 用法：await startSpan('LLM 调用', async (span) => { ... span.addAttribute(...); });
export async function startSpan(name, fn) {
  // getStore() 读取「当前异步执行链」绑定的存储值；本项目在该值中放的是当前正在执行的父 Span。
  // 这个值不是全局变量：AsyncLocalStorage 会让不同的并发 async 任务各自取回自己的上下文，避免串线。
  //
  // 例如 Agent.Run 内部调用 startSpan('Turn-1') 时，run() 已通过 traceStorage.run(rootSpan, ...) 绑定了根 Span，
  // 此处得到 parent === rootSpan；再进入 Turn-1 内部调用 startSpan('LLM.Action')，得到 parent === Turn-1。
  // 若 startSpan() 从未处于任何 traceStorage.run(...) 范围内，getStore() 返回 undefined；这时当前 span 就是一个独立根节点。
  const parent = traceStorage.getStore();
  const span = new Span(name);

  if (parent) {
    parent.addChild(span);
  }

  try {
    // run(store, callback) 会在执行 callback 的整个同步 + 异步生命周期内，将 store 设为“当前上下文”。
    // 这里把刚创建的 span 绑定进去，因此 fn(span) 内部及其继续 await 的异步调用中，
    // traceStorage.getStore() 都能取回这个 span；嵌套的 startSpan() 就会自动把新 Span 挂到它下面。
    //
    // `() => fn(span)` 是延迟执行的回调：run() 先建立上下文，再调用 fn，并把当前 span 作为参数交给 fn 记录属性。
    // traceStorage.run(...) 的返回值就是 fn 的返回值（此处通常为 Promise）。return await 必须等待这个 Promise 真正完成：
    // 只有模型请求、工具调用等全部结束后才离开 try，finally 才会调用 span.end() 记录正确的耗时。
    // 若直接 `return traceStorage.run(...)`，finally 会立即执行，Span 耗时只会记录到“任务刚启动”为止。
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

export function addTraceEvent(name, attributes = {}) {
  const span = getCurrentSpan();
  if (span) span.addEvent(name, attributes);
}
