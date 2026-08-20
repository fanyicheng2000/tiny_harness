# 12｜第四期：会话级 Sandbox 与镜像启动优化

## 1. 为什么第三期容器池还不够

第三期的 `ContainerPool` 用于**无状态任务级复用**：任务从池中借一个已启动容器，使用 `docker exec` 执行命令，结束后清理临时文件，再归还给任意后续任务。

```text
任务 A → 借容器 C1 → 执行 → reset → 归还 C1
任务 B → 借容器 C1 → 执行 → reset → 归还 C1
```

这个模型可以减少频繁 `docker run` 的启动开销，但不适合 Agent 的连续多轮操作。因为同一 Session 的前后命令通常依赖前序状态：工作区文件、已安装依赖、进程内缓存等。若每条命令结束都 reset 并归还容器，则状态无法稳定保留；若不同 Session 共用同一个容器，还会引发状态泄漏。

第四期将复用边界从“任务”调整为“Session”：

```text
Session A 第一次命令 → 创建 Sandbox A
Session A 后续命令   → 复用 Sandbox A 和其工作区
Session B 第一次命令 → 创建 Sandbox B
Session B 后续命令   → 复用 Sandbox B 和其工作区
Session 结束/空闲    → 销毁自己的 Sandbox
```

本期还处理了另一段冷启动链路：如果运行节点没有镜像，首次创建容器前还会发生镜像下载。`ImageManager` 将镜像就绪检查、并发 Pull 合并和可选预热抽成独立模块。

> 本期是单进程、单机、Docker CLI 版本。Docker/OverlayFS 负责底层镜像 Layer 的物理共享；Harness 负责 Session 生命周期、并发去重和执行编排，并非自行实现容器运行时或分布式镜像仓库。

---

## 2. 本期架构与职责边界

```text
Agent ToolCall(bash)
       │
       ▼
BashTool
  └── 从 AsyncLocalStorage 取得 sessionId / agentId
       │
       ▼
ExecutionScheduler
  └── 并发、Session/Agent 配额、CPU/内存预算、排队与取消
       │
       ▼
DockerBackend
  ├── SessionSandboxManager：按 sessionId 管容器、串行化、TTL 回收
  └── ImageManager：镜像本地检查、并发 Pull 合并、预热
       │
       ▼
Docker CLI
  ├── docker image inspect / docker pull
  ├── docker run -d（首次创建 Session Sandbox）
  ├── docker exec（后续命令复用）
  └── docker rm -f（释放/异常回收）
```

四层分别回答不同问题：

| 层 | 要解决的问题 | 不负责什么 |
|---|---|---|
| Scheduler | 当前任务是否允许开始 | 创建镜像、管理容器 |
| BashTool | 从 Agent 上下文取得执行身份并提交 Job | 决定容器生命周期 |
| SessionSandboxManager | 哪个 Session 使用哪个容器，如何回收与串行 | Docker 命令细节 |
| ImageManager | 镜像是否已就绪，是否需要 Pull | Session 状态与任务调度 |
| DockerBackend | 将上层抽象翻译为 Docker 命令 | 模型规划、工具权限决策 |

因此“资源准入”“会话隔离”“镜像启动”不会混在一个类中。以后即使将 Docker 换为远端 Sandbox 服务，Scheduler 与 Agent 工具协议也无需重写。

---

## 3. 从 Bash 调用到 Session Sandbox 的完整链路

`BashTool` 本身不保存 Session 状态，而是从执行上下文中取得身份，并在提交调度任务时透传给 Backend：

```js
const context = getExecutionContext();
const job = this.scheduler.submit({
  sessionId: context.sessionId,
  agentId: context.agentId,
  // ...
  run: (signal) => this.backend.execute({
    command,
    workDir: this.workDir,
    sessionId: context.sessionId,
    agentId: context.agentId,
    signal,
    resources: args.resources,
  }),
});
```

