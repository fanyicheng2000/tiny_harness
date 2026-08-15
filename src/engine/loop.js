// ===========================================
// engine/loop.js
// ===========================================
// 引擎核心：ReAct 主循环
//
// 整个项目的"心脏"。所有模块都为它服务。
//
// 主循环骨架：
//   while (true) {
//     1. 取 Working Memory + 拼 System Prompt → 喂给模型
//     2. Phase 1: Thinking（可选）—— 不传 tools，让模型先思考
//     3. Phase 2: Action —— 传 tools，让模型决定调哪个工具
//     4. 并发执行所有 ToolCalls
//     5. 把工具结果塞回会话
//     6. Reminder 检查（防死循环）
//     7. 如果模型没再调工具 → 退出循环（任务完成）
//   }
//
// 为什么 ReAct：
//   "Reasoning + Acting" 来自 Yao et al. 2022 论文。
//   传统 Agent 要么纯推理（chain-of-thought）要么纯行动（function-calling）。
//   ReAct 把两者交错：每一步先想，再动。失败时有反思能力。
// ===========================================

import { Message, Role, ToolResult } from '../schema/message.js';
import { Compactor } from '../context/compactor.js';
import { RecoveryManager } from '../context/recovery.js';
import { PromptComposer } from '../context/composer.js';
import { ReminderInjector } from './reminder.js';
import { startSpan, exportTraceToFile } from '../observability/trace.js';

export class AgentEngine {
  /**
   * @param {BaseProvider} provider
   * @param {Registry} registry
   * @param {boolean} enableThinking  是否开启慢思考两阶段
   * @param {boolean} planMode        是否开启 Plan Mode（持久化 + 断点续传）
   */
  constructor(provider, registry, enableThinking = false, planMode = false) {
    this.provider = provider;
    this.registry = registry;
    this.enableThinking = enableThinking;
    this.planMode = planMode;
    this.compactor = new Compactor(200000, 6);
    this.recovery = new RecoveryManager();
    this.injector = new ReminderInjector();
  }

  /**
   * 主循环
   * @param {Session} session
   * @param {Reporter} reporter
   */
  async run(session, reporter) {
    console.log(
      `[Engine] 唤醒会话 [${session.id}]，锁定工作区: ${session.workDir} (PlanMode: ${this.planMode})`
    );

    // 用 startSpan 包裹整个 Run，结束时自动导出 trace
    await startSpan('Agent.Run', async (rootSpan) => {
      // attribute（属性）是附加在 Span 上的一组「键 → 值」元数据，不参与 Agent 的推理或控制流，
      // 只会随 trace 一起导出，便于事后检索、筛选和排障。这里的 rootSpan 本身来自 startSpan()：
      // startSpan 在 src/observability/trace.js 中执行 `new Span('Agent.Run')` 后，将该对象作为回调参数传入。
      //
      // addAttribute() 是本项目 Span 类自己定义的方法，不是 JavaScript / Node.js 内置 API；它的实现是：
      //   this.attributes[key] = value
      // 因而下面两次调用会在 trace JSON 中形成：
      //   { "attributes": { "sessionId": "...", "workDir": "/..." } }
      // 用 sessionId 可关联一次运行与 Session 文件；用 workDir 可定位这次 Agent 实际操作的工作区。
      rootSpan.addAttribute('sessionId', session.id);
      rootSpan.addAttribute('workDir', session.workDir);

      const composer = new PromptComposer(session.workDir, this.planMode);
      const systemMsg = composer.build();

      let turnCount = 0;

      // 主循环
      while (true) {
        turnCount++;
        const shouldStop = await this._runOneTurn(session, reporter, systemMsg, turnCount);
        if (shouldStop) break;
      }

      // 导出整次运行的 trace 到 .tiny-harness/traces/
      const tracePath = await exportTraceToFile(rootSpan, session.workDir, session.id);
      console.log(`📊 [Tracing] 链路回放已保存: ${tracePath}`);
    });
  }

