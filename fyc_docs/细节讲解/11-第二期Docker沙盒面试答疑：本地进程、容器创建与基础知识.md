# 11｜第二期 Docker 沙盒面试答疑：本地进程、容器创建与基础知识

> 本文解释第二期中 `LocalProcessBackend` 与 `DockerBackend` 的真实执行差异：命令究竟运行在哪里、Docker 容器由谁创建、项目代码如何调用 Docker，以及为了理解/面试该模块需要掌握哪些 Docker 基础。

---

## 1. 先给结论

你的理解基本正确：

```text
LocalProcessBackend
  → 在当前宿主机操作系统中执行 shell 命令

DockerBackend（poolSize = 0，第二期默认模式）
  → 每次执行命令都会执行一次 docker run
  → docker run 会创建一个新容器
  → 容器执行命令结束后，--rm 自动删除容器
```

但第三期引入容器池后有一个例外：

```text
DockerBackend（poolSize > 0）
  → 不再每次 docker run
  → 先创建一批常驻容器
  → 每次任务通过 docker exec 在借到的容器中执行
  → 正常结束后 reset 并归还容器池
```

因此可以记为：

```text
第二期默认：一任务一容器
第三期池化：多任务复用常驻容器（但同一时刻一个容器只借给一个任务）
```

---

## 2. `LocalProcessBackend`：命令运行在宿主机

### 2.1 宿主机是什么

宿主机（host machine）指运行 Node.js、Docker daemon 和项目代码的那台真实机器或虚拟机。

在你的本地开发环境中，可以粗略理解为：

```text
macOS
  └── Node.js 进程：node src/index.js
       └── LocalProcessBackend
            └── sh -c "npm test"
                 └── npm / node / 测试子进程
```

`LocalProcessBackend` 调用的是 Node.js 的 `spawn`：

```js
spawn('sh', ['-c', command], {
  cwd: workDir,
  env: process.env,
});
```

这会让 Node.js 启动宿主机上的 `sh` 程序，`sh` 再解释并执行命令字符串。

例如模型调用：

```json
{
  "command": "npm test"
}
```

实际执行关系是：

```text
Node.js
  → spawn 宿主机 sh
    → sh -c 'npm test'
      → 宿主机 npm
        → 宿主机 node
```

### 2.2 `cwd: workDir` 不是安全隔离

代码中设置：

```js
cwd: workDir
```

只表示命令的“当前工作目录”是项目目录，相当于先执行：

```bash
cd <workDir>
npm test
```

它**不表示**命令只能访问 `workDir`。

只要宿主机权限允许，下面的命令仍可能访问工作区外：

```bash
cat ~/.ssh/config
ls /
rm -rf /some/path
curl https://example.com
```

这就是为什么 LocalProcessBackend 在工具描述中明确写了“本机 Shell，不提供安全隔离”。它用于本地开发和兼容模式，不适合作为不可信 Agent 命令的最终执行环境。

---

## 3. `DockerBackend`：命令运行在容器内

### 3.1 容器可以先粗略理解成什么

面试初期可以把 Docker 容器理解为：

> 一个由宿主机内核提供隔离边界的受限进程组：它并不是完整虚拟机，没有独立内核；但它拥有独立的进程视图、网络视图、文件系统视图和资源限制。

更准确一点：

```text
容器 = Linux namespace 隔离 + cgroup 资源限制 + 镜像文件系统层 + 容器运行时管理
```

它与 VM 的主要区别：

| 项目 | Docker 容器 | 虚拟机 VM |
|---|---|---|
| 内核 | 与宿主机共享内核 | 有自己的 Guest OS 内核 |
| 启动 | 通常更快 | 通常更慢 |
| 隔离层级 | 进程/内核特性隔离 | 硬件虚拟化级别更强 |
| 镜像内容 | 应用及依赖文件系统 | 完整操作系统 |
| 本项目用途 | 执行 Agent Shell 工具 | 当前未实现 |

在 macOS 上有一点需要补充：Docker Desktop 通常会先启动一个 Linux VM，Linux 容器实际运行在这个 VM 内。你在 macOS 里敲 `docker run`，Docker Desktop 负责把请求转给内部 Linux 环境。

### 3.2 从模型命令到容器命令的路径

模型调用：

```json
{
  "command": "npm test"
}
```

经过 Runtime：

```text
Agent ToolCall
  → BashTool
  → ExecutionScheduler
  → DockerBackend.execute({ command: 'npm test', ... })
  → Node.js spawn('docker', dockerArgs)
  → Docker CLI 请求 Docker daemon
  → Docker daemon 创建容器并启动容器内 sh
  → 容器内 sh -c 'npm test'
```

