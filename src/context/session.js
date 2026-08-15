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

// 根据会话 ID 计算它在当前工作区中的持久化文件路径。
// 例如：id = "task-1"、workDir = "/Users/me/project" 时，
// 返回：/Users/me/project/.tiny-harness/sessions/task-1.jsonl
function sessionFile(id, workDir) {
  // 会话 ID 会参与拼接文件路径，因此只允许安全字符，避免传入 "../" 等路径片段。
  if (typeof id !== 'string' || !SAFE_SESSION_ID.test(id)) {
    throw new Error('会话 ID 只能包含字母、数字、点、下划线和连字符');
  }

  // path.resolve(workDir) 将工作区转为绝对路径；
  // path.join 再依次拼接隐藏存储目录和以会话 ID 命名的 JSONL 文件。
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

  // 追加一条或多条消息到会话历史，并更新最近修改时间。
  //
  // `...msgs` 是 JavaScript 的“剩余参数（rest parameters）”语法：
  // 调用 append(msg1) 时，msgs 是 [msg1]；调用 append(msg1, msg2) 时，msgs 是 [msg1, msg2]。
  // 因而调用者既可以一次追加一条消息，也可以一次追加一批消息。
  //
  // `this.history.push(...msgs)` 中的 `...msgs` 则是“展开（spread）”语法：
  // 将数组 [msg1, msg2] 展开成 push(msg1, msg2)，使两条消息分别作为元素加入 history，
  // 而不是把整个 [msg1, msg2] 数组作为一个元素塞进 history。
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

    // 两种情况直接返回全部历史：
    // 1. 历史消息总数没有超过 limit，没有必要截取；
    // 2. limit <= 0 在这里被约定为“不限制条数”，不是“返回 0 条”。
    //
    // `[...this.history]` 会创建一个新的数组副本：
    // 调用方可以修改返回的数组（如 slice、push），但不会影响 Session 内部的 this.history 数组。
    // 注意：这是浅拷贝，数组里的每个 Message 对象本身仍是同一个对象。
    if (total <= limit || limit <= 0) {
      return [...this.history];
    }

    // `slice(total - limit)` 从“倒数第 limit 条消息”开始截取到末尾，
    // 因而得到最近 limit 条历史消息。例如共有 10 条、limit 为 3：
    // total - limit = 7，slice(7) 返回下标 7、8、9 对应的最后 3 条。
    // slice 会返回一个新数组，不会删除或改动 this.history 里较早的消息。
    let res = this.history.slice(total - limit);

    // 截取最近 N 条消息时，可能把“模型发起 ToolCall 的 assistant 消息”截掉，
    // 却留下它后面的工具结果。例如 assistant 同时发起 call_a、call_b 后，
    // res 的开头只剩“call_a 的结果、call_b 的结果”；这两条结果没有来源，
    // OpenAI / Claude 等 Provider 会认为工具调用历史不合法。
    //
    // 因此，只要 res 的第一条仍是带 toolCallId 的工具结果，就不断删除第一条；
    // 直到第一条不再是工具结果，确保返回给 Provider 的上下文不会从“无主结果”开始。
    while (res.length > 0) {
      if (res[0].role === Role.USER && res[0].toolCallId) {
        res = res.slice(1); // 删除当前开头的无主工具结果，再检查下一条。
      } else {
        break; // 第一条已有正常上下文来源，不需要继续删除。
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

  // 生成会话的“元数据快照”，用于写入 .jsonl 文件的一行。
  //
  // 元数据不是用户、模型或工具之间的对话消息；它记录的是“这整个会话目前的状态”，例如：
  // - 会话属于哪个工作区、何时创建/更新；
  // - 到目前为止累计消耗了多少输入/输出 Token、估算花费多少；
  // - history 中当前有多少条消息。
  //
  // save() 每次持久化时会追加一个新的 meta 行。加载时会读取最后一个 meta 行，
  // 因此即使旧快照还留在文件中，最新快照仍会覆盖旧状态；消息内容则以独立的 message 行保存。
  _metaObject() {
    return {
      // 用 __type 区分“会话状态快照”和后续的 { __type: 'message', ...msg } 对话消息行。
      __type: 'meta',
      id: this.id,                                // 会话唯一标识，也是文件名的一部分。
      workDir: this.workDir,                      // 该会话操作的工作区目录。
      createdAt: this.createdAt.toISOString(),    // 转为字符串，方便写入 JSON 并在下次加载时恢复为 Date。
      updatedAt: this.updatedAt.toISOString(),    // 最近一次追加消息或保存时的更新时间。
      totalPromptTokens: this.totalPromptTokens,  // 模型累计输入 Token。
      totalCompletionTokens: this.totalCompletionTokens, // 模型累计输出 Token。
      estimatedCosts: this.estimatedCosts,        // 按币种累计的本地费用估算。
      count: this.history.length,                 // 当前完整对话历史的消息数量，用于查看/排查状态。
    };
  }

  // 【appendToStore 和 save 的区别】
  //
  // appendToStore(msg)：调用者明确给我“一条 msg”，我立刻只把这一条追加到文件末尾。
  // 它适合“每收到一条消息就立刻存盘”的实时保存场景；它不检查 this.history 是否被清空、
  // 不补写最新 Token/费用 meta，也不会修正磁盘文件与内存 history 不一致的问题。
  //
  // save()：不接收 msg，而是自己比较 this.history 和 appendedCount，找出“内存里新增但未落盘”的
  // 所有消息后批量保存，同时更新最新 meta；若发现 /clear 让内存历史变短，还会重写整个文件。
  // 当前主流程在每轮任务结束后调用 save()；appendToStore 是预留的实时持久化能力。
  //
  // JSONL（JSON Lines）规则：一行就是一个完整 JSON 对象。此方法只在文件末尾追加，不改旧内容：
  // - 文件首次创建时：追加一行 meta（会话状态快照）和一行 message；
  // - 文件已经存在时：只追加一行本次传入的 message。
  appendToStore(msg) {
    const file = sessionFile(this.id, this.workDir); // 得到目标文件，例如 .tiny-harness/sessions/task-1.jsonl。
    const dir = path.dirname(file); // 从完整文件路径取出父目录，例如 .tiny-harness/sessions。
    fs.mkdirSync(dir, { recursive: true }); // 目录不存在则递归创建；已存在时不会报错。

    // 先判断文件是否第一次创建：首次创建必须写入 meta，后续只追加消息即可。
    const isNewFile = !fs.existsSync(file);

    // 用数组暂存这一次要写入的多行文本，最后一次性 append 到文件末尾。
    const chunks = [];
    if (isNewFile) {
      // JSON.stringify 将 JS 对象转成一行 JSON 文本；meta 记录 Session 的时间、Token、费用等状态。
      chunks.push(JSON.stringify(this._metaObject()));
    }

    // `{ __type: 'message', ...msg }`：先标记此行是对话消息，再展开 msg 的字段（role、content 等）。
    // 这样 load() 读取文件时就能根据 __type 区分“元数据行”和“消息行”。
    chunks.push(JSON.stringify({ __type: 'message', ...msg }));

    // join('\n') 把多行 JSON 用换行拼起来，末尾再补一个 \n，满足“一行一个 JSON”的 JSONL 格式。
    // appendFileSync 是追加写：不会覆盖之前已经保存的历史消息。
    fs.appendFileSync(file, chunks.join('\n') + '\n', 'utf8');

    // 已成功额外写入一条 message，因此同步更新“已经落盘的消息数量”计数器。
    this.appendedCount++;
  }

  // 将“内存中的完整 Session 状态”同步到 JSONL 文件；这是当前主流程实际使用的保存方法。
  //
  // 它不由调用方指定要写哪条消息，而是根据 appendedCount 自动计算：
  //   newMessages = this.history.slice(this.appendedCount)
  // 即找出 history 中“尚未写入磁盘”的全部消息，批量追加；随后再追加最新 meta，保存 Token/费用等状态。
  //
  // 三种处理方式：
  // 1. 文件不存在，或 /clear 使 history 比已落盘数量更短：使用临时文件全量重写 meta + 全部消息；
  // 2. 有新消息：只追加这些新消息 + 最新 meta，不重写旧历史；
  // 3. 没有新消息：只追加最新 meta，例如 Token 或费用发生变化时。
  save() {
    const file = sessionFile(this.id, this.workDir);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    // 检测是否需要全量重写：
    // 1. 文件不存在
    // 2. 历史长度小于 appendedCount（说明被 /clear 截断过）
    // 3. 没有新增消息（仅元数据变化）
    const fileExists = fs.existsSync(file);

    // needFullRewrite 的意思是“这次不能只往文件末尾追加，必须用当前内存状态重写整个 JSONL 文件”。
    //
    // 触发条件：
    // 1. !fileExists：磁盘上还没有存档文件，无法在旧文件后增量追加；
    // 2. history.length < appendedCount：以前已经落盘的消息数比当前内存历史还多，
    //    通常表示用户执行了 /clear，把 this.history 清空或缩短了。
    //    此时若只追加，新文件仍会保留磁盘中的旧消息，与内存状态不一致，因此必须全量重写。
    //
    // 例如：保存过 10 条消息后 appendedCount = 10；/clear 后 history.length = 0，
    // 就会得到 0 < 10，needFullRewrite = true，最终文件会被重写为空历史 + 最新 meta。
    const needFullRewrite = !fileExists || this.history.length < this.appendedCount;

    // 仅在“不需要全量重写”时有意义：取出 history 中还没有落盘的新增消息。
    const newMessages = this.history.slice(this.appendedCount);

    if (needFullRewrite) {
      // 全量重写不是“在旧文件后追加”，而是从当前 this.history 重新生成一份完整的新文件内容：
      // 第 1 行是最新 meta，之后每一行都是当前内存中仍保留的 message。
      // 因此 /clear 后 this.history = [] 时，lines 最终只有一行 meta，旧的 message 不会被带进新文件。
      const lines = [JSON.stringify(this._metaObject())];
      for (const msg of this.history) {
        lines.push(JSON.stringify({ __type: 'message', ...msg }));
      }

      // 不直接 writeFileSync(file, ...)，而是采用“临时文件 → 改名替换”的两步：
      // 1. 先将完整新内容写入 task-1.jsonl.tmp；原来的 task-1.jsonl 此时仍未动；
      // 2. 只有临时文件写成功后，renameSync 才用它替换正式文件。
      // 这样即使写入中途进程异常，旧会话文件通常仍完整，避免把正式文件写到一半损坏。
      const tempFile = `${file}.tmp`;
      fs.writeFileSync(tempFile, lines.join('\n') + '\n', 'utf8');
      fs.renameSync(tempFile, file);

      // 新文件已包含当前全部 history，所以这些消息现在都算“已落盘”。
      this.appendedCount = this.history.length;
      return file; // 全量重写完成，不再走后面的增量追加逻辑。
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

  // 从已经存在的 Session JSONL 文件恢复一个 Session 对象，用于“断点续传”。
  //
  // 它做的事情可以理解为“把磁盘存档重新装回内存”：
  // 1. 逐行读取 JSONL；每行要么是 meta（时间、Token、费用等状态），要么是 message（聊天记录）；
  // 2. 收集全部 message，并使用最后一个 meta 作为最新状态快照；
  // 3. 把普通 JSON 对象重新转换为 Message 实例，最后返回可继续使用的 Session。
  //
  // static 表示它属于 Session 类本身，而非某个已经存在的 session 实例：
  // 调用形式是 Session._loadFromJsonl(...)，而不是 session._loadFromJsonl(...)。
  // 前导下划线表示内部辅助方法；外部通常只调用 Session.load(id, workDir)。
  static _loadFromJsonl(id, workDir, file) {
    const session = new Session(id, workDir); // 先创建空 Session，再把文件中的历史和状态填回去。
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
