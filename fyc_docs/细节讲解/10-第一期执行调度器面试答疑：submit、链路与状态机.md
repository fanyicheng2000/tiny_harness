# 10｜第一期执行调度器面试答疑：`submit`、执行链路与状态机

> 本文承接《09-第一期执行调度器面试答疑：为什么排队、限流与取消》，回答更偏代码执行层的问题：`submit()` 到底什么时候返回、一个多 Agent 任务如何流经 Scheduler、`AsyncLocalStorage` 如何传递上下文、状态机由谁触发，以及 `spawn`、配额这些基础概念是什么。

---

## 1. `ExecutionScheduler.submit()` 的入参与返回值

当前 Scheduler 的核心入口可以简化理解为：

```js
const job = scheduler.submit({
  sessionId,
  agentId,
  label,
  priority,
  resources,
  run,
});
```

它的职责不是立刻执行命令，而是：**创建一个可治理的 Execution Job，登记到 Scheduler 中，并尽可能触发一次调度。**

### 1.1 入参分别是什么

| 入参 | 含义 | 第一期开关中的作用 |
|---|---|---|
| `sessionId` | 当前任务所属主会话 ID | 用于 `maxPerSession` 配额，避免一个主任务占满资源 |
| `agentId` | 当前执行者的角色 ID | 用于 `maxPerAgent` 配额，避免某种 Worker 角色独占资源 |
| `label` | 任务名称/类型 | 用于日志、Trace 与诊断，如 `bash:local` |
| `priority` | 优先级整数，越大越优先 | 第三期加入；第一期默认可理解为 `0` |
| `resources` | 声明 CPU / 内存规格 | 第三期加入；第一期只有并发槽位限制 |
| `run` | 真正执行动作的异步函数 | Scheduler 允许启动时才调用它，签名是 `run(signal)` |

最重要的是 `run`：它不是执行结果，而是一段“以后再执行”的函数。

```js
run: (signal) => backend.execute({
  command,
  workDir,
  signal,
})
```

可以把它类比为外卖订单里的“做菜指令”：下单时先创建订单，不是立刻要求厨师一定开始做；只有有空闲炉灶、订单通过准入后，调度系统才调用做菜动作。

### 1.2 `submit()` 的返回值是什么

`submit()` 返回的是一个 **Job 对象**，不是命令输出字符串：

```js
const job = scheduler.submit(...);
```

Job 包含以下核心字段：

```js
{
  id,            // 任务唯一 ID
  sessionId,     // 所属主任务 / 子任务上下文
  agentId,       // 发起任务的 Agent 角色
  status,        // PENDING / RUNNING / SUCCEEDED ...
  priority,
  resources,
  submittedAt,
  startedAt,
  finishedAt,
  queueWaitMs,
  runMs,
  controller,    // AbortController，用于取消
  promise,       // 真正执行完成后得到结果的 Promise
}
```

实际 `BashTool` 不会把整个 Job 交给模型，而是这样做：

```js
const job = scheduler.submit({ ... });
return job.promise;
```

因此从 Registry / Agent 视角看，`await bashTool.execute()` 最终仍然得到正常命令输出或错误；但 Runtime 内部多了一层可观测、可取消、可排队的 Job。

### 1.3 `submit()` 是立即返回，还是执行完再返回？

**`submit()` 立即返回 Job；`job.promise` 在任务最终完成时才 resolve/reject。**

分三种情形理解最清楚。

#### 情形 A：当前有槽位，任务可立即启动

```text
submit()
  → 创建 Job(status=PENDING)
  → 调用 _drain()
  → 检查通过，_start(job)
  → Job 很快变为 RUNNING
  → submit 立即返回 Job
  → run(signal) 异步执行
  → 命令结束后 job.promise resolve/reject
```

即使任务“立即启动”，`submit()` 也不会等待命令跑完。因为 Shell、Docker、测试等都是异步 I/O，需要几十毫秒、几秒甚至更久。

```js
const job = scheduler.submit(...); // 立刻拿到 Job
console.log(job.status);           // 通常已是 RUNNING，也可能仍是 PENDING
const output = await job.promise;  // 在真实命令结束后才得到输出
```

#### 情形 B：当前没有槽位，任务进入队列