注意这里仍然会用 `spawn`，只是启动的程序从宿主机 `sh` 变成了宿主机 `docker` CLI：

```text
LocalProcessBackend：Node spawn → 宿主机 sh → 命令
DockerBackend：      Node spawn → docker CLI → Docker daemon → 容器 sh → 命令
```

---

## 4. 项目是怎么创建 Docker 容器的

### 4.1 不是调用 Docker SDK，而是启动 Docker CLI

本项目没有引入 Docker SDK，也没有直接访问 Docker Engine HTTP API。它使用 Node.js：

```js
spawn('docker', args)
```

去执行宿主机上的 Docker 命令行工具，相当于人在终端里输入 Docker 命令。

`DockerBackend` 为每次普通任务生成唯一容器名：

```js
const containerName = `tiny-harness-${randomUUID()}`;
```

然后 `buildArgs()` 组装参数。将参数拼成可读命令，大致是：

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
  alpine:3.20 \
  sh -c 'npm test'
```

代码层面不是把这一整条字符串交给 Shell，而是把“命令”和“参数数组”分开传给 Node `spawn`：

```js
spawn('docker', [
  'run', '--rm', '--name', containerName,
  '--network', 'none',
  // ... 其余参数 ...
  image,
  'sh', '-c', command,
]);
```

这样避免为了启动 Docker 再额外经过一次宿主机 Shell 的字符串解析，也更容易安全、准确地组织参数。

### 4.2 `docker run` 做了什么

`docker run` 可以粗略拆成：

```text
1. 检查本地是否已有 image
2. 没有则按配置从镜像仓库拉取 image
3. 基于 image 创建一个可写容器层
4. 应用网络、文件系统、capability、cgroup 等隔离配置
5. 启动容器的主进程：sh -c '<command>'
6. 等待主进程退出
7. 因为 --rm，自动删除容器及其可写层
```

因此，第二期默认模式下：

```text
一次 Bash Tool Call
  ≈ 一次 docker run
  ≈ 一个新容器的创建、执行和销毁
```

严格说，`docker run` 同时包含“create + start + attach”三个动作。Docker 也可以拆开写：

```bash
docker create ...
docker start ...
docker exec ...
```

但本项目普通任务使用 `docker run`，因为一次性语义更直观，且 `--rm` 能自动清理短生命周期容器。

### 4.3 `--rm` 为什么重要

任务容器是短生命周期资源：命令结束后通常不再需要。

```text
没有 --rm：
  每次任务都留下 exited 容器
  → 容器列表越来越多
  → 磁盘和元数据堆积

使用 --rm：
  容器主进程退出
  → Docker 自动删除容器及其可写层
```

但 `--rm` 只处理正常结束路径。超时或取消时，本项目还会尽力执行：

```text
docker kill <containerName>
docker rm -f <containerName>
```

目的是防止 Node 启动的 Docker CLI 被杀后，底层容器仍在运行。

---

## 5. Docker 命令中的关键隔离配置

下面这些参数不是为了“看起来复杂”，而是第二期真正的安全边界。

| 参数 | 作用 | 缓解的风险 |
|---|---|---|
| `--network none` | 容器没有网络 | 内网扫描、数据外传、下载未知内容 |
| `--read-only` | 容器根文件系统不可写 | 修改镜像系统路径、写入持久垃圾文件 |
| `--tmpfs /tmp:...` | 提供受限临时目录 | 给正常程序写临时文件，同时限制容量/执行权限 |
| `--cap-drop ALL` | 删除 Linux capabilities | 降低容器内特权操作能力 |
| `no-new-privileges:true` | 禁止进程通过 setuid 等方式升级权限 | 权限提升 |
| `--pids-limit 128` | 限制容器内进程数 | fork bomb、进程耗尽 |
| `--memory 512m` | 限制内存 | 单任务内存占满宿主机 |
| `--cpus 1` | 限制 CPU 份额 | 单任务长期抢占 CPU |
| `--workdir /workspace` | 容器内当前目录 | 让相对路径命令在项目目录运行 |
| `--volume host:/workspace:rw` | 挂载项目工作区 | Agent 能读写目标项目文件 |

### 5.1 一个必须讲清的权衡：工作区仍然是 `rw`

容器根文件系统虽然是只读的，但项目工作区挂载为：

```text
/workspace:rw
```

原因是 Coding Agent 需要写代码、生成测试或运行构建产物。

这意味着 DockerBackend 的安全承诺是：

```text
限制命令对宿主机其他区域、网络和资源的影响；
允许它修改被授权的项目工作区。
```

它不是“命令完全不可写”。

若场景是只读审查，应设计 `readOnlyWorkspace` 策略并改成：

```text
--volume <workDir>:/workspace:ro
```

---

## 6. 第三期容器池改变了什么

第三期配置：

```bash
TINY_HARNESS_DOCKER_POOL_SIZE=2
```

代表每个工作区最多维护 2 个常驻 Docker 容器。

### 6.1 为什么不继续每次 `docker run`

短命令很常见：

```text
pwd
ls
find src -name '*.js'
grep -R TODO src
```

如果每次都：

```text
创建容器 → 启动容器 → 执行一条短命令 → 销毁容器
```

那么环境准备时间可能比命令本身还长。容器池的想法是：

```text
提前启动少量容器
  → 空闲时放入 idle pool
  → 任务到来时借一个
  → docker exec 执行命令
  → 清理临时现场
  → 归还池
