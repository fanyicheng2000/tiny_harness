import { ExecutionScheduler } from './scheduler.js';

export const defaultExecutionScheduler = new ExecutionScheduler({
  maxConcurrent: readPositiveInt('TINY_HARNESS_MAX_EXECUTIONS', 4),
  maxPerSession: readPositiveInt('TINY_HARNESS_MAX_EXECUTIONS_PER_SESSION', 2),
  maxPerAgent: readPositiveInt('TINY_HARNESS_MAX_EXECUTIONS_PER_AGENT', 2),
  maxQueueWaitMs: readPositiveInt('TINY_HARNESS_MAX_QUEUE_WAIT_MS', 30_000),
  totalCpuMillis: readPositiveInt('TINY_HARNESS_TOTAL_CPU_MILLIS', 4000),
  totalMemoryMb: readPositiveInt('TINY_HARNESS_TOTAL_MEMORY_MB', 4096),
});

function readPositiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