```text
submit()
  → 创建 Job(status=PENDING)
  → _drain() 发现资源不足
  → 不调用 run(signal)
  → submit 立即返回 Job
  → job.promise 处于 pending

其他任务结束
  → _finish() 释放资源
  → _drain()
  → _start(这个 Job)
  → run(signal)
  → 最终 job.promise 完成
```

#### 情形 C：单任务规格不可能被满足

第三期中，如果一个任务声明 `cpuMillis=8000`，但总预算只有 `4000`：

```text
submit()
  → 创建 Job
  → 立即标记 RESOURCE_REJECTED
  → submit 仍立即返回 Job
  → job.promise 立即 reject
```

注意“`submit()` 立即返回”与“`job.promise` 立即 reject”是两个概念：前者是 API 调用返回 Job 的时间；后者是该 Job 的最终执行结果。

### 1.4 一个时间线例子

```text
时间 T0：调用 scheduler.submit()
时间 T0：返回 Job { status: PENDING, promise }
时间 T0：Scheduler 有资源，调用 _start()
时间 T0：status 改为 RUNNING，异步调用 run(signal)
时间 T1：真实 bash / docker 命令仍在执行
时间 T2：命令成功
时间 T2：status 改为 SUCCEEDED，job.promise resolve(output)
时间 T2：await job.promise 得到 output
```

面试表达：

> `submit` 是非阻塞提交接口，立即返回带 Promise 的 Job。Scheduler 决定何时调用 `run(signal)`；调用方通过等待 `job.promise` 获得最终结果。这样既保留了工具调用的异步语义，又能在中间插入排队、取消、超时和状态观测。

---

## 2. 用一个多 Agent 例子完整走一遍第一期链路

假设用户输入：

```text
检查项目的测试失败原因，并给出修复建议。
```

主 Agent 将任务拆为两个 Worker：

```text
主 Agent（Session: fix-test-001）
  ├── reviewer Thread: review-engine
  │     任务：检查 src/engine 的实现和潜在问题
  └── tester Thread: run-test
        任务：运行测试并定位失败原因
```

假设第一期配置：

```text
maxConcurrent = 2
maxPerSession = 2
maxPerAgent = 1
```

这里的 `maxPerAgent=1` 意味着同一种角色同一时刻最多运行一个真实执行任务。

### 2.1 第一步：主 Agent 发起委派

主 Agent 的模型返回两个 Tool Call：

```js
[
  {
    name: 'run_subagent',
    arguments: {
      agent_id: 'reviewer',
      task: '检查 src/engine 的错误处理与并发逻辑',
      thread_id: 'review-engine',
    },
  },
  {
    name: 'run_subagent',
    arguments: {
      agent_id: 'tester',
      task: '运行测试，定位失败用例与原因',
      thread_id: 'run-test',
    },
  },
]
```

主 Engine 对同一轮无依赖 Tool Call 使用 `Promise.all`：

```text
Promise.all([
  run_subagent(reviewer),
  run_subagent(tester),
])
```

这表示：两个 Worker 可以**并发开始其 Agent 循环**。

### 2.2 第二步：每个 Worker 得到独立运行时

`RunSubagentTool` 为两个子 Agent 分别构造：

```text
reviewer：独立 Prompt + Skill Catalog + Tool Registry + Thread
 tester ：独立 Prompt + Skill Catalog + Tool Registry + Thread
```

其中 Thread 独立持久化：

```text
.tiny-harness/threads/review-engine.jsonl
.tiny-harness/threads/run-test.jsonl
```

同时，`activeThreads` 确保同一个 `thread_id` 不会被第二次并发续接。

### 2.3 第三步：Worker 的模型分别调用 Bash

reviewer 需要读文件，模型可能返回：

```js
{
  name: 'bash',
  arguments: { command: 'grep -R "Promise.all" -n src/engine' },
}
```

Tester 要跑测试，模型可能返回：

```js
{
  name: 'bash',
  arguments: { command: 'npm test' },
}
```

此时两个 Worker 的 Agent Loop 都在并发运行，但它们最终到达同一个**进程级默认 Scheduler**。

### 2.4 第四步：`AsyncLocalStorage` 自动补充归属信息

进入 reviewer 子 Agent Loop 前，Engine 设置执行上下文：

```js
{
  sessionId: 'review-engine',
  agentId: 'reviewer',
}
```

tester 的上下文则是：

```js
{
  sessionId: 'run-test',
  agentId: 'tester',
}
```

