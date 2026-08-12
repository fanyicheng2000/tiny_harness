// ===========================================
// provider/mock.js
// ===========================================
// Mock Provider：离线演示用，不调真 LLM
//
// 为什么需要它？
//   1. 300 人分享现场不一定有 API key
//   2. 真调 LLM 每次要等几秒，演示节奏不好控
//   3. Mock 可以预设脚本，精确演示每个机制（死循环、审批等）
//
// 工作原理：
//   用一个预设的"剧本"（script）决定每轮返回什么
//   剧本是一组 Message 数组，按顺序消费
//   剧本吃完了就返回空 toolCalls（表示任务完成）
// ===========================================

import { BaseProvider } from './interface.js';
import { Message, ToolCall } from '../schema/message.js';

export class MockProvider extends BaseProvider {
  /**
   * @param {Message[]} script - 预设的响应剧本
   *   每个元素是一个 { content, toolCalls } 对象
   *   按顺序被 generate 消费
   */
  constructor(script = []) {
    super('mock');
    this.script = script;
    this.cursor = 0;
  }

  async generate(messages, availableTools) {
    // 模拟网络延迟，让演示更有节奏感
    await new Promise(r => setTimeout(r, 200));

    if (this.cursor >= this.script.length) {
      // 剧本吃完了，返回空响应（表示任务完成）
      return new Message({
        role: 'assistant',
        content: '任务已完成。',
        toolCalls: [],
      });
    }

    const item = this.script[this.cursor++];
    return new Message({
      role: 'assistant',
      content: item.content || '',
      toolCalls: (item.toolCalls || []).map(tc => new ToolCall(tc)),
    });
  }

  // 重置游标，允许重跑
  reset() {
    this.cursor = 0;
  }
}

// ===========================================
// 12 个剧本：对应 TUTORIAL.md 12 节，每节一个演示
// ===========================================

// 剧本 1：ReAct 主循环（节 1）
// 看点：单轮思考 → 工具 → 结果 → 结束
export function scriptReact(path = 'README.md') {
  return [
    {
      content: `好的，我来读取 ${path} 的内容。`,
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path } }],
    },
    {
      content: `已经读取完毕。${path} 的内容已经显示在上面。`,
      toolCalls: [],
    },
  ];
}

// 剧本 2：Provider 抽象（节 2）
// 看点：同一个引擎，不同 provider 返回不同风格，引擎无感知
// 这里用一个简单的"换皮"演示：第一轮返回 OpenAI 风格回复，第二轮返回 Claude 风格回复
export function scriptProviderSwitch() {
  return [
    {
      content: '[模拟 OpenAI Provider 返回] 好的，我读一下文件。',
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'package.json' } }],
    },
    {
      content: '[模拟 Claude Provider 返回] 文件已读取。引擎只认内部 Message 格式，provider 自己做双向翻译，引擎代码零修改。',
      toolCalls: [],
    },
  ];
}

// 剧本 3：第一个工具 read_file（节 3）
// 看点：工具注册 → 调用 → 返回结构化结果
export function scriptFirstTool() {
  return [
    {
      content: '我来看看工作区有哪些文件。',
      toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'ls -la' } }],
    },
    {
      content: '读一下 package.json。',
      toolCalls: [{ id: 'call_2', name: 'read_file', arguments: { path: 'package.json' } }],
    },
    {
      content: 'package.json 已读取，这是项目的元数据文件。',
      toolCalls: [],
    },
  ];
}

// 剧本 4：工具四件套 + fuzzyReplace（节 4）
// 看点：精确匹配失败 → 降级匹配成功
export function scriptEditFuzzy() {
  return [
    {
      content: '我先写一个文件，然后用模糊匹配改它。',
      toolCalls: [{ id: 'call_1', name: 'write_file', arguments: { path: 'demo.txt', content: 'Hello World\nThis is a test file.\n  Line with leading spaces.' } }],
    },
    {
      // 故意用"不精确"的 old_text（3 个前导空格，文件里是 2 个），精确匹配 L1 失败 → L3 trim 兜底成功
      content: '现在编辑它——故意把 old_text 的缩进写错（3 空格 vs 文件里的 2 空格），精确匹配会失败，看 fuzzyReplace 降级。',
      toolCalls: [{
        id: 'call_2',
        name: 'edit_file',
        arguments: {
          path: 'demo.txt',
          old_text: '   Line with leading spaces.',
          new_text: 'Line with leading spaces. (edited via fuzzy match)',
        },
      }],
    },
    {
      content: '编辑完成，验证一下。',
      toolCalls: [{ id: 'call_3', name: 'read_file', arguments: { path: 'demo.txt' } }],
    },
    {
      content: 'fuzzyReplace 四级渐进匹配：L1 精确匹配失败（3 空格 ≠ 2 空格）→ L3 trim 两端空白后匹配成功。这就是缩进不一致时的兜底。',
      toolCalls: [],
    },
  ];
}

