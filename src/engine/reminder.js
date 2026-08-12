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
//   1. 每次工具失败，把 (toolName + arguments) 做 MD5 指纹
//   2. 在 consecutiveFailures 里计数
//   3. 成功一次就清零所有计数（说明 Agent 走出来了）
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
   * 检查上一次工具调用，必要时注入一条提醒消息
   * @param {ToolCall} lastToolCall
   * @param {ToolResult} lastResult
   * @returns {Message|null}  返回 null 表示不需要注入
   */
  checkAndInject(lastToolCall, lastResult) {
    if (!lastToolCall) return null;

    const fingerprint = generateFingerprint(
      lastToolCall.name,
      lastToolCall.arguments
    );

    // 成功一次就清零——Agent 已经走出来了
    if (!lastResult.isError) {
      this.consecutiveFailures.clear();
      return null;
    }

    const failCount = (this.consecutiveFailures.get(fingerprint) || 0) + 1;
    this.consecutiveFailures.set(fingerprint, failCount);

    console.log(
      `[Reminder] 监控到工具 ${lastToolCall.name} 失败，该参数特征连续失败次数: ${failCount}`
    );

    if (failCount >= 3) {
      console.log('[Reminder] ⚠️ 触发死循环干预！注入强力修正指令。');
      return new Message({
        role: Role.USER,
        content: `[SYSTEM REMINDER 警告]
你似乎陷入了死循环。你刚刚连续 ${failCount} 次使用相同的参数调用了 '${lastToolCall.name}' 工具，并且都失败了。
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

function generateFingerprint(toolName, args) {
  const hasher = crypto.createHash('md5');
  hasher.update(String(toolName));
  hasher.update(typeof args === 'string' ? args : JSON.stringify(args));
  return hasher.digest('hex');
}