因此 BashTool 不必在每一层都手动传 `threadId` / `agentId`：

```js
const context = getExecutionContext();

scheduler.submit({
  sessionId: context.sessionId,
  agentId: context.agentId,
  label: 'bash:local',
  run: (signal) => backend.execute({ command, workDir, signal }),
});
```

此时 Scheduler 看见的是两个归属明确的 Job：

```text
Job 1
  sessionId = review-engine
  agentId   = reviewer
  command   = grep -R ...

Job 2
  sessionId = run-test
  agentId   = tester
  command   = npm test
```

### 2.5 第五步：Scheduler 决定是否启动

当前配置还有两个全局槽位：

```text
maxConcurrent = 2
当前 running = 0
```

两个 Job 均通过：

```text
全局并发：0 < 2                    ✓
reviewer 角色正在运行数：0 < 1       ✓
tester 角色正在运行数：0 < 1         ✓
```

于是：

```text
Job 1：PENDING → RUNNING → spawn grep
Job 2：PENDING → RUNNING → spawn npm test
```

两个真实命令同时运行。**因此加 Scheduler 后，多个子 Agent 仍然是并发的。**

### 2.6 第六步：如果同一个 Worker 再调一个 Bash 会怎样

假设 reviewer 在 grep 后又决定同时发起两个 Bash：

```text
R1：grep -R "Promise.all" src/engine
R2：find src/engine -type f
```

如果 R1 仍在运行，且：

```text
maxPerAgent = 1
```

则：

```text
R1 → RUNNING
R2 → PENDING（reviewer 配额已满）
```

但 tester 的 Job 仍然可以运行，因为 tester 是另一个 `agentId`。

当 R1 结束：

```text
_finish(R1)
  → 释放 reviewer 运行计数
  → _drain()
  → R2 通过准入
  → R2：PENDING → RUNNING
```

这就是“受控并发”：并不强行把所有 Agent 串行，而是避免某一个 Worker 无限扩张成大量真实 OS 进程。

### 2.7 第七步：结果如何回到主 Agent

```text
bash 命令完成
  → Backend resolve / reject
  → Scheduler 将 Job 变为 SUCCEEDED / FAILED
  → job.promise 完成
  → BashTool.execute 返回文本 / 抛错
  → Registry 转换为 ToolResult
  → 子 Agent 将 ToolResult 写入自己的 Thread 历史
  → 子 Agent 继续推理并输出最终报告
  → run_subagent 将报告作为 ToolResult 回传主 Agent
  → 主 Agent 汇总 reviewer + tester 的结论
```

完整链路图：

```text
用户任务
  ↓
主 Agent Session: fix-test-001
  ↓ Promise.all
  ├───────────────────────────────────────┐
  ↓                                       ↓
reviewer Thread                         tester Thread
  ↓                                       ↓
模型调用 bash                            模型调用 bash
  ↓                                       ↓
BashTool → Scheduler.submit              BashTool → Scheduler.submit
  ↓                                       ↓
Job(reviewer, review-engine)             Job(tester, run-test)
  └───────────────┬───────────────────────┘
                  ↓
      ExecutionScheduler（同一 Node 进程）
                  ↓
      准入：全局 / Session / Agent 配额
                  ↓
           RUNNING 的 Job 才调用 Backend
                  ↓
          sh -c grep              sh -c npm test
                  ↓
          ToolResult / Thread 历史
                  ↓
           Worker 报告回到主 Agent
```

---

## 3. `AsyncLocalStorage` 到底是什么？为什么它既能做 Trace 又能做配额归属？

### 3.1 它解决的问题：异步调用中“当前是谁”会丢失

普通同步函数中，可以靠参数传递上下文：

```js
function execute(context) {
  console.log(context.sessionId);
}
```

但 Agent Runtime 中会有很多层异步调用：

```text
Engine.run
  → Promise.all
    → Registry.execute
      → BashTool.execute
        → Scheduler.submit
          → Backend.execute
            → spawn / 网络 / 定时器回调
```

如果每层都手动加 `sessionId`、`agentId`、`span` 参数：

```js
registry.execute(call, sessionId, agentId, span)
bash.execute(args, sessionId, agentId, span)
scheduler.submit({ ..., sessionId, agentId, span })
```

代码会变得非常臃肿，且容易漏传、传错或在并发任务间串线。

`AsyncLocalStorage` 是 Node.js 内置的异步上下文存储。可以把它理解为：

