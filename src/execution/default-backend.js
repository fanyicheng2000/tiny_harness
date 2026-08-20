import { createExecutionBackend } from './backend.js';

// 延迟创建：CLI 会在 main() 内先加载 .env，再构造 BashTool；
// 因此不能在模块 import 时就读取环境变量。
let cachedBackend = null;
let cachedSignature = null;

export function getDefaultExecutionBackend() {
  const signature = [
    process.env.TINY_HARNESS_EXECUTION_BACKEND || 'local',
    process.env.TINY_HARNESS_DOCKER_IMAGE || 'alpine:3.20',
    process.env.TINY_HARNESS_EXECUTION_TIMEOUT_MS || '30000',
    process.env.TINY_HARNESS_DOCKER_MEMORY || '512m',
    process.env.TINY_HARNESS_DOCKER_CPUS || '1',
    process.env.TINY_HARNESS_DOCKER_PIDS_LIMIT || '128',
    process.env.TINY_HARNESS_MAX_EXECUTION_OUTPUT_BYTES || '8000',
  ].join('|');
  if (cachedBackend && cachedSignature === signature) return cachedBackend;

  cachedSignature = signature;
  cachedBackend = createExecutionBackend({
    kind: process.env.TINY_HARNESS_EXECUTION_BACKEND || 'local',
    image: process.env.TINY_HARNESS_DOCKER_IMAGE || 'alpine:3.20',
    timeoutMs: readPositiveInt('TINY_HARNESS_EXECUTION_TIMEOUT_MS', 30_000),
    memory: process.env.TINY_HARNESS_DOCKER_MEMORY || '512m',
    cpus: process.env.TINY_HARNESS_DOCKER_CPUS || '1',
    pidsLimit: readPositiveInt('TINY_HARNESS_DOCKER_PIDS_LIMIT', 128),
    maxOutputBytes: readPositiveInt('TINY_HARNESS_MAX_EXECUTION_OUTPUT_BYTES', 8000),
  });
  return cachedBackend;
}

function readPositiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