  /**
   * 跑一个 Turn（思考 + 行动 + 工具执行）
   * @returns {boolean} true 表示主循环应该退出
   */
  async _runOneTurn(session, reporter, systemMsg, turnCount) {
    return startSpan(`Turn-${turnCount}`, async (turnSpan) => {
      const availableTools = this.registry.getAvailableTools();
      let workingMemory = session.getWorkingMemory(20);

      // 跨供应商兼容性防御：让截断后的上下文从明确的 user 消息开始
      if (workingMemory.length > 0 && workingMemory[0].role !== Role.USER) {
        const dummyUser = new Message({
          role: Role.USER,
          content:
            '[系统占位符] 这是为了保持上下文连贯性而注入的断点标记。请继续执行你刚才的任务。',
        });
        workingMemory = [dummyUser, ...workingMemory];
      }

      let contextHistory = [systemMsg, ...workingMemory];
      contextHistory = this.compactor.compact(contextHistory);
      turnSpan.addAttribute('contextMessageCount', contextHistory.length);

      let currentTurnThinkingContent = '';

      // ========== Phase 1: Thinking ==========
      // 不传 tools，让模型先纯粹推理，不被工具诱惑
      // 这是本项目自定义的两阶段工作流，不等同于供应商的 Extended Thinking API。
      if (this.enableThinking) {
        if (reporter) reporter.onThinking();

        const thinkResp = await startSpan('LLM.Thinking', async (thinkSpan) => {
          const resp = await this.provider.generate(contextHistory, null);
          thinkSpan.addAttribute('contentLength', (resp.content || '').length);
          return resp;
        });

        if (thinkResp.content) {
          currentTurnThinkingContent = thinkResp.content;
          contextHistory.push(thinkResp);
        }
      }

      // ========== Phase 2: Action ==========
      // 传 tools，让模型决定要不要调工具、调哪个
      const actionResp = await startSpan('LLM.Action', async (actSpan) => {
        const resp = await this.provider.generate(contextHistory, availableTools);
        actSpan.addAttribute('toolCallCount', (resp.toolCalls || []).length);
        return resp;
      });

      // 拼装最终的 Assistant 消息（思考 + 行动）
      const finalAssistantMsg = new Message({
        role: Role.ASSISTANT,
        content: (currentTurnThinkingContent + '\n' + (actionResp.content || '')).trim(),
        toolCalls: actionResp.toolCalls || [],
      });
      session.append(finalAssistantMsg);

      if (actionResp.content && reporter) {
        reporter.onMessage(actionResp.content);
      }

      // 退出条件：模型没再调工具，说明任务结束
      if (!actionResp.toolCalls || actionResp.toolCalls.length === 0) {
        return true;  // 让外层 while 退出
      }

      // ========== 并发执行所有 ToolCalls ==========
      const toolCalls = actionResp.toolCalls;

      // 我们需要保留 isError 状态给 Reminder 用
      const observationEntries = await Promise.all(
        toolCalls.map(async (call) => {
          if (reporter) {
            reporter.onToolCall(call.name, JSON.stringify(call.arguments), call.id);
          }

          // 工具执行也在 Turn 的 Span 上下文里，所以工具内部可以 addAttribute
          const result = await startSpan(`Tool.${call.name}`, async (toolSpan) => {
            toolSpan.addAttribute(
              'args',
              JSON.stringify(call.arguments).slice(0, 200)
            );
            return await this.registry.execute(call);
          });

          let finalOutput = result.output;
          if (result.isError) {
            finalOutput = this.recovery.analyzeAndInject(call.name, result.output);
          }

          if (reporter) {
            let display = finalOutput;
            if (display.length > 200) display = display.slice(0, 200) + '... (已截断)';
            reporter.onToolResult(call.name, display, result.isError, call.id);
          }

          // 同时返回 message 和 result，message 给会话，result 给 Reminder
          return {
            message: new Message({
              role: Role.USER,
              content: finalOutput,
              toolCallId: call.id,
              isError: result.isError,
            }),
            result,
            call,
          };
        })
      );

      // 把工具结果消息塞回会话
      session.append(...observationEntries.map((e) => e.message));

      // ========== Reminder：死循环检测 ==========
      // 一轮可以并发执行多个工具；每个 (工具名 + 参数) 都可能独立陷入重复失败，
      // 因而不能只检查 observationEntries[0]。依次检测全部结果，并让 ReminderInjector
      // 按指纹独立累计 / 清除计数：A 工具成功不会掩盖 B 工具的连续失败。
      // 一轮有多个调用同时达到阈值时会追加多条提醒，它们分别对应不同的失败证据。
      // map 会保持数组长度：对每个工具结果调用 checkAndInject。
      // 该方法在“未达到连续失败阈值”时返回 null，达到阈值时才返回一条 Message，
      // 所以 map 后的中间数组可能是 [null, Message, null, Message]。
      //
      // filter(Boolean) 会把每个元素传给 Boolean(...) 转成 true / false，并只保留 true 的元素。
      // 对象（这里的 Message）转换后为 true，null 为 false；因此过滤后只剩真正需要注入会话的提醒：
      // [null, Message_A, null, Message_B] → [Message_A, Message_B]。
      // 不过滤就把 null 传入 session.append(...messages)，会把无效元素混进会话历史。
      const reminderMessages = observationEntries
        .map(({ call, result }) => this.injector.checkAndInject(call, result))
        .filter(Boolean);
      if (reminderMessages.length > 0) {
        session.append(...reminderMessages);
      }

      return false;  // 继续下一轮
    });
  }

