// ===========================================
// context/session.js
// ===========================================
// Session：管理一次对话的完整历史
//
// 核心职责：
//   1. 存储消息历史（history）
//   2. 提供 Working Memory（工作记忆，最近 N 条，用于喂给模型）
//   3. 累计 Token 消耗和费用
//
// 持久化：JSONL 追加写
//   - 文件：.tiny-harness/sessions/<id>.jsonl
//   - 每行一个 JSON 对象，type 字段区分 meta / message
//   - 第一行 meta（id/createdAt/token/cost 等元数据）
//   - 后续每行一条 message
//   - save() 追加新消息 + 追加新 meta 行（旧 meta 自动作废）
//   - load() 逐行 parse，坏行跳过，最后一个 meta 生效
//
// 为什么用 JSONL 不用 JSON：
//   1. 进程被杀时只丢最后一条，不丢整个历史
//   2. 不需要 temp → rename 两步 dance
//   3. 大历史可逐行流式读取，不用一次性加载到内存
//
// 关键工程点：Working Memory 无主工具结果处理
//   截取最近 N 条时，可能把工具结果消息截断
//   导致"有 ToolCallID 没对应 ToolCall"的无主工具结果
//   会形成缺少对应 tool call 的无效历史，需循环剔除开头的无主结果
// ===========================================

import { Message, Role } from '../schema/message.js';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function sessionFile(id, workDir) {
  if (typeof id !== 'string' || !SAFE_SESSION_ID.test(id)) {
    throw new Error('会话 ID 只能包含字母、数字、点、下划线和连字符');
  }
  return path.join(path.resolve(workDir), '.tiny-harness', 'sessions', `${id}.jsonl`);
}

export class Session {
  constructor(id, workDir) {
    this.id = id;
    this.workDir = workDir;
    this.createdAt = new Date();
    this.updatedAt = new Date();

    // Token / 费用累计
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.estimatedCosts = {};

    this.history = [];  // 消息历史

    // 已追加写入文件的消息数量（用于增量写）
    // -1 表示尚未加载，>=0 表示已加载并和文件同步
    this.appendedCount = 0;
  }

  // 追加消息
  append(...msgs) {
    this.history.push(...msgs);
    this.updatedAt = new Date();
  }

  /**
   * 获取 Working Memory（工作记忆，最近 N 条消息）
   *
   * @param {number} limit - 最多返回多少条
   * @returns {Message[]}
   */
  getWorkingMemory(limit = 20) {
    const total = this.history.length;
    if (total <= limit || limit <= 0) {
      return [...this.history];
    }

    let res = this.history.slice(total - limit);

    // 处理截断边缘的无主工具结果问题
    // 如果第一条是工具结果（有 toolCallId），但没有对应的 ToolCall
    // 避免把缺少对应调用的工具结果交给 Provider
    while (res.length > 0) {
      if (res[0].role === Role.USER && res[0].toolCallId) {
        res = res.slice(1);
      } else {
        break;
      }
    }

    return res;
  }

  // 累加账单（给 CostTracker 调用）
  recordUsage(promptTokens, completionTokens, estimate = null) {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    if (estimate?.currency && Number.isFinite(estimate.amount)) {
      this.estimatedCosts[estimate.currency] =
        (this.estimatedCosts[estimate.currency] || 0) + estimate.amount;
    }
  }

  // 元数据对象（写到 JSONL 文件的一行）
  _metaObject() {
    return {
      __type: 'meta',
      id: this.id,
      workDir: this.workDir,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      estimatedCosts: this.estimatedCosts,
      count: this.history.length,
    };
  }

  // 增量追加单条消息（可选，用于实时持久化）
  appendToStore(msg) {
    const file = sessionFile(this.id, this.workDir);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const isNewFile = !fs.existsSync(file);
    const chunks = [];
    if (isNewFile) {
      // 新文件：先写 meta 头
      chunks.push(JSON.stringify(this._metaObject()));
    }
    chunks.push(JSON.stringify({ __type: 'message', ...msg }));
    fs.appendFileSync(file, chunks.join('\n') + '\n', 'utf8');
    this.appendedCount++;
  }

