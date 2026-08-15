// ===========================================
// engine/reminder.js
// ===========================================
// 死循环检测 + 强力干预注入
//
// 痛点：
//   Agent 经常会陷入 "用相同参数调同一个工具失败 → 重复调用 → 又失败"
//   的死循环，烧钱且无意义。
//
// 解决方案：
//   1. 每次工具失败，先稳定序列化 arguments，再把 (toolName + arguments) 做 MD5 指纹
//   2. 在 consecutiveFailures 里计数
//   3. 某个指纹成功一次，只清除该指纹自己的失败计数（其他工具的失败历史不能被误清）
//   4. 同一指纹连续失败 ≥3 次，往会话里注入一条 SYSTEM REMINDER
//      强力叫醒模型
//
// 为什么用 MD5：
//   - 工具参数可能是大对象（比如 write_file 的内容）
//   - 直接当 Map key 会爆内存
//   - MD5 把它压成 32 个十六进制字符（仅作重复指纹，不用于安全用途）
// ===========================================

import crypto from 'node:crypto';
import { Message, Role } from '../schema/message.js';

export class ReminderInjector {
  constructor() {
    // fingerprint → 连续失败次数
    this.consecutiveFailures = new Map();
  }

  /**
   * 检查一个工具调用，必要时生成一条提醒消息。
   *
   * AgentEngine 会对同一轮的每个 ToolCall 分别调用本方法；因此状态必须按
   * 「工具名 + 参数」的指纹独立维护，不能因为本轮另一个工具成功就抹掉当前工具的失败历史。
   * @param {ToolCall} toolCall
   * @param {ToolResult} result
   * @returns {Message|null} 返回 null 表示本调用不需要注入提醒
   */
  checkAndInject(toolCall, result) {
    if (!toolCall || !result) return null;

    const fingerprint = generateFingerprint(toolCall.name, toolCall.arguments);

    // 同一个工具、同一组参数成功，说明它已走出自己的失败循环；只删除该指纹的计数。
    // 不能 clear() 整张 Map：本轮或前几轮的其他工具可能仍在重复失败。
    if (!result.isError) {
      this.consecutiveFailures.delete(fingerprint);
      return null;
    }

    const failCount = (this.consecutiveFailures.get(fingerprint) || 0) + 1;
    this.consecutiveFailures.set(fingerprint, failCount);

    console.log(
      `[Reminder] 监控到工具 ${toolCall.name} 失败，该参数特征连续失败次数: ${failCount}`
    );

    if (failCount >= 3) {
      console.log('[Reminder] ⚠️ 触发死循环干预！注入强力修正指令。');
      return new Message({
        role: Role.USER,
        content: `[SYSTEM REMINDER 警告]
你似乎陷入了死循环。你刚刚连续 ${failCount} 次使用相同的参数调用了 '${toolCall.name}' 工具，并且都失败了。
请立即停止这种无效的重试！你的注意力被当前的报错过度吸引了。
你需要：
1. 停止猜测参数。跳出当前的局部思维。
2. 彻底改变你的策略。
3. 如果你确实无法通过系统工具解决当前问题，请直接结束任务并向用户说明你需要什么人工帮助，而不是继续盲目消耗 API 资源尝试。`,
      });
    }

    return null;
  }
}

// 将「工具名 + 参数」压缩成固定长度的字符串指纹，作为 consecutiveFailures Map 的 key。
// 例如 read_file({ path: 'a.js' }) 每次都会得到同一指纹，因而能跨轮累计其失败次数；
// read_file({ path: 'b.js' }) 或 bash({ command: '...' }) 则得到不同指纹，分别统计。
//
// MD5 在这里不用于加密、签名或安全校验，只用于给可能很长的参数对象生成短 key；
// 所以不需要把参数原文（例如 write_file 的大段 content）直接存进 Map。
function generateFingerprint(toolName, args) {
  // createHash('md5') 创建一个可持续追加输入的哈希计算器；此时尚未得到最终摘要。
  const hasher = crypto.createHash('md5');

  // 先写入工具名，避免不同工具碰巧拥有相同参数时被当成同一次调用。
  hasher.update(String(toolName));

  // Hash.update 只能接收字符串 / Buffer。stableStringify 会递归排序对象的 key，
  // 使 { path: 'a.js', offset: 1 } 和 { offset: 1, path: 'a.js' } 生成同一段文本、同一指纹。
  // 数组元素顺序保持原样，因为 ['a', 'b'] 与 ['b', 'a'] 可能表达不同业务含义。
  hasher.update(stableStringify(args));

  // digest('hex') 结束计算并返回 32 个十六进制字符的 MD5 结果；digest 调用后该 hasher 不能继续 update。
  return hasher.digest('hex');
}

// 将任意 JSON 风格参数转为确定性的文本：对象的 key 按字母排序，数组顺序保持不变。
// 这不是通用 JSON 序列化库，只覆盖工具调用参数常见的 null、原始值、数组和普通对象。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify(undefined) 返回 undefined；Hash.update 不能接收它，因此显式编码为字符串。
    return value === undefined ? 'undefined' : JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}