身份经由 `AsyncLocalStorage` 自动贯穿 ReAct 与工具调用异步链路。这样不需要让每层函数都新增 `sessionId` 参数；但真正进入执行后端时，仍要显式传给 `DockerBackend`，因为它是 Sandbox 的生命周期 Key。

Docker Backend 的分流如下：

```js
async execute({ command, workDir, sessionId = 'default', signal, resources = null }) {
  if (this.sessionSandbox) {
    return this._executeInSessionSandbox({ command, workDir, sessionId, signal, resources });
  }
  if (this.poolSize > 0) return this._executePooled({ command, workDir, signal, resources });
  return this._executeEphemeral({ command, workDir, signal, resources });
}
```

默认 `sessionSandbox = true`，即新链路是默认路径；老的任务级 `ContainerPool` 与一次性 `docker run` 并未删除。将 `sessionSandbox` 显式关闭后，仍可用于无状态任务或回归对比。

---

## 4. ImageManager：镜像就绪检查与并发 Pull 合并

### 4.1 为什么不能让每个创建请求自行 docker pull

假设 Docker 节点刚启动，`alpine:3.20` 不存在；10 个 Session 同时发起第一次命令。

```text
错误做法：10 个请求各自 docker pull alpine:3.20
结果：重复网络请求、Registry 压力、磁盘写入竞争、启动时间抖动

正确做法：第一个请求 Pull，其余 9 个请求等待同一个 Promise
结果：单次 Pull 完成后，10 个 Session 都可继续创建 Sandbox
```

`ImageManager` 使用两个 Map 描述两种状态：

```text
ready   : Map<image, { readyAt, lastUsedAt }>
loading : Map<image, Promise<ImageReadyResult>>
```

- `ready`：Harness 进程已确认镜像就绪，后续无需再次 `docker image inspect`；
- `loading`：镜像正在执行检查/Pull，后来的同镜像请求加入同一条加载链路。

### 4.2 ensureImage 状态分支

```text
ensureImage(image)
  │
  ├─ ready 命中
  │    └─ 更新 lastUsedAt，返回 memory-cache
  │
  ├─ loading 命中
  │    └─ 返回同一个 Promise，joinedLoads + 1
  │
  └─ 首个请求
       ├─ docker image inspect <image>
       ├─ 存在：记录 ready，返回 docker-local-cache
       └─ 不存在：docker pull <image> → 记录 ready，返回 pulled
```

核心逻辑：

```js
if (this.ready.has(image)) {
  this.metrics.localHits++;
  this.ready.get(image).lastUsedAt = this.clock();
  return { image, source: 'memory-cache' };
}
if (this.loading.has(image)) {
  this.metrics.joinedLoads++;
  return this.loading.get(image);
}

const loading = this._ensure(image);
this.loading.set(image, loading);
try {
  return await loading;
} finally {
  this.loading.delete(image);
}
```

`finally` 很关键：无论 Pull 成功还是失败，`loading` 状态都必须删除。失败后下一次调用可以重新尝试，不能永久拿到一个失败的 Promise。

### 4.3 Docker 本地缓存与 Harness 内存缓存不是一回事

| 缓存层 | 保存什么 | 生命周期 | 本期作用 |
|---|---|---|---|
| Harness `ready` Map | “本进程已经确认过镜像” | Node 进程生命周期 | 避免重复 inspect |
| Docker image store | 镜像 Manifest 与 Layer | Docker 节点生命周期 | 避免重复下载镜像 |
| OverlayFS Layer | 相同镜像的只读文件层 | Docker 管理 | 多容器共享底层只读 Layer |
| Session Sandbox | 容器 + 当前工作区状态 | Session / TTL 生命周期 | 同一会话复用执行环境 |