  // 以 JSONL 追加写方式落盘。
  // - 新文件：先写 meta 头，再写所有 message 行
  // - 已存在文件：只追加新增 message 行，再追加新 meta 行（旧 meta 自动作废）
  // - 全量重写分支：当历史被截断（如 /clear）或 appendedCount 失同步时使用
  save() {
    const file = sessionFile(this.id, this.workDir);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    // 检测是否需要全量重写：
    // 1. 文件不存在
    // 2. 历史长度小于 appendedCount（说明被 /clear 截断过）
    // 3. 没有新增消息（仅元数据变化）
    const fileExists = fs.existsSync(file);
    const needFullRewrite = !fileExists || this.history.length < this.appendedCount;
    const newMessages = this.history.slice(this.appendedCount);

    if (needFullRewrite) {
      // 全量重写：meta 行 + 所有 message 行
      const lines = [JSON.stringify(this._metaObject())];
      for (const msg of this.history) {
        lines.push(JSON.stringify({ __type: 'message', ...msg }));
      }
      // 用临时文件 + rename 保证原子性（只在全量重写时用）
      const tempFile = `${file}.tmp`;
      fs.writeFileSync(tempFile, lines.join('\n') + '\n', 'utf8');
      fs.renameSync(tempFile, file);
      this.appendedCount = this.history.length;
      return file;
    }

    // 增量追加：新消息 + 更新后的 meta 行
    if (newMessages.length === 0) {
      // 没有新消息，只更新 meta（追加新 meta 行）
      fs.appendFileSync(file, JSON.stringify(this._metaObject()) + '\n', 'utf8');
      return file;
    }

    const chunks = [];
    for (const msg of newMessages) {
      chunks.push(JSON.stringify({ __type: 'message', ...msg }));
    }
    chunks.push(JSON.stringify(this._metaObject()));
    fs.appendFileSync(file, chunks.join('\n') + '\n', 'utf8');
    this.appendedCount = this.history.length;
    return file;
  }

  static load(id, workDir) {
    const jsonlFile = sessionFile(id, workDir);
    if (fs.existsSync(jsonlFile)) {
      return Session._loadFromJsonl(id, workDir, jsonlFile);
    }
    return new Session(id, workDir);
  }

  static _loadFromJsonl(id, workDir, file) {
    const session = new Session(id, workDir);
    let meta = null;
    const messages = [];

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        // 坏行跳过（进程被杀可能留下半行）
        continue;
      }
      if (obj.__type === 'meta') {
        meta = obj;  // 最后一个 meta 生效
      } else if (obj.__type === 'message' || obj.role) {
        messages.push(obj);
      }
    }

    if (meta) {
      session.createdAt = meta.createdAt ? new Date(meta.createdAt) : new Date();
      session.updatedAt = meta.updatedAt ? new Date(meta.updatedAt) : session.createdAt;
      session.totalPromptTokens = meta.totalPromptTokens || 0;
      session.totalCompletionTokens = meta.totalCompletionTokens || 0;
      session.estimatedCosts = meta.estimatedCosts && typeof meta.estimatedCosts === 'object'
        ? meta.estimatedCosts
        : {};
    }

    session.history = messages.map((m) => new Message(m));
    session.appendedCount = session.history.length;
    return session;
  }

}

// ===========================================
// SessionManager：按 ID 管理 Session
// ===========================================
// 同一 session ID → 同一份 Session 实例
// 这是断点续传的基础（模块九）
export class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  getOrCreate(id, workDir) {
    if (this.sessions.has(id)) {
      return this.sessions.get(id);
    }
    const sess = Session.load(id, workDir);
    this.sessions.set(id, sess);
    return sess;
  }
}

export const globalSessionMgr = new SessionManager();
