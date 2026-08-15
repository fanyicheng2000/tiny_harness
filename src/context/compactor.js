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
   * 压缩“本轮准备发送给模型”的消息列表，避免上下文总体积超过阈值。
   *
   * 注意：它不是长期记忆/历史检索机制：
   * - 不会从 Session.history 中找回已经滑出 Working Memory 的早期聊天记录；
   * - 不会修改 Session.history，也不会修改 JSONL 存档；
   * - 它只接收 Engine 本轮准备发送给 Provider 的 msgs 副本，并返回一个临时压缩版本。
   *
   * 主 Agent 的典型输入是：[System Prompt, ...session.getWorkingMemory(20)]，
   * 即通常最多只有“系统提示词 + 最近 20 条消息”。即使条数不多，单条工具结果、
   * 用户输入或模型回复仍可能很长，因此仍需按总字符数进行第二层兜底限制。
   * 子 Agent 的 contextHistory 会随探索轮次持续增长，更容易依赖此方法压缩。
   *
   * 压缩策略：System Prompt 永远保留；较早的长工具输出/推理被折叠；最近若干条消息
   * 优先保留，但其中过长的工具输出只保留头尾。原始 msgs 数组和 Message 对象不被修改。
   *
   * @param {Message[]} msgs 本轮要传给模型的上下文消息数组
   * @returns {Message[]} 未超限时直接返回原数组；超限时返回内容被替换/截断后的新数组
   */
  compact(msgs) {
    // 这里估算的是“本轮要发给模型的 msgs”的总字符数，不是整个 Session.history 的长度。
    const currentLength = this._estimateLength(msgs);
    if (currentLength < this.maxChars) {
      return msgs;  // 未超过 maxChars，不需要压缩，直接使用原上下文。
    }

    console.log(`[Compactor] ⚠️ 内存告警：当前上下文长度 (${currentLength} 字符) 超过阈值 (${this.maxChars})，触发压缩清理...`);

    const compacted = []; // 新数组：只改这里的消息副本，避免改坏调用方传入的原 msgs。
    const msgCount = msgs.length; // 当前本轮上下文中一共有多少条消息。

    // 最近 retainLastMsgs 条消息的起始下标；这些消息视为“近期上下文”，不做早期摘要。
    // 例如 msgCount = 20、retainLastMsgs = 6 时，protectStartIndex = 14，
    // 下标 14~19 的 6 条消息属于近期区；消息不足 6 条时用 Math.max 保证下标不会为负数。
    const protectStartIndex = Math.max(0, msgCount - this.retainLastMsgs);

    for (let i = 0; i < msgCount; i++) {
      const msg = msgs[i];

      // System Prompt 永不压缩
      if (msg.role === Role.SYSTEM) {
        compacted.push(msg);
        continue;
      }

      // 创建消息对象的浅拷贝，后续只改 newMsg.content；原 msg 及 Session.history 不受影响。
      const newMsg = { ...msg, content: msg.content };

      // 当前消息是否在数组末尾受保护的最近 N 条中：
      // i >= protectStartIndex 表示是近期消息，信息价值较高，采用较温和的头尾截断策略。
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

      compacted.push(newMsg); // 无论是否被压缩，都按原顺序放入返回上下文，保持 ToolCall/结果消息顺序。
    }

    const newLength = this._estimateLength(compacted); // 再估算一次，便于确认压缩实际节省了多少上下文。
    console.log(`[Compactor] ✅ 压缩完成。上下文长度从 ${currentLength} 降至 ${newLength} 字符。`);

    return compacted; // 返回临时压缩版本；原 msgs、Session.history 和 JSONL 存档均不变。
  }

  // 估算消息列表的字符总长度
  _estimateLength(msgs) {
    let length = 0; // 累加估算值；它是字符数近似值，不是供应商实际 Token 数。
    for (const msg of msgs) {
      // 统计每条消息的正文；空 content 按空字符串处理，防止 null/undefined 报错。
      length += (msg.content || '').length;
      for (const tc of (msg.toolCalls || [])) {
        // ToolCall 本身也会随 assistant 消息发给模型，因此工具名与参数 JSON 也必须计入上下文体积。
        length += (tc.name || '').length;
        length += JSON.stringify(tc.arguments || {}).length;
      }
    }
    return length; // 返回本轮上下文的估算总字符数，用于和 maxChars 比较。
  }
}