> 给当前一条异步执行链贴一张“隐形上下文卡片”；同一条链中后续的 `await`、Promise 回调、定时器回调都能取回这张卡片；并发的其他链有各自独立的卡片。

### 3.2 与 Java `ThreadLocal` 的对比

可以把 `AsyncLocalStorage` 理解成 **Node.js 异步调用链版本的 `ThreadLocal`**，但二者绑定的隔离单位不同：

| Java / 服务端概念 | Node.js 概念 |
|---|---|
| `ThreadLocal<UserContext>` | `AsyncLocalStorage` |
| 当前线程 | 当前异步调用链 |
| `ThreadLocal.get()` | `asyncLocalStorage.getStore()` |
| 在线程进入时 `set()` 上下文 | `run(store, callback)` 建立上下文 |
| Web 请求在线程池线程中处理 | `await` / Promise / 定时器回调组成异步链 |

Java 服务端常用线程池：一个请求在处理期间通常绑定某条工作线程，因此 `ThreadLocal` 可以保存用户、Trace ID、租户等请求上下文。不同线程各有独立的 `ThreadLocal` 值。

Node.js 则通常使用单事件循环线程处理大量并发异步任务。两个请求或子 Agent 可能在同一 OS 线程上交替恢复：

```text
reviewer：发起异步 I/O → 暂停
 tester ：发起异步 I/O → 暂停
reviewer：I/O 完成后继续
 tester ：I/O 完成后继续
```

如果把上下文简单放在“当前线程变量”中，reviewer 和 tester 会共用同一线程，数据就会串。`AsyncLocalStorage` 因此不按线程隔离，而是沿每条异步调用链传播上下文：

```text
reviewer 异步链 → { sessionId: 'review-thread', agentId: 'reviewer' }
tester   异步链 → { sessionId: 'test-thread',   agentId: 'tester' }
```

即使两条链交替运行在同一个事件循环线程上，`BashTool` 调用 `getStore()` 时仍能读到当前 Agent 自己的归属信息。

> 面试可直接说：`AsyncLocalStorage` 类似 Java 的 `ThreadLocal`，但 `ThreadLocal` 按线程隔离，ALS 按异步调用链隔离；它解决 Node.js 单线程事件循环下多个并发请求不能安全共享线程本地变量的问题。

### 3.3 最小示例

```js
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

await storage.run({ requestId: 'r-1' }, async () => {
  await Promise.resolve();
  console.log(storage.getStore());
  // { requestId: 'r-1' }
});
```

`run(store, callback)` 的含义：

```text
执行 callback 期间，以及它继续派生的异步操作中，
getStore() 都返回 store。
```

并发不会混：

```js
await Promise.all([
  storage.run({ requestId: 'A' }, async () => {
    await delay(10);
    console.log(storage.getStore().requestId); // A
  }),
  storage.run({ requestId: 'B' }, async () => {
    await delay(1);
    console.log(storage.getStore().requestId); // B
  }),
]);
```

即使 B 更早恢复，A 也不会读到 B 的上下文。

### 3.3 本项目不是“一个 ALS 同时存两种东西”

这是最容易混淆的点。

项目中有**两个不同的 `AsyncLocalStorage` 实例**：

```text
src/observability/trace.js
  const traceStorage = new AsyncLocalStorage()
  存的是：当前 Span

src/execution/context.js
  const executionContext = new AsyncLocalStorage()
  存的是：{ sessionId, agentId }
```

它们是两张独立的“隐形卡片”，互不覆盖：

| Storage | 保存什么 | 谁写入 | 谁读取 | 用途 |
|---|---|---|---|---|
| `traceStorage` | 当前父 Span | `startSpan()` | 嵌套 `startSpan()`、`getCurrentSpan()` | 自动构造 Trace 父子树 |
| `executionContext` | `sessionId`、`agentId` | `AgentEngine.run()` / `runSub()` | `BashTool.execute()` | Job 归属与配额统计 |

所以不是 `AsyncLocalStorage` 天生“既负责 Span 又负责配额”。而是它提供一种通用能力：**沿异步链携带上下文**。我们创建两份实例，分别承载两种业务上下文。

### 3.4 Span 父子关系是怎么得到的

Trace 逻辑可以简化为：

