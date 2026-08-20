// ===========================================
// execution/backend.js
// ===========================================
// ExecutionBackend 是 Scheduler 之后的执行抽象：
// Scheduler 决定“何时可以运行”，Backend 决定“在哪里运行”。
// 第一阶段 LocalProcessBackend 使用宿主机 sh；第二阶段
// DockerBackend 用受限容器执行同一条命令。
// ===========================================

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ContainerPool } from './container-pool.js';

export const DEFAULT_MAX_OUTPUT_BYTES = 8000;

export class LocalProcessBackend {
  constructor({ timeoutMs = 30_000, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
    this.name = 'local';
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  execute({ command, workDir, signal }) {
    return runCommand({
      program: 'sh',
      args: ['-c', command],
      cwd: workDir,
      env: process.env,
      signal,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      stop: (child) => child.kill('SIGKILL'),
    });
  }
}

export class DockerBackend {
  constructor({
    image = 'alpine:3.20',
    timeoutMs = 30_000,
    memory = '512m',
    cpus = '1',
    pidsLimit = 128,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    dockerBin = 'docker',
    poolSize = 0,
  } = {}) {
    validateDockerOptions({ image, timeoutMs, memory, cpus, pidsLimit, maxOutputBytes, dockerBin });
    this.name = 'docker';
    this.image = image;
    this.timeoutMs = timeoutMs;
    this.memory = memory;
    this.cpus = cpus;
    this.pidsLimit = pidsLimit;
    this.maxOutputBytes = maxOutputBytes;
    this.dockerBin = dockerBin;
    if (!Number.isInteger(poolSize) || poolSize < 0) throw new Error('poolSize 必须是非负整数');
    this.poolSize = poolSize;
    this.pools = new Map();
  }

  buildArgs({ command, workDir, containerName, resources = null }) {
    const memory = resources?.memoryMb ? `${resources.memoryMb}m` : this.memory;
    const cpus = resources?.cpuMillis ? String(resources.cpuMillis / 1000) : this.cpus;
    return [
      'run', '--rm', '--name', containerName,
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--pids-limit', String(this.pidsLimit),
      '--memory', memory,
      '--cpus', cpus,
      '--workdir', '/workspace',
      // Agent 需要读写任务工作区；容器其他文件系统保持只读。
      '--volume', `${workDir}:/workspace:rw`,
      this.image,
      'sh', '-c', command,
    ];
  }

  execute({ command, workDir, signal, resources = null }) {
    if (this.poolSize > 0) return this._executePooled({ command, workDir, signal, resources });
    const containerName = `tiny-harness-${randomUUID()}`;
    return runCommand({
      program: this.dockerBin,
      args: this.buildArgs({ command, workDir, containerName, resources }),
      cwd: workDir,
      env: process.env,
      signal,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      stop: async (child) => {
        child.kill('SIGKILL');
        await runBestEffort(this.dockerBin, ['kill', containerName]);
        await runBestEffort(this.dockerBin, ['rm', '-f', containerName]);
      },
    });
  }

  async _executePooled({ command, workDir, signal, resources }) {
    const pool = this._getPool(workDir);
    const container = await pool.acquire();
    let healthy = true;
    try {
      return await runCommand({
        program: this.dockerBin,
        args: ['exec', container.id, 'sh', '-c', command],
        cwd: workDir, env: process.env, signal, timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes,
        stop: async (child) => { child.kill('SIGKILL'); healthy = false; await runBestEffort(this.dockerBin, ['kill', container.id]); },
      });
    } catch (error) {
      healthy = false;
      throw error;
    } finally {
      await pool.release(container, { healthy });
    }
  }

  _getPool(workDir) {
    if (this.pools.has(workDir)) return this.pools.get(workDir);
    const runtime = new DockerPoolRuntime({ backend: this, workDir });
    const pool = new ContainerPool({ runtime, image: this.image, size: this.poolSize });
    this.pools.set(workDir, pool);
    return pool;
  }

  getPoolSnapshots() { return [...this.pools.values()].map((pool) => pool.getSnapshot()); }
}

class DockerPoolRuntime {
  constructor({ backend, workDir }) { this.backend = backend; this.workDir = workDir; }

  async create() {
    const args = this.backend.buildArgs({
      command: 'while true; do sleep 3600; done', workDir: this.workDir, containerName: `tiny-harness-pool-${randomUUID()}`,
    });
    // 常规任务 `run --rm` 前台执行；池实例需要后台常驻且由 pool 显式回收。
    args.splice(args.indexOf('--rm'), 1);
    args.splice(1, 0, '-d');
    const id = await runCommand({
      program: this.backend.dockerBin, args,
      cwd: this.workDir, env: process.env, timeoutMs: this.backend.timeoutMs, maxOutputBytes: 1024,
      stop: (child) => child.kill('SIGKILL'),
    });
    return { id: id.trim() };
  }

  async reset(container) {
    await runCommand({ program: this.backend.dockerBin, args: ['exec', container.id, 'sh', '-c', 'find /workspace -mindepth 1 -maxdepth 1 -name .tiny-harness -prune -o -type f -name "*.tmp" -delete'], cwd: this.workDir, env: process.env, timeoutMs: this.backend.timeoutMs, maxOutputBytes: 1024, stop: (child) => child.kill('SIGKILL') });
  }

  async destroy(container) { await runBestEffort(this.backend.dockerBin, ['rm', '-f', container.id]); }
}

export function createExecutionBackend({ kind = 'local', ...options } = {}) {
  if (kind === 'local') return new LocalProcessBackend(options);
  if (kind === 'docker') return new DockerBackend(options);
  throw new Error(`不支持的执行后端: ${kind}，仅支持 local 或 docker`);
}

export async function isDockerAvailable(dockerBin = 'docker') {
  try {
    await runCommand({ program: dockerBin, args: ['info'], timeoutMs: 3_000, maxOutputBytes: 1024 });
    return true;
  } catch {
    return false;
  }
}

function runCommand({ program, args, cwd, env, signal, timeoutMs, maxOutputBytes, stop }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const stopProcess = async (reason) => {
      try {
        await stop(child);
      } finally {
        reject(new Error(`${formatOutput(stdout, stderr, maxOutputBytes)}\n${reason}`));
      }
    };
    const onAbort = () => finish(() => stopProcess(`[⚠️ ${signal.reason?.message || '任务被调度器取消'}]`));
    const timer = setTimeout(() => finish(() => stopProcess(`[⚠️ 命令超过 ${timeoutMs}ms 未结束，已被强制终止]`)), timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr?.on('data', (chunk) => { stderr = Buffer.concat([stderr, chunk]); });
    child.on('close', (code) => finish(() => {
      const output = formatOutput(stdout, stderr, maxOutputBytes);
      if (code !== 0) reject(new Error(`${output}\n[退出码: ${code}]`));
      else resolve(output || '[命令执行成功，无输出]');
    }));
    child.on('error', (err) => finish(() => reject(new Error(`[执行失败] ${err.message}`))));
  });
}

function runBestEffort(program, args) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: 'ignore' });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

