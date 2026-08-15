// ===========================================
// provider/openai.js
// ===========================================
// OpenAI Provider：用 fetch 调 OpenAI 兼容 API
//
// 关键设计：双向转换
//   入参：内部 schema.Message → OpenAI 格式
//   返回：OpenAI 响应 → 内部 schema.Message
//   引擎其他部分完全不知道用的哪家模型
// ===========================================

import { BaseProvider } from './interface.js';
import { Message, ToolCall, Usage } from '../schema/message.js';

// export 表示「把这个模块里的变量公开给其他文件使用」。
//
// 每个 .js 文件都是一个独立模块：没有 export 的 const 默认只能在本文件中访问；
// 加上 export 后，其他文件可以写：
//   import { DEFAULT_OPENAI_MODEL } from './provider/openai.js';
// 来取得同一个默认模型名。花括号说明这是按名称导入，名称必须与这里导出的名称一致。
//
// const 表示变量绑定不可重新赋值；export 不会改变 const 的规则，
// 它只是在模块对外暴露这个只读的「出口」。
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

function parseToolArguments(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toOpenAIMessage(msg) {
  if (msg.role === 'system') {
    return { role: 'system', content: msg.content };
  }

  if (msg.role === 'user') {
    if (msg.toolCallId) {
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
    }
    return { role: 'user', content: msg.content };
  }

  if (msg.role === 'assistant') {
    const message = { role: 'assistant', content: msg.content };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      message.tool_calls = msg.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }));
    }
    return message;
  }

  return { role: 'user', content: msg.content };
}

export function toOpenAIMessages(messages) {
  return messages.map(toOpenAIMessage);
}

export class OpenAIProvider extends BaseProvider {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey - API key
   * @param {string} opts.model - 模型名
   * @param {string} [opts.baseUrl] - OpenAI 兼容 API 地址
   */
  constructor({ apiKey, model, baseUrl = 'https://api.openai.com/v1' }) {
    super('openai');
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  // async 将 generate 声明为「异步函数」：它调用后立即返回 Promise，
  // 而不是立刻返回最终的模型回复 Message。
  //
  // 这个标记允许函数体中使用 await。下面的 fetch、resp.text()、resp.json() 都要等待网络 / I/O，
  // await 会先暂停 generate 的后续代码，并把控制权交还 Node.js 事件循环；请求完成后再从暂停处继续。
  // 因而调用方需要写 `const message = await provider.generate(...)` 才能取得最终 Message。
  //
  // 如果去掉 async：此函数不能使用 await；即使改用 Promise.then(...)，调用结果仍会是 Promise。
  async generate(messages, availableTools) {
    // 1. 内部 messages → OpenAI messages
    const openaiMsgs = toOpenAIMessages(messages);

    // 2. 构造请求体
    const body = {
      model: this.model,
      messages: openaiMsgs,
    };
    if (availableTools && availableTools.length > 0) {
      body.tools = availableTools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    // 3. 调 API
    // fetch(...) 会立刻发起网络请求，但不会立刻得到 HTTP 响应，而是返回一个 Promise。
    // await 的意思是「等待这个 Promise 完成，并取出它成功时的结果」：
    //   - 请求尚未返回时：generate() 暂停在此处，后面的 resp.ok、resp.json() 都不会提前执行；
    //   - 请求成功得到响应时：await 表达式的值就是 Response 对象，并赋值给 resp；
    //   - 请求因网络故障失败时：await 在这一行抛出错误，调用方可用 try/catch 捕获。
    //
    // await 只能写在 async 函数（或支持顶层 await 的模块）中。它暂停的是当前 generate 的后续逻辑，
    // 不会像 fs.readSync 一样卡住 Node.js 的整个事件循环；等待网络期间，其他异步 I/O 仍可以被处理。
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API 请求失败 (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    if (!data.choices || data.choices.length === 0) {
      throw new Error('API 返回了空的 choices');
    }

    // 4. OpenAI 响应 → 内部 Message
    const choice = data.choices[0].message;
    const result = new Message({
      role: 'assistant',
      content: choice.content || '',
      toolCalls: (choice.tool_calls || [])
        .filter(tc => tc.type === 'function')
        .map(tc => new ToolCall({
          id: tc.id,
          name: tc.function.name,
          arguments: parseToolArguments(tc.function.arguments),
        })),
    });

    // 5. 提取 Token 消耗
    if (data.usage && (data.usage.prompt_tokens > 0 || data.usage.completion_tokens > 0)) {
      result.usage = new Usage(data.usage.prompt_tokens, data.usage.completion_tokens);
    }

    return result;
  }

  // 内部 Message → OpenAI message
  _toOpenAIMessage(msg) {
    return toOpenAIMessage(msg);
  }
}

// 工厂：从环境变量构造
export function createOpenAIProviderFromEnv() {
  // process.env 是 Node.js 提供的「进程环境变量」对象；它的值通常都是字符串。
  // 这里按名字读取 OPENAI_API_KEY，而不是把密钥硬编码到源码中，避免 API Key 被提交到 Git 或泄露。
  //
  // 本项目启动时会读取项目根目录的 `.env` 文件，并把其中尚未设置的键写入 process.env。
  // 因此通常在项目根目录新建或编辑 `.env`，填入（不要加到 Git）：
  //   OPENAI_API_KEY=sk-你的真实密钥
  // 也可以不建 .env，改为在启动命令前临时传入：
  //   OPENAI_API_KEY='sk-你的真实密钥' node src/index.js --provider openai --prompt '你好'
  //
  // 注意：这里只是「取出」已经配置好的 Key；实际请求时会将它放入 HTTP Authorization: Bearer 请求头。
  const apiKey = process.env.OPENAI_API_KEY;

  // Key 没有配置时立即报错，避免后面携带空凭证发起一个必定失败的 API 请求。
  if (!apiKey) throw new Error('请设置 OPENAI_API_KEY');
  return new OpenAIProvider({
    apiKey,
    model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  });
}
