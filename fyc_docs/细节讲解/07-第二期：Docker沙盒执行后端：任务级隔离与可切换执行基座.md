# 07｜Docker 沙盒执行后端：任务级隔离与可切换执行基座

## 1. 第二期解决什么问题

第一期已经将 Bash 调用变成可排队、可限流、可取消的 `Execution Job`：

```text
ToolCall(bash)
  → ExecutionScheduler
  → 本机 spawn('sh', ['-c', command])
```

但是“有调度”不等于“有隔离”。第一期命令仍直接运行在宿主机进程权限下：即使工作目录设为 `cwd`，命令仍可能读写宿主机允许访问的其他路径、访问网络、创建过多进程或占用过多 CPU / 内存。

第二期的目标是将“**何时运行**”和“**在哪里运行**”分开：

```text
Scheduler：何时获得执行槽位
Backend：获得槽位后，在哪个执行基座里运行
```

最终链路：

```text
Agent ToolCall
  → Registry
  → BashTool
  → ExecutionScheduler（队列 / 并发 / Session / Agent 配额）
  → ExecutionBackend
       ├── LocalProcessBackend：sh -c（兼容第一期）
       └── DockerBackend：docker run（资源受限容器）
  → ToolResult
```

本期实现了可切换的 `local` / `docker` 执行基座，并让 Docker 后端默认关闭网络、限制容器能力、配置只读根文件系统与资源上限。

---

## 2. 本期目标、实现范围与边界

### 已实现

1. 定义 `ExecutionBackend` 的统一调用形态：`execute({ command, workDir, signal })`。
2. 实现 `LocalProcessBackend`，保留原有 `sh -c`、命令超时、`SIGKILL` 和输出截断行为。
3. 实现 `DockerBackend`，使用 `docker run` 执行命令，并包含：
   - 无网络：`--network none`；
   - 只读根文件系统：`--read-only`；
   - 有限临时目录：`--tmpfs /tmp:rw,noexec,nosuid,size=64m`；
   - 清空 Linux capabilities：`--cap-drop ALL`；
   - 禁止提权：`--security-opt no-new-privileges:true`；
   - PID / 内存 / CPU 限制；
   - 仅挂载 Agent 工作区到 `/workspace`。
4. 从环境变量选择执行后端，默认保持 `local`，不影响已有用户。
5. 将运行中取消打通到 Docker：先杀 `docker` CLI，再 best-effort `docker kill` / `docker rm -f` 清理指定容器。
6. 新增单测覆盖后端工厂、Docker 命令构建、资源配置校验及 Bash 后端委派。

### 本期不做

- Docker 不等于绝对安全边界；特权容器、Docker Socket 挂载、宿主机高权限目录挂载等高风险选项均未提供，但生产环境仍应使用更强隔离（gVisor、Kata、Firecracker）和独立宿主机策略。
- 没有容器池、镜像预热、镜像分层缓存策略；每个任务执行 `docker run --rm`。
- 没有跨节点 Host Agent、集群控制面、持久化任务队列。
- 没有主动探测并提示 Docker daemon 是否启动。若用户选择 `docker` 后端但 Docker 不可用，工具调用会以 ToolResult 错误返回，交给 Recovery / Reminder 引导。
- `/workspace` 当前以 `rw` 挂载，因为 Coding Agent 需要修改项目文件；这意味着它不是“完全无写入”的只读分析沙盒。

---

## 3. 核心抽象：Scheduler 与 Backend 解耦

第一期 Scheduler 的 Job 使用如下回调：

```js
scheduler.submit({
  sessionId,
  agentId,
  label,
  run: (signal) => /* 真正执行 */,
});
```

Scheduler 从未依赖 `spawn`、Docker API 或 Shell 命令。它只负责：

```text
PENDING → RUNNING → SUCCEEDED / FAILED / CANCELLED / QUEUE_TIMEOUT
```

因此第二期无需修改 Scheduler 状态机，只需把 `run(signal)` 的实现交给 Backend：

```js
run: (signal) => this.backend.execute({
  command,
  workDir: this.workDir,
  signal,
})
```

这就是执行抽象的价值：

| 变化 | 是否修改 Scheduler | 是否修改 ReAct Loop |
|---|---:|---:|
| 本机 Shell → Docker | 否 | 否 |
| Docker → 远程 Host Agent | 否 | 否 |
| Docker → microVM | 否 | 否 |
| 增加 CPU/内存资源规格 | Backend / Job 元数据 | 通常否 |

Agent 仍只发起 `bash` Tool Call；Registry 仍只接收 `ToolResult`。执行环境的变化不会扩散到模型协议和 Agent 主循环。

---

## 4. 三个核心模块

```text
src/execution/
  ├── scheduler.js          第一期：队列、配额、状态机、取消、指标
  ├── backend.js            第二期：LocalProcessBackend / DockerBackend
  ├── default-backend.js    根据环境变量延迟构建默认 Backend
  ├── default-scheduler.js  根据环境变量构建默认 Scheduler
  └── context.js            传递 sessionId / agentId
```

