// ===========================================
// observability/tracker.js
// ===========================================
// 成本追踪器：装饰器模式包装 LLMProvider
//
// 职责：
//   1. 拦截每次 LLM 调用，记录耗时 / Token 数 / 花费
//   2. 把花费累加到 Session（让用户随时知道这次任务花了多少钱）
//
// 设计模式：装饰器（Decorator）
//   BaseProvider ← OpenAIProvider       （真实实现）
//                ← CostTracker(Provider) （包一层，加上追踪能力）
//   loop.js 只看到 BaseProvider 接口，完全无感知。
//
// 为什么这么设计：
//   - 引擎代码零侵入，加不加追踪行为一致
//   - 想加更多能力（重试、缓存、限流）时，照葫芦画瓢再包一层即可
// ===========================================

import { BaseProvider } from '../provider/interface.js';
import { getCurrentSpan } from './trace.js';

// 每 1M tokens 的公开标价快照。这里只做本地估算，不代替厂商账单。
// 价格按模型名计算，与 Provider 协议类型无关；未列出的模型明确显示“未配置”。
export const PRICE_SNAPSHOTS = {
  // OpenAI 当前旗舰系列
  'gpt-5.6-sol': {
    inputPrice: 1.25,
    outputPrice: 10.00,
    currency: 'USD',
    verifiedAt: '2026-07-20',
  },
  'gpt-5.6-terra': {
    inputPrice: 0.50,
    outputPrice: 4.00,
    currency: 'USD',
    verifiedAt: '2026-07-20',
  },
  'gpt-5.6-luna': {
    inputPrice: 0.20,
    outputPrice: 1.50,
    currency: 'USD',
    verifiedAt: '2026-07-20',
  },
  'gpt-5.4-mini': {
    inputPrice: 0.75,
    outputPrice: 4.50,
    currency: 'USD',
    verifiedAt: '2026-07-20',
  },
  // Anthropic 当前旗舰系列
  'claude-fable-5': {
    inputPrice: 3.00,
    outputPrice: 15.00,
    currency: 'USD',
    verifiedAt: '2026-07-20',
  },
  'claude-opus-4-8': {
    inputPrice: 15.00,
    outputPrice: 75.00,
    currency: 'USD',
    verifiedAt: '2026-07-20',
  },
  'claude-haiku-4-5': {
    inputPrice: 1.00,
    outputPrice: 5.00,
    currency: 'USD',
    verifiedAt: '2026-07-20',
  },
  mock: {
    inputPrice: 0,
    outputPrice: 0,
    currency: 'USD',
    verifiedAt: '2026-07-20',
  },
};

export class CostTracker extends BaseProvider {
  /**
   * @param {BaseProvider} nextProvider  被包装的真实 Provider
   * @param {string} modelName           模型名（用来查单价）
   * @param {Session} session            会话对象（用于累计花费）
   */
  constructor(nextProvider, modelName, session) {
    super(nextProvider.name);
    this.nextProvider = nextProvider;
    this.modelName = modelName;
    this.session = session;
  }

  async generate(messages, availableTools) {
    const startTime = Date.now();
    const respMsg = await this.nextProvider.generate(messages, availableTools);
    const latency = Date.now() - startTime;

    if (respMsg.usage) {
      const { promptTokens, completionTokens } = respMsg.usage;
      let estimate = null;
      const price = PRICE_SNAPSHOTS[this.modelName];
      if (price) {
        const amount =
          (promptTokens * price.inputPrice + completionTokens * price.outputPrice) /
          1_000_000;
        estimate = { currency: price.currency, amount };
      }

      const estimateText = estimate
        ? `${estimate.currency} ${estimate.amount.toFixed(6)}（价格快照 ${price.verifiedAt}）`
        : '未配置';

      console.log(
        `[Tracker] 📊 API 完成 | 耗时 ${latency}ms | 输入 ${promptTokens} tk | 输出 ${completionTokens} tk | 估算费用: ${estimateText}`
      );

      if (this.session) {
        this.session.recordUsage(promptTokens, completionTokens, estimate);
        const totals = Object.entries(this.session.estimatedCosts)
          .map(([currency, amount]) => `${currency} ${amount.toFixed(6)}`)
          .join(', ') || '未配置';
        console.log(
          `[Tracker] 💰 会话 ${this.session.id} 累计估算: ${totals}`
        );
      }

      const span = getCurrentSpan();
      if (span) {
        span.addAttribute('model', this.modelName);
        span.addAttribute('promptTokens', promptTokens);
        span.addAttribute('completionTokens', completionTokens);
        if (estimate) {
          span.addAttribute('estimatedCost', estimate.amount);
          span.addAttribute('costCurrency', estimate.currency);
          span.addAttribute('priceVerifiedAt', price.verifiedAt);
        }
      }
    } else {
      console.log(`[Tracker] ⚠️ API 完成，但未返回 Usage | 耗时 ${latency}ms`);
    }

    return respMsg;
  }
}
