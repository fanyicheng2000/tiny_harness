// ===========================================
// context/compactor.js
// ===========================================
// 上下文压缩器：防止长任务上下文爆炸
//
// 三档压缩策略：
//   1. System Prompt 永不压缩（硬约束不能丢）
//   2. 工作记忆内（最近 N 条）：超长内容做头尾截断
//   3. 工作记忆外（早期消息）：替换成摘要标记
//
// 为什么不直接丢弃早期消息？
//   丢弃后模型完全不知道"发生过什么"，会重复执行
//   保留"已清理"的标记，模型至少知道这里曾有内容
// ===========================================

import { Role } from '../schema/message.js';

export class Compactor {
  /**
   * @param {number} maxChars - 触发压缩的字符数阈值
   * @param {number} retainLastMsgs - 保护最近多少条消息不被摘要
   */
  constructor(maxChars = 200000, retainLastMsgs = 6) {
    this.maxChars = maxChars;
    this.retainLastMsgs = retainLastMsgs;
  }

  /**
   * 压缩消息列表
   * @param {Message[]} msgs
   * @returns {Message[]}
   */
  compact(msgs) {
    const currentLength = this._estimateLength(msgs);
    if (currentLength < this.maxChars) {
      return msgs;  // 没超阈值，不压缩
    }

    console.log(`[Compactor] ⚠️ 内存告警：当前上下文长度 (${currentLength} 字符) 超过阈值 (${this.maxChars})，触发压缩清理...`);

    const compacted = [];
    const msgCount = msgs.length;
    const protectStartIndex = Math.max(0, msgCount - this.retainLastMsgs);

    for (let i = 0; i < msgCount; i++) {
      const msg = msgs[i];

      // System Prompt 永不压缩
      if (msg.role === Role.SYSTEM) {
        compacted.push(msg);
        continue;
      }

      const newMsg = { ...msg, content: msg.content };
      const isInWorkingMemory = i >= protectStartIndex;

      // 工具结果消息
      if (msg.role === Role.USER && msg.toolCallId) {
        if (!isInWorkingMemory) {
          // 早期工具输出：超过 200 字符就摘要
          if (msg.content.length > 200) {
            newMsg.content = `...[为了节省内存，早期的工具输出已被系统强制清理。原始长度: ${msg.content.length} 个 JavaScript 字符]...`;
          }
        } else {
          // 工作记忆内的工具输出：超 1000 字符就头尾截断
          const maxKeep = 1000;
          if (msg.content.length > maxKeep) {
            const head = msg.content.slice(0, 500);
            const tail = msg.content.slice(-500);
            newMsg.content = `${head}\n\n...[内容过长，中间 ${msg.content.length - maxKeep} 个 JavaScript 字符已被系统截断]...\n\n${tail}`;
          }
        }
      } else if (msg.role === Role.ASSISTANT && msg.content) {
        // 早期推理过程：折叠
        if (!isInWorkingMemory && msg.content.length > 200) {
          newMsg.content = '...[早期的推理思考过程已折叠]...';
        }
      }

      compacted.push(newMsg);
    }

    const newLength = this._estimateLength(compacted);
    console.log(`[Compactor] ✅ 压缩完成。上下文长度从 ${currentLength} 降至 ${newLength} 字符。`);

    return compacted;
  }

  // 估算消息列表的字符总长度
  _estimateLength(msgs) {
    let length = 0;
    for (const msg of msgs) {
      length += (msg.content || '').length;
      for (const tc of (msg.toolCalls || [])) {
        length += (tc.name || '').length;
        length += JSON.stringify(tc.arguments || {}).length;
      }
    }
    return length;
  }
}