// 剧本 5：并发 + REPL 串行（节 5）
// 看点：同轮并发两个工具，下一轮等结果都回来再继续
export function scriptWriteAndRead() {
  return [
    {
      content: '我同时写一个新文件并读取一个已有文件（演示 Promise.all 并发）。',
      toolCalls: [
        { id: 'call_1', name: 'write_file', arguments: { path: 'hello.txt', content: 'Hello World' } },
        { id: 'call_2', name: 'read_file', arguments: { path: 'package.json' } },
      ],
    },
    {
      content: '两个操作都完成了——这一轮才返回，因为引擎用 Promise.all 等齐了。',
      toolCalls: [],
    },
  ];
}

// 剧本 6：Session + JSONL 持久化（节 6）
// 看点：演示跨进程断点续传——先跑一段，"中断"，重启用 --session 恢复
// mock 里只演示"全量历史 + Working Memory 取最近 N 条"的概念
export function scriptSessionResume() {
  return [
    {
      content: '我是新会话的第一轮。Session 会把每条消息追加到 .tiny-harness/sessions/<id>.jsonl 文件里。',
      toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'ls -la .tiny-harness/sessions/ 2>/dev/null || echo "no sessions dir yet"' } }],
    },
    {
      content: '第二轮——JSONL 是追加写，每次只 append 一行，不重写整个文件。看下当前 session 文件内容：',
      toolCalls: [{ id: 'call_2', name: 'bash', arguments: { command: 'cat .tiny-harness/sessions/*.jsonl 2>/dev/null | head -20' } }],
    },
    {
      content: '第三轮——可以看 meta 行 + message 行。Working Memory 只取最近 N 条喂给模型，全量历史留在磁盘上。',
      toolCalls: [],
    },
  ];
}

// 剧本 7：死循环检测（节 7）
// 看点：连续 3 次同样的失败调用，触发 Reminder 强力干预
export function scriptLoop() {
  const failCall = { id: 'call_x', name: 'read_file', arguments: { path: '不存在.txt' } };
  return [
    { content: '我来读这个文件。', toolCalls: [failCall] },
    { content: '报错了，我重试。', toolCalls: [failCall] },
    { content: '还是报错，再试一次。', toolCalls: [failCall] },
    { content: '看来这个文件确实不存在，我放弃了。', toolCalls: [] },
  ];
}

// 剧本 8：人类审批（节 8）
// 看点：bash rm -rf 被中间件拦截，转成 isError=true 让模型自己改方向
export function scriptApproval() {
  return [
    {
      content: '我来清理一下临时文件。',
      toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'rm -rf /tmp/old_logs' } }],
    },
    {
      content: '操作被审批拦截了（rm -rf 是危险操作）。我换个安全的方式：用 find 替代。',
      toolCalls: [{ id: 'call_2', name: 'bash', arguments: { command: 'find /tmp/old_logs -type f -delete 2>/dev/null || true' } }],
    },
    {
      content: '安全清理完成。',
      toolCalls: [],
    },
  ];
}

// 剧本 9：System Prompt 三层注入（节 9）
// 看点：先 ls 看下有没有 AGENTS.md / SKILL.md，演示三层注入
export function scriptSystemPrompt() {
  return [
    {
      content: '我先看下工作区有没有 AGENTS.md 和技能文件——这两层会被注入到 System Prompt。',
      toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'echo "=== AGENTS.md（第二层）===" && head -5 AGENTS.md 2>&1 && echo "" && echo "=== .tiny-harness/skills/（第三层技能）===" && ls -la .tiny-harness/skills/ 2>&1' } }],
    },
    {
      content: 'System Prompt 三层结构：①硬编码核心身份（你是 tiny-harness）②AGENTS.md（项目级规则）③SKILL.md（按需加载的技能）。来看下我的身份是什么：',
      toolCalls: [{ id: 'call_2', name: 'bash', arguments: { command: 'echo "（演示）我会以 tiny-harness 身份 + AGENTS.md 内容 + SKILL.md 内容拼成完整 System Prompt"' } }],
    },
    {
      content: '三层注入完成。模型现在知道"我是谁、项目规则是什么、有哪些技能可用"。',
      toolCalls: [],
    },
  ];
}

// 剧本 10：上下文压缩（节 10）
// 看点：模拟历史很长，触发三档压缩（System 不动 / 早期摘要 / 头尾截断）
export function scriptCompactor() {
  return [
    {
      content: '模拟一个长会话——我现在假装历史已经累积了 20+ 条消息，逼近 token 上限。',
      toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'echo "（模拟）当前历史 23 条 / 8000 tokens，触发压缩阈值"' } }],
    },
    {
      content: '压缩策略三档：①System Prompt 永不压缩 ②早期对话摘要成一段 ③保留头尾，中间截断。压缩后历史变 8 条 / 3000 tokens。',
      toolCalls: [{ id: 'call_2', name: 'bash', arguments: { command: 'echo "（模拟）压缩后历史 8 条 / 3000 tokens"' } }],
    },
    {
      content: '压缩完成。注意：压缩是"无损语义、有损精度"——摘要可能丢细节，但保住了关键决策和最新指令。',
      toolCalls: [],
    },
  ];
}