### 4.1 `LocalProcessBackend`

`LocalProcessBackend` 将原先 `BashTool._runProcess()` 的职责下沉到后端：

```text
spawn('sh', ['-c', command])
  → 收集 stdout / stderr
  → 命令超时后 SIGKILL
  → 调度器取消时 SIGKILL
  → 输出按字节截断
```

这不是安全沙盒，只是兼容后端。默认仍使用它，以保证不安装 Docker 时项目行为不变。

### 4.2 `DockerBackend`

Docker 后端为每次任务生成独立随机容器名：

```text
tiny-harness-<uuid>
```

随后组装类似命令：

```bash
docker run --rm --name tiny-harness-<uuid> \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 512m \
  --cpus 1 \
  --workdir /workspace \
  --volume <workDir>:/workspace:rw \
  alpine:3.20 sh -c '<command>'
```

`docker run --rm` 使正常退出的容器自动删除。命令超时或 Scheduler 取消时，为处理 CLI 本身被杀后容器仍可能短暂存在的情况，后端再以 best-effort 方式执行：

```text
docker kill <containerName>
docker rm -f <containerName>
```

清理命令失败不会覆盖原始超时/取消错误，因为原始失败原因更有助于 Agent 决策。

### 4.3 `default-backend.js` 为什么要延迟构建

CLI 在 `main()` 内先读取 `.env`，而 ESM 的 `import` 在进入 `main()` 前执行。

如果直接在模块顶层写：

```js
export const defaultBackend = createExecutionBackend({
  kind: process.env.TINY_HARNESS_EXECUTION_BACKEND,
});
```

则 `.env` 中的 `TINY_HARNESS_EXECUTION_BACKEND=docker` 还没写入 `process.env`，最终错误地固定为 `local`。

所以改为 `getDefaultExecutionBackend()`：第一次构造 `BashTool` 时才读取环境变量。它用当前配置生成 signature；环境变量改变时会重建 Backend，便于测试和嵌入式调用。

---

## 5. Docker 安全选项逐项解释

### 5.1 网络：`--network none`

容器没有网络接口，命令不能通过 HTTP、SSH、数据库连接等方式访问外部服务。它直接降低了不可信命令的数据外传、扫描内网、下载依赖等风险。

代价是：如果任务需要 `npm install`、下载模型、访问 API，就不能使用默认 Docker 策略。应为这类任务另设经过审批的网络策略，而不是删除默认隔离。

### 5.2 文件系统：`--read-only` + `/tmp` tmpfs

`--read-only` 让容器根文件系统不可写，阻止命令修改镜像内的系统路径。某些程序仍需要临时文件，因此仅提供受限的 `/tmp`：

```text
--tmpfs /tmp:rw,noexec,nosuid,size=64m
```

- `size=64m`：临时目录容量上限；
- `noexec`：不能直接执行 `/tmp` 内写出的文件；
- `nosuid`：忽略 setuid / setgid 权限位。

项目工作区另行挂载为 `/workspace:rw`。这是功能与安全的取舍：Coding Agent 需要创建/编辑源文件。若只做代码审查，应将挂载改成 `:ro`，或增加 `readOnlyWorkspace` 配置。

### 5.3 权限：`--cap-drop ALL` + `no-new-privileges`

Linux capabilities 把传统 root 权限拆成多项特权。`--cap-drop ALL` 清除默认能力集；`no-new-privileges:true` 阻止进程通过 setuid 等路径获得额外权限。

这降低容器内进程进行网络管理、挂载、调试其他进程等操作的能力。但它不是对 Docker daemon 漏洞或宿主机内核漏洞的万能防护。

### 5.4 资源：PID、内存、CPU

```text
--pids-limit 128
--memory 512m
--cpus 1
```

- PID 限制防止 fork bomb 创建海量进程；
- 内存限制让单任务超过 512MB 时被 cgroup 约束，降低拖垮宿主机的风险；
- CPU 限制控制可用算力份额，结合第一期并发槽位避免多个任务争抢全部 CPU。

这是真正开始接触 JD 中“隔离与资源平衡”的任务级实现，但仍不是生产级超卖：本项目没有采集宿主机水位，也不会基于真实内存压力进行驱逐或迁移。

---

## 6. 配置与使用方式

默认是第一期兼容模式：

```bash
node src/index.js --provider mock --script read-file
```

启用 Docker 后端：

```bash
TINY_HARNESS_EXECUTION_BACKEND=docker \
TINY_HARNESS_DOCKER_IMAGE=alpine:3.20 \
TINY_HARNESS_DOCKER_MEMORY=512m \
TINY_HARNESS_DOCKER_CPUS=1 \
TINY_HARNESS_DOCKER_PIDS_LIMIT=128 \
node src/index.js --provider openai --prompt "运行项目测试"
```