```js
async function startSpan(name, fn) {
  const parent = traceStorage.getStore();
  const span = new Span(name);
  if (parent) parent.addChild(span);

  return traceStorage.run(span, async () => {
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  });
}
```

运行过程：

```text
startSpan('Agent.Run')
  → traceStorage 当前值 = Agent.Run Span

  startSpan('Turn-1')
    → getStore() 得到 Agent.Run
    → Turn-1 挂到 Agent.Run.children
    → 当前值更新为 Turn-1

    startSpan('Tool.bash')
      → getStore() 得到 Turn-1
      → Tool.bash 挂到 Turn-1.children
```

最终自然形成：

```text
Agent.Run
  └── Turn-1
       └── Tool.bash
```

不需要把 `parentSpan` 作为参数穿过 Engine、Registry、Tool、Backend 的每一层。

### 3.5 配额归属是怎么得到的

主 Agent 执行时：

```js
runWithExecutionContext({
  sessionId: session.id,
  agentId: 'root',
}, () => engineLoop());
```

子 Agent 执行时：

```js
runWithExecutionContext({
  sessionId: threadId,
  agentId: agent.id,
}, () => subAgentLoop());
```

当更深层的 BashTool 调用：

```js
const { sessionId, agentId } = getExecutionContext();
```

它拿到的就是当前异步链所属的主 Session 或子 Agent Thread / 角色，再写到 Job：

```js
scheduler.submit({ sessionId, agentId, ... });
```

Scheduler 随后据此计算：

```text
runningBySession[sessionId]
runningByAgent[agentId]
```

### 3.6 一个比喻

可以把一次 Agent 异步调用链想成快递包裹的运输链：

```text
主仓 → 分拣 → 支线 → 配送
```

`AsyncLocalStorage` 就像贴在包裹上的电子面单：每到一个环节都能扫描到“它属于哪个订单、当前链路是什么”，不需要每个员工手写一张纸再交给下一个员工。

本项目贴了两张不同的面单：

```text
Trace 面单：当前位于哪一个 Span，父调用是谁
Execution 面单：当前任务属于哪个 Session / Agent
```

---

## 4. 状态机由什么触发？用例子梳理

### 4.1 状态机是什么

状态机就是：一个 Job 在其生命周期中只能处于有限几种状态，并且状态之间只能按允许的路径变化。

当前 Job 状态：

```text
PENDING
RUNNING
SUCCEEDED
FAILED
CANCELLED
QUEUE_TIMEOUT
RESOURCE_REJECTED（第三期）
```

第一期核心状态可以先记为：

```text
PENDING → RUNNING → SUCCEEDED / FAILED / CANCELLED
PENDING → QUEUE_TIMEOUT / CANCELLED
```

### 4.2 谁触发状态变化

| 当前状态 | 触发事件 | 调用位置 | 下个状态 |
|---|---|---|---|
| 新建 | `submit()` 创建 Job | `ExecutionScheduler.submit()` | `PENDING` |
| PENDING | `_drain()` 发现通过准入 | `ExecutionScheduler._start()` | `RUNNING` |
| PENDING | 排队定时器到期 | `queueTimer` 回调 → `_finish()` | `QUEUE_TIMEOUT` |
| PENDING | 调用 `cancel(jobId)` | `ExecutionScheduler.cancel()` | `CANCELLED` |
| RUNNING | `run(signal)` resolve | `_start()` Promise `.then()` → `_finish()` | `SUCCEEDED` |
| RUNNING | `run(signal)` reject | `_start()` Promise `.catch()` → `_finish()` | `FAILED` |
| RUNNING | 调用 `cancel(jobId)` | `AbortController.abort()` → 后端 reject → `.catch()` | `CANCELLED` |
| 新建 | 单任务资源大于总容量 | `submit()` 内立即 `_finish()` | `RESOURCE_REJECTED` |

`_finish()` 是统一的终态收口函数：

```text
1. 防止重复结束
2. 写 finishedAt / runMs
3. 清理排队计时器
4. 若此前 RUNNING，释放槽位和配额
5. 更新成功/失败/取消等指标
6. resolve/reject job.promise
7. 再次 _drain()，让后续等待任务尝试启动
```

### 4.3 例子一：正常成功

```text
T0：BashTool 调 scheduler.submit()
    → Job: PENDING

T0：_drain() 发现有可用槽位
    → _start(job)
    → Job: RUNNING
    → 调用 run(signal)

T1：`printf ok` 的子进程退出码为 0
    → Backend resolve('ok')
    → _finish(job, SUCCEEDED, 'ok')
    → Job: SUCCEEDED
    → job.promise resolve('ok')
```