```

### 6.2 池化模式怎么创建容器

池化模式下，第一次需要容器时，`DockerPoolRuntime.create()` 会创建一个后台常驻容器：

```bash
docker run -d --name tiny-harness-pool-<uuid> \
  ...同样的隔离参数... \
  alpine:3.20 \
  sh -c 'while true; do sleep 3600; done'
```

关键变化：

| 普通 DockerBackend | 池化 DockerBackend |
|---|---|
| `docker run --rm` | `docker run -d` |
| 前台等待命令结束 | 后台启动常驻容器 |
| 容器任务结束后自动删除 | 容器由 `ContainerPool` 显式回收 |
| 命令作为容器主进程 | 常驻 `sleep` 循环是主进程 |
| 无后续复用 | 后续用 `docker exec` |

其中：

```text
-d：detached，后台运行
while true; do sleep 3600; done：让容器主进程持续存在
```

如果容器的主进程退出，容器就停止，之后无法 `docker exec`。所以池化容器需要一个简单的长期运行主进程维持存活。

### 6.3 池化模式如何执行命令

借到容器后执行：

```bash
docker exec <container-id> sh -c 'npm test'
```

`docker exec` 的含义是：**在已经运行的容器内额外启动一个进程**。

这与 `docker run` 的区别：

```text
docker run：创建 + 启动一个新容器，并运行主进程
docker exec：不创建容器，在现有运行容器里启动额外进程
```

### 6.4 正常归还、异常销毁

```text
命令成功
  → 尝试 reset 容器
  → 成功：归还 idle pool
  → reset 失败：销毁容器

命令超时 / 被取消 / docker exec 失败
  → 标记 unhealthy
  → docker kill / rm -f
  → ContainerPool 销毁实例
  → 若有 waiter，按需创建 replacement
```

当前 reset 策略非常保守：只清理工作区顶层 `*.tmp`，保留源码和 `.tiny-harness`。这是教学版的取舍：如果清空整个工作区，会把 Coding Agent 的真实修改也删掉。

生产级做法通常不是直接共享用户工作区，而是：

```text
基础代码快照
  → 每任务独立 overlay / snapshot / git worktree
  → 任务结束后丢弃任务层
  → 容器回到干净基线
```

---

## 7. 为理解本项目需要掌握哪些 Docker 基础知识

不需要一上来学习 Kubernetes、containerd 源码或所有 Docker 子命令。针对本项目，建议按下面顺序掌握。

### 第一层：必须会说清的概念

| 概念 | 你至少要理解什么 |
|---|---|
| Image（镜像） | 只读的运行环境模板，如 `alpine:3.20`、`node:22-alpine` |
| Container（容器） | 镜像启动后的运行实例；同一镜像可创建多个容器 |
| Docker daemon | 真正创建/管理容器的后台服务 |
| Docker CLI | 终端里的 `docker` 命令；本项目通过 Node `spawn` 调它 |
| Host（宿主机） | 运行 Docker daemon 的机器/VM；容器运行其上 |
| `docker run` | 创建并启动短生命周期容器 |
| `docker exec` | 在运行中的容器里启动额外进程 |
| `docker rm` | 删除容器 |
| `docker kill` | 强制停止容器 |
| Volume / Bind Mount | 将宿主机目录挂到容器路径，如 `workDir:/workspace:rw` |

### 第二层：需要理解的隔离原理

| Linux 机制 | 在容器中的意义 |
|---|---|
| Namespace | 隔离进程、网络、挂载点、主机名等视图 |
| cgroup | 限制/统计 CPU、内存、PID 等资源 |
| Capability | 将 root 特权拆分；`--cap-drop ALL` 移除能力 |
| 镜像层 / 可写层 | 镜像基础文件只读；容器运行会有临时可写层 |
| Union filesystem | 多个镜像层叠加为容器看到的文件系统视图 |

不必在面试中假装能实现 namespace/cgroup；但要能说清：Docker 是利用这些 Linux 机制给进程加隔离和资源边界。

### 第三层：本项目必须会解释的安全取舍

1. 为什么 `--network none`：默认禁止 Agent 命令联网；
2. 为什么 `--read-only`：防止修改容器根文件系统；
3. 为什么仍挂 `workspace:rw`：Coding Agent 需要修改目标代码；
4. 为什么 `--pids-limit`：防 fork bomb；
5. 为什么 Scheduler 和 Docker 都要有资源限制：Scheduler 保护系统整体，Docker 限制单任务；
6. 为什么 Docker 不等于绝对安全：共享内核、Docker daemon 权限、挂载目录和 runtime 漏洞仍是风险面。

### 第四层：建议亲自操作的命令

下面命令适合在安装 Docker Desktop 并确保 Docker daemon 已启动后执行：

```bash
# 查看 Docker 是否可用
docker info