因此 `ImageManager` 不复制、也不自行管理 Layer 文件；它先通过 `docker image inspect` 利用 Docker 已有的本地缓存，缺失时才调用 `docker pull`。相同镜像启动的多个容器，Docker 自然会复用只读层；各 Session 的 `/workspace` 是单独的可写挂载路径。

### 4.4 预热

`preload(images)` 只是批量复用 `ensureImage`：

```js
async preload(images) {
  if (!Array.isArray(images)) throw new Error('preload images 必须是数组');
  this.metrics.preloadRequests += images.length;
  return Promise.all(images.map((image) => this.ensureImage(image)));
}
```

通过环境变量可在默认 Backend 创建后异步触发预热：

```bash
TINY_HARNESS_EXECUTION_BACKEND=docker
TINY_HARNESS_DOCKER_PRELOAD_IMAGES=alpine:3.20,node:22-alpine
```

预热失败被隔离为后台错误，不应阻止 CLI 启动；真实执行时仍会再次走 `ensureImage` 并获得明确错误。这个版本不做热度预测，只允许把确定会使用的基础镜像提前下载。

### 4.5 可观测性

`getSnapshot()` 可以返回：

- 已就绪镜像和 `readyAt` / `lastUsedAt`；
- 正在加载的镜像；
- `checks`、`localHits`、`pulls`、`joinedLoads`、`preloadRequests`。

其中 `joinedLoads` 越大，说明高并发场景下避免的重复 Pull 越多；`pulls` 可用于识别镜像冷启动；`localHits` 反映 Docker 或 Harness 缓存命中。

---

## 5. SessionSandboxManager：以 Session 为隔离与状态边界

### 5.1 基本数据结构

```text
sandboxes : Map<sessionId, Sandbox>
creating  : Map<sessionId, Promise<Sandbox>>
```

一个 `Sandbox` 保存 Docker 返回的 `id`，并补充 Harness 生命周期字段：

```js
{
  id: 'docker-container-id',
  sessionId,
  workDir,
  image,
  createdAt,
  lastUsedAt,
  timer,
  tail,
}
```

其中：

- `sandboxes`：已成功创建、可复用的容器；
- `creating`：正在创建的容器，用于同 Session 创建去重；
- `timer`：空闲回收计时器；
- `tail`：当前 Session 的执行队列尾 Promise，用于串行化。

### 5.2 创建前先准备镜像

`_create` 的关键顺序是：

```js
async _create({ sessionId, workDir, resources }) {
  await this.imageManager.ensureImage(this.image);
  const sandbox = {
    ...(await this.runtime.create({ sessionId, workDir, image: this.image, resources })),
    sessionId,
    workDir,
    image: this.image,
    // ... 生命周期字段
  };
  this.sandboxes.set(sessionId, sandbox);
  this._touch(sandbox);
  return sandbox;
}
```

镜像失败时，不会创建半成品容器，也不会写入 `sandboxes`；调用方直接收到失败。只有镜像确认可用后，才进入容器创建。

Docker 运行时用后台常驻进程保持容器：

```text
docker run -d \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit <N> \
  --memory <M> \
  --cpus <C> \
  --volume <workDir>:/workspace:rw \
  <image> sh -c 'while true; do sleep 3600; done'
```

它并不在启动时执行业务命令；业务命令由后续 `docker exec <containerId> sh -c <command>` 执行。这正是同一 Session 后续命令避免重复 `docker run` 的原因。

### 5.3 同一 Session 的创建 SingleFlight

多个 Agent 分支可能同时第一次调用相同 Session。`acquire` 不能创建两个容器：

```js
if (this.creating.has(sessionId)) {
  this.metrics.creationJoins++;
  return this.creating.get(sessionId);
}

const creating = this._create({ sessionId, workDir, resources });
this.creating.set(sessionId, creating);
try {
  return await creating;
} finally {
  this.creating.delete(sessionId);
}
```

与 `ImageManager.loading` 的思想一致：将“资源还不存在”的并发创建合并。这里合并的是**同一 Session 的容器创建**，前者合并的是**同一镜像的下载**，两者 Key 不同、职责也不同。

