// ===========================================
// context/thread.js
// ===========================================
// Thread：子 Agent 的持久化线程
//
// 与主 Session 的区别：
//   1. Thread 专为子 Agent 设计，文件存放在 .tiny-harness/threads/ 目录
//   2. 支持 "后续消息复用"：Coordinator 可以追加新指令到已有线程
//   3. 无 Token/费用追踪（子 Agent 的成本由主 Session 间接统计）
//
// JSONL 格式与 Session 完全兼容，便于后续合并或迁移。
// ===========================================

import { Message, Role } from '../schema/message.js';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_THREAD_ID = /^[A-Za-z0-9._-]+$/;

function threadFile(id, workDir) {
  if (typeof id !== 'string' || !SAFE_THREAD_ID.test(id)) {
    throw new Error('线程 ID 只能包含字母、数字、点、下划线和连字符');
  }
  return path.join(path.resolve(workDir), '.tiny-harness', 'threads', `${id}.jsonl`);
}

export class Thread {
  constructor(id, workDir) {
    this.id = id;
    this.workDir = workDir;
    this.history = [];
    this.appendedCount = 0;
  }

  append(...messages) {
    for (const msg of messages) {
      this.history.push(msg);
    }
  }

  save() {
    const file = threadFile(this.id, this.workDir);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    const needFullRewrite = !fs.existsSync(file) || this.history.length < this.appendedCount;
    const newMessages = this.history.slice(this.appendedCount);

    if (needFullRewrite) {
      const lines = this.history.map((msg) => JSON.stringify({ __type: 'message', ...msg }));
      const tempFile = `${file}.tmp`;
      fs.writeFileSync(tempFile, lines.join('\n') + '\n', 'utf8');
      fs.renameSync(tempFile, file);
      this.appendedCount = this.history.length;
      return file;
    }

    if (newMessages.length > 0) {
      const chunks = newMessages.map((msg) => JSON.stringify({ __type: 'message', ...msg }));
      fs.appendFileSync(file, chunks.join('\n') + '\n', 'utf8');
      this.appendedCount = this.history.length;
    }
    return file;
  }

  static load(id, workDir) {
    const file = threadFile(id, workDir);
    const thread = new Thread(id, workDir);
    if (!fs.existsSync(file)) return thread;

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.__type === 'message' || obj.role) {
          thread.history.push(new Message(obj));
        }
      } catch {
        continue;
      }
    }
    thread.appendedCount = thread.history.length;
    return thread;
  }
}