# 拉取轻量 Linux 镜像
docker pull alpine:3.20

# 创建一次性容器并执行命令
docker run --rm alpine:3.20 sh -c 'echo hello && uname -a'

# 测试禁网容器（应无法访问外部网络）
docker run --rm --network none alpine:3.20 sh -c 'wget -qO- https://example.com'

# 以只读根文件系统运行；/tmp 单独提供可写 tmpfs
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m alpine:3.20 sh -c 'echo ok > /tmp/test && cat /tmp/test'

# 后台启动一个常驻容器
docker run -d --name demo-pool alpine:3.20 sh -c 'while true; do sleep 3600; done'

# 在常驻容器中执行额外命令
docker exec demo-pool sh -c 'echo reused-container'

# 删除常驻容器
docker rm -f demo-pool
```

运行后可查看：

```bash
docker ps -a
docker images
```

### 第五层：适合面试的回答

**问：LocalProcessBackend 和 DockerBackend 有什么区别？**

> LocalProcessBackend 通过 Node 的 `spawn('sh', ['-c', command])` 在宿主机直接运行命令，只有工作目录约束，没有真正隔离。DockerBackend 则通过 `spawn('docker', args)` 调 Docker CLI，由 Docker daemon 基于镜像创建容器，在容器内执行 `sh -c command`；并配置禁网、只读根文件系统、能力剥夺、CPU/内存/PID 限制，实现任务级隔离。

**问：Docker 容器是怎么创建的？**

> 普通模式中，每个 Bash Tool Call 由 DockerBackend 生成唯一容器名并执行 `docker run --rm ... image sh -c command`。`docker run` 会基于镜像创建容器、应用隔离与资源参数、启动容器主进程，命令结束后因 `--rm` 自动删除。池化模式中则先用 `docker run -d` 启动常驻容器，后续任务通过 `docker exec` 复用已有容器，正常结束后 reset 归还，异常则销毁替换。

**问：Docker 是不是虚拟机？**

> 不是。Linux 容器通常共享宿主机内核，主要借助 namespace 和 cgroup 做进程视图隔离和资源限制；虚拟机有自己的 Guest OS 内核，隔离更强但启动和资源开销通常更高。macOS 上 Docker Desktop 会通过一个内部 Linux VM 运行 Linux 容器。

---

## 8. 一张总图

```text
┌─────────────────────────────────────────────────────────┐
│ LocalProcessBackend                                     │
│ Node.js → spawn('sh') → 宿主机 sh → 宿主机命令           │
│ 优点：简单、兼容、启动快                                  │
│ 缺点：没有 OS 级隔离                                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ DockerBackend：普通模式（第二期默认）                     │
│ Node.js → spawn('docker') → docker run --rm              │
│ → 新容器 → 容器 sh -c command → 退出 → 自动删除          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ DockerBackend：池化模式（第三期可选）                     │
│ 首次：docker run -d → 常驻容器                            │
│ 每任务：docker exec → 容器内 sh -c command               │
│ 成功：reset → 归还池；失败：kill / rm → replacement      │
└─────────────────────────────────────────────────────────┘
```

一句话总结：

> LocalProcessBackend 是“直接在宿主机开 Shell 进程”；DockerBackend 是“Node 启动 Docker CLI，由 Docker daemon 用镜像创建受限容器，再在容器中执行 Shell”。第二期默认一任务一容器，第三期才可选地把容器改为池化复用。