### 4.4 例子二：排队后成功

```text
配置：maxConcurrent = 1

T0：Job A submit → PENDING → RUNNING（sleep 3）
T1：Job B submit → PENDING
    → _drain() 发现 running = 1，不能启动 B

T2：A 结束
    → _finish(A, SUCCEEDED)
    → running 从 1 变 0
    → _drain()
    → _start(B)
    → B: PENDING → RUNNING

T3：B 完成 → SUCCEEDED
```

### 4.5 例子三：排队超时

```text
配置：maxConcurrent = 1，maxQueueWaitMs = 1000ms

T0：Job A → RUNNING（sleep 5）
T0：Job B → PENDING

T1：B 的 queueTimer 到期
    → _finish(B, QUEUE_TIMEOUT, Error)
    → B 的 job.promise reject
    → B 从未调用 run(signal)，也从未 spawn 真实进程
```

这很重要：`QUEUE_TIMEOUT` 并不代表“命令跑超时”，而是“命令根本没获得启动资格”。

### 4.6 例子四：运行中取消

```text
T0：Job A → RUNNING
    → Backend 本地执行 `sleep 30`

T1：用户退出，或上层任务决定不需要 A
    → scheduler.cancel(A.id)
    → A.controller.abort(Error('任务被取消'))

T1：Backend 监听到 AbortSignal
    → LocalProcessBackend：child.kill('SIGKILL')
    → DockerBackend：docker kill / docker rm
    → Backend Promise reject

T1：Scheduler 的 catch 发现 signal.aborted = true
    → _finish(A, CANCELLED, error)
    → 释放资源
```

注意：`cancel()` 在运行中不会直接把状态硬改为 `CANCELLED`，而是先发送取消信号，等待 Backend 停止真实进程并 reject。这样状态转换和真实副作用保持一致。

### 4.7 为什么要防止重复结束

同一个 Job 可能接近同时发生多个事件：

```text
命令刚结束时，超时定时器也恰好触发
或用户取消时，进程 close 事件也马上到来
```

如果不防护，可能：

```text
同一个槽位被释放两次
同一个 Promise resolve/reject 两次
指标被重复计数
```

因此 `_finish()` 首先检查：

```js
if (TERMINAL_STATUSES.has(job.status)) return;
```

终态一旦写入，后续竞争事件直接忽略。这是异步系统中常见的“幂等收口”设计。

---

## 5. `spawn` 是什么？它是 Bash 原生能力吗？

不是。`spawn` 是 **Node.js 的 `node:child_process` 模块提供的 API**：

```js
import { spawn } from 'node:child_process';
```

它的作用是：让当前 Node.js 进程启动一个操作系统子进程。

### 5.1 本项目中的调用

本地后端使用：

```js
spawn('sh', ['-c', command], {
  cwd: workDir,
  env: process.env,
});
```

含义：

```text
启动一个 sh 进程
传给 sh 两个参数：-c 和 command
让 sh 在 workDir 目录执行 command
继承当前进程环境变量
```

例如：

```js
spawn('sh', ['-c', 'npm test'])
```

大致等价于你在终端中输入：

```bash
sh -c 'npm test'
```

`sh` 是 Unix 系统中的 Shell；`spawn` 是 Node.js 调起它的方法。两者不要混淆：

```text
Node.js spawn：负责创建 OS 子进程
sh / bash：被创建出来、负责解释命令字符串的 Shell 程序
npm test：Shell 最终执行的命令
```

### 5.2 为什么用 spawn 而不是 exec / execSync

Node.js 还有：

```text
exec      ：通过 Shell 执行命令，默认收集完整输出
execSync  ：同步阻塞版本，会卡住 Node.js 主线程
spawn     ：流式获取 stdout/stderr，适合长任务和大输出
```

本项目使用 `spawn` 的原因：

- 命令运行期间 Node.js 事件循环仍可处理其他 Agent / Tool 任务；
- 可实时累积 stdout / stderr；
- 可通过 `child.kill('SIGKILL')` 处理命令超时和取消；
- 不需要将全部输出先放进固定大小的 `exec` 缓冲区。

### 5.3 `spawn` 与 Docker 的关系