### 5.4 为什么同 Session 命令要串行

Session 允许复用同一个可写工作区，这带来连续性，也带来并发写风险：

```text
命令 1：修改 package.json
命令 2：同时 npm install
命令 3：同时读取 lockfile
```

若三条命令并行执行，结果取决于时序，可能出现部分写入、依赖目录损坏或 Git 状态交错。当前简单且安全的策略是：**同一 Session 所有 Sandbox 命令串行**。

```js
const execution = sandbox.tail.then(() => run(sandbox));
sandbox.tail = execution.catch(() => {});
return execution;
```

解释：

1. `tail` 初始为 `Promise.resolve()`；第一条任务立即开始；
2. 下一条任务在前一条 `tail` 完成后才运行；
3. `execution.catch(() => {})` 被赋给新的 `tail`，保证前一条失败不会阻断后续任务；
4. 当前调用者仍会收到原始 `execution` 的成功或失败结果。

调度器的 `maxPerSession` 默认值也从 `2` 调整为 `1`，形成两层保护：Scheduler 防止同 Session 任务并行进入 Backend；Manager 在调用方绕过 Scheduler 或未来配置提高并发时，仍保证 Sandbox 内执行串行。

### 5.5 TTL 回收与显式释放

每次获取或执行 Sandbox 都会 `_touch`：更新 `lastUsedAt` 并重置定时器。

```text
每次访问
  → 清除旧 timer
  → 设置新的 idleTtl timer
  → 到期且仍是当前实例时 docker rm -f
```

默认 TTL 为 30 分钟，可配置：

```bash
TINY_HARNESS_SANDBOX_IDLE_TTL_MS=1800000
```

还可以在 Session 明确结束时调用：

```js
await dockerBackend.releaseSession(sessionId);
```

进程退出时可调用：

```js
await dockerBackend.shutdown();
```

TTL 回调会先校验 Map 中仍是同一个对象：

```js
if (this.sandboxes.get(sandbox.sessionId) !== sandbox) return;
```

这避免旧容器的延迟回调在 Session 已经创建了新容器后，误删新实例。

---

## 6. 失败、超时与不健康 Sandbox

Session 复用不能意味着“任何状态都无限复用”。如果命令超时、被取消，或 Docker exec 抛出异常，容器可能残留子进程、锁或未知状态。

因此 `DockerBackend._executeInSessionSandbox` 的原则是：

```text
正常完成：保留 Sandbox，供同 Session 后续命令复用
执行失败 / 超时 / 取消：标记不健康，释放 Sandbox
下次同 Session 执行：重新执行镜像就绪检查并创建新容器
```

执行超时或取消时，`runCommand` 调用 stop 回调：先杀掉 `docker exec` 客户端进程，再 `docker kill <sandboxId>`；外层 finally 随后通过 `release(sessionId, 'execution-unhealthy')` 删除 Manager 中的记录并执行 `docker rm -f`。

这里优先保障隔离正确性，而不是强行挽救容器。正常命令失败（例如脚本退出码非 0）当前同样会走不健康回收，这是保守实现；后续可以把“业务命令失败”与“运行时异常/超时”拆分，并只在后者销毁 Sandbox。

---

## 7. 配置与兼容模式

新增配置如下：

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `TINY_HARNESS_SESSION_SANDBOX` | `true` | 是否默认按 Session 复用 Sandbox |
| `TINY_HARNESS_SANDBOX_IDLE_TTL_MS` | `1800000` | 空闲 Sandbox 回收时间（毫秒） |
| `TINY_HARNESS_DOCKER_PRELOAD_IMAGES` | 空 | 逗号分隔的预热镜像 |
| `TINY_HARNESS_DOCKER_POOL_SIZE` | `0` | 旧任务级容器池大小，仅关闭 Session 模式后生效 |