可配置项：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `TINY_HARNESS_EXECUTION_BACKEND` | `local` | `local` 或 `docker` |
| `TINY_HARNESS_DOCKER_IMAGE` | `alpine:3.20` | Docker 基础镜像 |
| `TINY_HARNESS_EXECUTION_TIMEOUT_MS` | `30000` | 单次命令运行超时 |
| `TINY_HARNESS_DOCKER_MEMORY` | `512m` | Docker 内存上限 |
| `TINY_HARNESS_DOCKER_CPUS` | `1` | Docker CPU 上限 |
| `TINY_HARNESS_DOCKER_PIDS_LIMIT` | `128` | Docker PID 上限 |
| `TINY_HARNESS_MAX_EXECUTION_OUTPUT_BYTES` | `8000` | 返回模型前的输出上限 |

Docker 镜像需要具备 `sh`。默认 Alpine 足以执行基本 Shell 操作；如果要运行 Node 项目测试，应选用包含对应运行时的镜像，例如 `node:22-alpine`。

---

## 7. 取消、超时与清理的关系

现在存在三个不同层次的限制：

```text
1. Scheduler 排队超时
   任务还没运行，等太久 → QUEUE_TIMEOUT

2. Backend 命令超时
   容器/本地进程已运行，超过 timeoutMs → 强制停止

3. Scheduler 主动取消
   外部调用 cancel(jobId) → AbortSignal → Backend 停止进程/容器
```

不要把它们混为一谈：

- 排队超时不创建容器，不消耗运行资源；
- 命令超时由 Backend 管理，属于实际执行生命周期；
- 取消来自任务管理操作，可能发生在排队或运行中。

Docker 后端在 Trace 工具 Span 中仍通过 BashTool 记录 `executionJobId`、`executionSessionId`、`executionAgentId` 和新增的 `executionBackend=docker`，因此一次执行异常可以关联到 Session、Agent、调度 Job 与实际后端。

---

## 8. 测试与验证

新增 `test/execution-backend.test.js`：

1. 验证 Docker 命令包含网络禁用、只读文件系统、tmpfs、能力剥夺、提权禁止、PID / 内存 / CPU 限制和工作区挂载。
2. 验证后端工厂正确选择 `local` 或 `docker`，未知类型被拒绝。
3. 验证 Local 后端仍能正常运行 Shell 命令。
4. 验证非法资源配置被拒绝。

同时扩展 `test/bash-tool.test.js`，验证 BashTool 将实际执行委托给注入的 Backend，第一期 Scheduler 接入保持不变。

建议命令：

```bash
node --test test/execution-backend.test.js test/bash-tool.test.js test/execution-scheduler.test.js
npm test
```

本机没有可用的 Docker daemon，因此本次自动化测试覆盖 Docker 参数构建和本地后端兼容性，没有执行真实容器集成测试。真实环境可额外执行：

```bash
TINY_HARNESS_EXECUTION_BACKEND=docker \
TINY_HARNESS_DOCKER_IMAGE=alpine:3.20 \
node src/index.js --provider mock --script read-file
```

完整 `npm test` 的既存失败仍为 `docs/TUTORIAL_NEW.md` 指向不存在的 `./architecture.html`；它与第一、二期执行改造无关。

---

## 9. 这一期和岗位 JD 的对应关系

| JD 方向 | 当前状态 |
|---|---|
| 统一执行抽象 | 已实现第一版：`ExecutionBackend` 统一 `local` / Docker 基座 |
| Container 执行基座 | 已实现 Docker 后端 |
| 任务级资源隔离 | 已实现 CPU、内存、PID、网络、能力、文件系统的基础限制 |
| 状态追踪 / 故障恢复 | 已有 Scheduler 状态机、Trace、JSONL Session/Thread、超时/取消清理 |
| 镜像分发/加载优化 | 未实现；当前每次 `docker run --rm` |
| 高并发密度优化 | 仅有第一期队列与槽位配额，未实现容器池、镜像缓存、宿主机水位治理 |
| 超卖、页缓存复用、内存回收 | 未实现；需要更底层的 cgroup / runtime / kernel / 调度系统能力 |
| Cluster Monitor / Host Agent | 未实现；当前为单机单进程模型 |

因此对外应准确表述为：**实现了 Agent Runtime 的可切换任务级 Docker 执行后端和基础资源隔离，不应宣称为生产级沙盒集群。**

---

## 10. 下一步演进

第三期可以在不改 `ExecutionBackend` 调用协议的基础上增加：

```text
ExecutionScheduler
  → ContainerPool
      → 预热容器
      → 镜像预拉取 / 热启动指标
      → 工作区清理与容器复位
  → Resource Admission
      → 任务声明 CPU / 内存规格
      → 基于宿主机水位准入
      → 队列优先级与背压
```

再进一步，才是：

```text
API Gateway / Scheduler（控制面）
  → 持久化 Queue / Task Store
  → 多台 Host Agent（数据面）
  → Docker / containerd / microVM
```

第二期最重要的结果是：Agent 层不再绑定“本机 Shell”这一种执行方式。模型仍只会调用 `bash`，但 Runtime 可以按部署策略把它送往受限容器；调度、状态、Trace 和 ToolResult 协议保持不变。