即使使用 DockerBackend，Node.js 仍会 `spawn('docker', [...])`：

```text
本地后端：Node spawn → sh 子进程 → 命令
Docker 后端：Node spawn → docker CLI → 容器内 sh → 命令
```

因此 `spawn` 是 Node 调用外部程序的通用入口；它不限定 Bash。

---

## 6. 配额是什么意思？

配额（quota）就是：**某个归属主体在一段时间或某个时刻最多能占用多少系统资源的规则。**

它回答的问题是：

```text
“这个人 / 这个会话 / 这个 Worker，最多能拿多少资源？”
```

### 6.1 本项目中的配额

第一期的配额是“同时运行任务数量”的配额：

```text
maxConcurrent = 4
  → 全系统最多 4 个 RUNNING Job

maxPerSession = 2
  → 一个 Session / 子 Agent Thread 最多 2 个 RUNNING Job

maxPerAgent = 2
  → 一种 Agent 角色最多 2 个 RUNNING Job
```

例子：

```text
全局 4 个槽位
Session A 已运行 2 个任务
Session B 已运行 1 个任务

此时 Session A 再提交任务：
  → 即使全局还有 1 个槽位，也不能运行（A 达到 maxPerSession=2）

Session B 或 Session C 提交任务：
  → 可以使用这个空闲槽位
```

这体现了配额的核心价值：**不仅防止总量过载，也避免局部主体独占资源。**

### 6.2 第三期扩展的资源配额

第三期将配额从“任务数量”扩展到“资源总量”：

```text
totalCpuMillis = 4000
  → 当前运行任务声明 CPU 总和最多 4000m，即约 4 核

totalMemoryMb = 4096
  → 当前运行任务声明内存总和最多 4096MB
```

它仍然是单机 Scheduler 的声明式预算，和 Docker cgroup 的硬限制不同：

```text
Scheduler 配额：决定任务能否开始
Docker cgroup：限制已开始任务最多实际能使用多少
```

### 6.3 生活类比

把执行资源比作共享会议室：

```text
全公司只有 4 间会议室             → maxConcurrent
每个部门同时最多占 2 间             → maxPerSession / maxPerAgent
大型会议还需要占用更多座位和设备      → CPU / 内存资源规格
```

配额不是为了让资源闲置，而是为了让资源在多个主体之间**可预测地、公平地共享**。

---

## 7. 最后一张总图

```text
┌──────────────────────────────────────────────────────────────┐
│ 1. Agent 层                                                   │
│ 主 Agent → run_subagent → reviewer / tester 并发执行          │
│ 同轮工具调用仍可 Promise.all 并发提交                         │
└──────────────────────┬───────────────────────────────────────┘
                       │ ToolCall(bash)
┌──────────────────────▼───────────────────────────────────────┐
│ 2. 上下文层                                                   │
│ executionContext ALS：取 sessionId / agentId                  │
│ traceStorage ALS：取当前父 Span                               │
└──────────────────────┬───────────────────────────────────────┘
                       │ Scheduler.submit(...)
┌──────────────────────▼───────────────────────────────────────┐
│ 3. 调度层                                                     │
│ 创建 Job（立即返回）                                          │
│ PENDING → 准入 → RUNNING → 终态                               │
│ 全局 / Session / Agent 配额；后续增加 CPU / 内存预算          │
└──────────────────────┬───────────────────────────────────────┘
                       │ run(signal)
┌──────────────────────▼───────────────────────────────────────┐
│ 4. 执行层                                                     │
│ LocalProcessBackend：Node spawn → sh -c → 命令                │
│ DockerBackend：Node spawn → docker → 容器 sh -c → 命令        │
└──────────────────────┬───────────────────────────────────────┘
                       │ output / error
┌──────────────────────▼───────────────────────────────────────┐
│ 5. 回流层                                                     │
│ Job.promise → BashTool → Registry ToolResult → Worker Thread │
│ → Worker 报告 → 主 Agent 汇总                                 │
└──────────────────────────────────────────────────────────────┘
```

一句话收尾：

> `submit()` 负责把“现在就 spawn 的副作用”改造成“先创建 Job、再由 Scheduler 准入”的异步流程；`AsyncLocalStorage` 负责让深层工具自动知道任务归属和 Trace 父节点；状态机负责保证排队、执行、成功、失败、取消这些事件不会混乱或重复结算。