示例：

```bash
export TINY_HARNESS_EXECUTION_BACKEND=docker
export TINY_HARNESS_DOCKER_IMAGE=node:22-alpine
export TINY_HARNESS_SESSION_SANDBOX=true
export TINY_HARNESS_SANDBOX_IDLE_TTL_MS=900000
export TINY_HARNESS_DOCKER_PRELOAD_IMAGES=alpine:3.20,node:22-alpine
```

若需要回到第三期无状态模型：

```bash
export TINY_HARNESS_SESSION_SANDBOX=false
export TINY_HARNESS_DOCKER_POOL_SIZE=2
```

这时 `DockerBackend` 会优先走 ContainerPool；任务结束后 reset 并归还容器，不保留 Session 状态。

---

## 8. 本期测试覆盖

### 8.1 ImageManager

`test/image-manager.test.js` 覆盖：

1. Docker 本地镜像存在后，第二次调用命中 Harness 内存缓存，不重复 inspect；
2. 同镜像两个并发请求只有一次 `pull`；
3. `preload` 会准备每个请求镜像。

### 8.2 SessionSandboxManager

`test/session-sandbox-manager.test.js` 覆盖：

1. 同一 Session 获得同一个 Sandbox，不同 Session 获得不同 Sandbox；
2. 同一 Session 并发 acquire 只创建一次容器；
3. 同一 Session 的两个 `execute` 按提交顺序串行；
4. TTL 到期后销毁 Sandbox。

### 8.3 Backend 兼容性

`test/execution-backend.test.js` 验证 DockerBackend 默认开启 Session 模式，并能通过 `sessionSandbox: false` 保留旧执行路径。原有 Bash、Scheduler、ContainerPool 测试继续覆盖旧能力。

可执行：

```bash
node --test test/image-manager.test.js test/session-sandbox-manager.test.js test/execution-backend.test.js test/bash-tool.test.js
```

---

## 9. 本期能力与边界

### 已实现

- 单机 Docker 镜像存在性检查与按需 Pull；
- 同镜像并发 Pull 合并；
- 可选基础镜像预热；
- 一个 Session 一个常驻 Docker Sandbox；
- 同 Session 工作区状态复用；
- 会话间容器隔离；
- 同 Session 执行串行；
- 空闲 TTL、显式释放和异常回收；
- 任务级 ContainerPool 兼容模式保留。

### 未实现

- 多节点调度、Session 粘性路由和 Sandbox 迁移；
- Layer Digest 级缓存容量控制、LRU 淘汰；
- P2P/Registry 加速分发；
- Stargz、Nydus 等文件级 Lazy Pull；
- Session 结束事件自动挂钩到 Engine 生命周期；
- 读写锁区分，只读命令并行；
- Sandbox checkpoint/快照恢复。

这些能力应在单机语义稳定后逐步演进，不能仅因为“镜像优化”就把分布式系统复杂度一次性塞入 Harness。

---

## 10. 面试总结

可以按下面顺序说明本期设计：

> 任务级容器池虽然能减少 `docker run`，但 Agent 是多轮、有状态执行，同一会话的后续操作需要看到前序工作区状态，因此将 Sandbox 的复用边界提升到 Session。首次命令通过 ImageManager 检查本地镜像，缺失时 Pull；相同镜像和相同 Session 的并发创建都采用 SingleFlight 合并，避免重复下载或重复建容器。镜像就绪后创建常驻受限容器，后续命令直接 docker exec；同 Session 写状态共享，因此通过 Scheduler 配额和 Manager 内部 Promise 队列双层串行化。Session 空闲超时、显式结束或命令异常时销毁容器，保证会话间隔离并防止异常环境被复用。Docker 自身通过本地 image store 与 OverlayFS 共享相同镜像的只读 Layer，Harness 不重复造底层缓存，而是负责其上层的生命周期和并发治理。
