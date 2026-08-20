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
    process.env.TINY_HARNESS_DOCKER_POOL_SIZE || '0',
    process.env.TINY_HARNESS_SESSION_SANDBOX || 'true',
    process.env.TINY_HARNESS_SANDBOX_IDLE_TTL_MS || '1800000',
    process.env.TINY_HARNESS_DOCKER_PRELOAD_IMAGES || '',
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
    poolSize: readNonNegativeInt('TINY_HARNESS_DOCKER_POOL_SIZE', 0),
    sessionSandbox: readBoolean('TINY_HARNESS_SESSION_SANDBOX', true),
    sandboxIdleTtlMs: readPositiveInt('TINY_HARNESS_SANDBOX_IDLE_TTL_MS', 30 * 60_000),
  });
  if (cachedBackend.name === 'docker') {
    const images = readCsv('TINY_HARNESS_DOCKER_PRELOAD_IMAGES');
    if (images.length) cachedBackend.preloadImages(images).catch(() => {});
  }
  return cachedBackend;
}

function readCsv(name) {
  return (process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function readNonNegativeInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readPositiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