// 剧本 11：Plan Mode（节 11）
// 看点：PLAN.md + TODO.md 全流程 + 实时打勾
export function scriptPlanMode() {
  return [
    {
      content: '先检查工作区有没有 PLAN.md。',
      toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'ls -la' } }],
    },
    {
      content: '没有 PLAN.md，我来创建计划和任务清单。',
      toolCalls: [
        { id: 'call_2', name: 'write_file', arguments: { path: 'PLAN.md', content: '# 计划\n实现一个 hello world' } },
        { id: 'call_3', name: 'write_file', arguments: { path: 'TODO.md', content: '- [ ] 写代码\n- [ ] 测试' } },
      ],
    },
    {
      content: '开始写代码。',
      toolCalls: [{ id: 'call_4', name: 'write_file', arguments: { path: 'hello.js', content: "console.log('hello')" } }],
    },
    {
      content: '代码写完，打勾。',
      toolCalls: [{ id: 'call_5', name: 'edit_file', arguments: { path: 'TODO.md', old_text: '- [ ] 写代码', new_text: '- [x] 写代码' } }],
    },
    {
      content: '测试一下。',
      toolCalls: [{ id: 'call_6', name: 'bash', arguments: { command: 'node hello.js' } }],
    },
    {
      content: '测试通过，再打勾。',
      toolCalls: [{ id: 'call_7', name: 'edit_file', arguments: { path: 'TODO.md', old_text: '- [ ] 测试', new_text: '- [x] 测试' } }],
    },
    {
      content: '全部完成！',
      toolCalls: [],
    },
  ];
}

// 剧本 12：可观测性 Span 树（节 12）
// 看点：嵌套 Span 调用，演示 AsyncLocalStorage 上下文传播
export function scriptObservabilitySpan() {
  return [
    {
      content: '演示 Span 树：我现在开始一个根 Span "agent.run"，里面会嵌套 "engine.think" 和 "tool.execute" 子 Span。',
      toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'echo "（模拟 Span 树）root: agent.run → child: engine.think → child: tool.execute(bash)"' } }],
    },
    {
      content: 'Span 树通过 AsyncLocalStorage 自动传父 Span ID，业务代码不用手动传参。trace 文件要等整次 run 结束才导出，运行中先看实时写入的 session JSONL：',
      toolCalls: [{ id: 'call_2', name: 'bash', arguments: { command: 'echo "=== session JSONL（运行中实时写入）===" && cat .tiny-harness/sessions/*.jsonl 2>/dev/null | head -20' } }],
    },
    {
      content: 'CostTracker 装饰器：每次 LLM 调用自动累计 token 数和花费估算，引擎零侵入。完整 Span 树（含 model / promptTokens / completionTokens / estimatedCost 属性）在 run 结束后导出到 .tiny-harness/traces/，并通过 done 事件后的 trace SSE 下发给前端右侧面板。',
      toolCalls: [],
    },
  ];
}

// 剧本别名表：让 server.js 可以用一个映射统一处理
export const MOCK_SCRIPTS = {
  'react':              { fn: scriptReact,           section: 1,  title: 'ReAct 主循环',          hint: '看轮次切换：思考→工具→结果→结束' },
  'provider-switch':    { fn: scriptProviderSwitch,  section: 2,  title: 'Provider 抽象',        hint: '同一个引擎，不同 provider 风格不同，引擎无感知' },
  'first-tool':         { fn: scriptFirstTool,       section: 3,  title: '第一个工具 read_file',  hint: '工具注册 → 调用 → 结构化返回' },
  'edit-fuzzy':         { fn: scriptEditFuzzy,       section: 4,  title: '工具四件套 + fuzzyReplace', hint: '故意写不精确的 old_text，看模糊匹配兜底' },
  'write-and-read':     { fn: scriptWriteAndRead,    section: 5,  title: '并发执行 + 跨轮串行',   hint: '同轮 Promise.all 并发，下一轮等齐再走' },
  'session-resume':     { fn: scriptSessionResume,   section: 6,  title: 'Session + JSONL 持久化', hint: '看 session 文件每轮 append 增量' },
  'loop':               { fn: scriptLoop,            section: 7,  title: '死循环检测',            hint: '连续 3 次同样失败触发 Reminder 干预' },
  'approval':           { fn: scriptApproval,        section: 8,  title: '人类审批',              hint: 'rm -rf 被中间件拦截，转 isError=true 让模型改' },
  'system-prompt':      { fn: scriptSystemPrompt,    section: 9,  title: 'System Prompt 三层注入', hint: '看身份 + AGENTS.md + SKILL.md 怎么拼' },
  'compactor':          { fn: scriptCompactor,       section: 10, title: '上下文压缩',           hint: '三档策略：System 不动 / 早期摘要 / 头尾截断' },
  'plan-mode':          { fn: scriptPlanMode,        section: 11, title: 'Plan Mode',            hint: 'PLAN.md + TODO.md 全流程 + 实时打勾' },
  'observability-span': { fn: scriptObservabilitySpan, section: 12, title: '可观测性 Span 树',  hint: '嵌套 Span + AsyncLocalStorage 自动传父' },
};