  // ===========================================
  // RunSub: 子智能体（Subagent）
  // ===========================================
  // 用途：主 Agent 觉得"信息不够，需要先派个侦察兵去翻代码"
  //       就拉起一个子 Agent，给它只读工具，让它探路
  //
  // 特点：
  //   1. 不依赖外部 Session，跑完即销毁
  //   2. 只给只读工具（read_file / bash 的 grep/find 等）
  //   3. 最多 10 个 Turn，防止子智能体卡死
  //   4. 强制 System Prompt 警告它必须用工具，不许偷懒
  // ===========================================
  async runSub(taskPrompt, readOnlyRegistry, reporter) {
    let contextHistory = [
      new Message({
        role: Role.SYSTEM,
        content: `你是一个专门负责深度探索的探路者 (Explorer Subagent)。
你的任务是根据主架构师的指令，在当前工作区内仔细阅读代码、查阅日志，搜集足够的信息。

【核心纪律】
1. 你必须、且只能依靠内置工具（如 bash 的 find/grep，或 read_file）去寻找答案。绝对不允许凭空捏造或猜测！
2. 如果你没有找到确切的答案，你必须继续使用工具深入搜索。
3. 当且仅当你找到了确切的线索后，停止调用工具，直接输出一段纯文本作为你的终极汇报。主架构师会根据你的汇报来做下一步决策。`,
      }),
      new Message({ role: Role.USER, content: taskPrompt }),
    ];

    const MAX_SUB_TURNS = 10;
    let turnCount = 0;

    while (true) {
      turnCount++;
      if (turnCount > MAX_SUB_TURNS) {
        throw new Error(
          `子智能体探索过于深入，超过 ${MAX_SUB_TURNS} 轮被强制召回，请主 Agent 给它更明确的指令`
        );
      }

      const availableTools = readOnlyRegistry.getAvailableTools();
      const compactedContext = this.compactor.compact(contextHistory);

      // 子任务要求急速响应，强制关闭慢思考
      const actionResp = await this.provider.generate(compactedContext, availableTools);
      contextHistory.push(actionResp);

      // 退出：子智能体不调工具 = 它做好了总结汇报
      if (!actionResp.toolCalls || actionResp.toolCalls.length === 0) {
        return actionResp.content;
      }

      // 并发执行只读工具
      const observationMsgs = await Promise.all(
        actionResp.toolCalls.map(async (call) => {
          if (reporter) {
            reporter.onSubAgentToolCall(call.name, JSON.stringify(call.arguments));
          }

          const result = await readOnlyRegistry.execute(call);
          let finalOutput = result.output;
          if (result.isError) {
            finalOutput = this.recovery.analyzeAndInject(call.name, result.output);
          }

          if (reporter) {
            let display = finalOutput;
            if (display.length > 200) display = display.slice(0, 200) + '... (已截断)';
            reporter.onSubAgentToolResult(call.name, display, result.isError);
          }

          return new Message({
            role: Role.USER,
            content: finalOutput,
            toolCallId: call.id,
          });
        })
      );

      contextHistory.push(...observationMsgs);
    }
  }
}