export function formatOutput(stdout, stderr, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  let text = '';
  if (stdout.length > 0) text += stdout.toString('utf8');
  if (stderr.length > 0) text += `${text ? '\n' : ''}[stderr]\n${stderr.toString('utf8')}`;
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length > maxOutputBytes) {
    const half = Math.floor(maxOutputBytes / 2);
    const head = encoded.subarray(0, half).toString('utf8');
    const tail = encoded.subarray(encoded.length - half).toString('utf8');
    return `${head}\n\n...[输出超过 ${maxOutputBytes} 字节，中间 ${encoded.length - maxOutputBytes} 字节已被截断]...\n\n${tail}`;
  }
  return text;
}

function validateDockerOptions({ image, timeoutMs, memory, cpus, pidsLimit, maxOutputBytes, dockerBin }) {
  if (typeof image !== 'string' || !image.trim()) throw new Error('Docker image 必须是非空字符串');
  if (typeof memory !== 'string' || !memory.trim()) throw new Error('Docker memory 必须是非空字符串');
  if (typeof cpus !== 'string' || !cpus.trim()) throw new Error('Docker cpus 必须是非空字符串');
  if (typeof dockerBin !== 'string' || !dockerBin.trim()) throw new Error('dockerBin 必须是非空字符串');
  for (const [name, value] of Object.entries({ timeoutMs, pidsLimit, maxOutputBytes })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  }
}
