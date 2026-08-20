import { randomUUID } from 'node:crypto';
import { addTraceEvent } from '../observability/trace.js';

export const ExecutionStatus = Object.freeze({
  PENDING: 'PENDING', RUNNING: 'RUNNING', SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED',
  CANCELLED: 'CANCELLED', QUEUE_TIMEOUT: 'QUEUE_TIMEOUT', RESOURCE_REJECTED: 'RESOURCE_REJECTED',
});
const TERMINAL_STATUSES = new Set(Object.values(ExecutionStatus).filter((status) => status !== ExecutionStatus.PENDING && status !== ExecutionStatus.RUNNING));
const DEFAULT_RESOURCES = Object.freeze({ cpuMillis: 1000, memoryMb: 512 });

// 单进程调度控制面：同时对“执行槽位”和“声明资源预算”做准入。
export class ExecutionScheduler {
  constructor({
    maxConcurrent = 4, maxPerSession = 2, maxPerAgent = 2, maxQueueWaitMs = 30_000,
    totalCpuMillis = 4000, totalMemoryMb = 4096,
  } = {}) {
    for (const [name, value] of Object.entries({ maxConcurrent, maxPerSession, maxPerAgent, maxQueueWaitMs, totalCpuMillis, totalMemoryMb })) validatePositiveInteger(name, value);
    this.limits = { maxConcurrent, maxPerSession, maxPerAgent, maxQueueWaitMs, totalCpuMillis, totalMemoryMb };
    this.pending = [];
    this.jobs = new Map();
    this.running = 0;
    this.runningBySession = new Map();
    this.runningByAgent = new Map();
    this.allocated = { cpuMillis: 0, memoryMb: 0 };
    this.metrics = { submitted: 0, started: 0, succeeded: 0, failed: 0, cancelled: 0, queueTimedOut: 0, resourceRejected: 0, totalQueueWaitMs: 0, totalRunMs: 0 };
  }

  submit({ sessionId = 'default', agentId = 'default', label = 'execution', priority = 0, resources = DEFAULT_RESOURCES, run }) {
    if (typeof run !== 'function') throw new Error('执行任务必须提供 run(signal) 函数');
    const normalized = normalizeResources(resources);
    if (normalized.cpuMillis > this.limits.totalCpuMillis || normalized.memoryMb > this.limits.totalMemoryMb) {
      const job = this._newJob({ sessionId, agentId, label, priority, resources: normalized, run });
      this.jobs.set(job.id, job);
      this.metrics.submitted++;
      this._finish(job, ExecutionStatus.RESOURCE_REJECTED, new Error(`任务资源规格 CPU ${normalized.cpuMillis}m / 内存 ${normalized.memoryMb}MB 超过集群单任务容量`));
      return job;
    }
    const job = this._newJob({ sessionId, agentId, label, priority, resources: normalized, run });
    job.queueTimer = setTimeout(() => {
      if (job.status === ExecutionStatus.PENDING) this._finish(job, ExecutionStatus.QUEUE_TIMEOUT, new Error(`任务排队超过 ${this.limits.maxQueueWaitMs}ms，已被拒绝`));
    }, this.limits.maxQueueWaitMs);
    this.jobs.set(job.id, job);
    this.pending.push(job);
    this.metrics.submitted++;
    addTraceEvent('execution.queued', { jobId: job.id, label, sessionId, agentId, priority, resources: normalized });
    this._drain();
    return job;
  }

  cancel(jobId, reason = '任务被取消') {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return false;
    if (job.status === ExecutionStatus.PENDING) this._finish(job, ExecutionStatus.CANCELLED, new Error(reason));
    else job.controller.abort(new Error(reason));
    return true;
  }

  getSnapshot() {
    const completed = this.metrics.succeeded + this.metrics.failed + this.metrics.cancelled + this.metrics.queueTimedOut + this.metrics.resourceRejected;
    return {
      limits: { ...this.limits }, allocated: { ...this.allocated }, queued: this.pending.filter((job) => job.status === ExecutionStatus.PENDING).length, running: this.running,
      metrics: { ...this.metrics, averageQueueWaitMs: this.metrics.started ? Math.round(this.metrics.totalQueueWaitMs / this.metrics.started) : 0, averageRunMs: completed ? Math.round(this.metrics.totalRunMs / completed) : 0 },
    };
  }

  _newJob({ sessionId, agentId, label, priority, resources, run }) {
    const job = { id: randomUUID(), sessionId, agentId, label, priority: normalizePriority(priority), resources, status: ExecutionStatus.PENDING, submittedAt: Date.now(), startedAt: null, finishedAt: null, queueWaitMs: null, runMs: null, controller: new AbortController(), resolve: null, reject: null, queueTimer: null, promise: null, run };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    return job;
  }

  _drain() {
    while (this.running < this.limits.maxConcurrent) {
      const eligible = this.pending.filter((job) => job.status === ExecutionStatus.PENDING && this._canRun(job));
      if (!eligible.length) return;
      // 高优任务优先；同优先级维持提交顺序，避免低优任务随机饿死。
      eligible.sort((a, b) => b.priority - a.priority || a.submittedAt - b.submittedAt);
      this._start(eligible[0]);
    }
  }

  _canRun(job) {
    return (this.runningBySession.get(job.sessionId) || 0) < this.limits.maxPerSession
      && (this.runningByAgent.get(job.agentId) || 0) < this.limits.maxPerAgent
      && this.allocated.cpuMillis + job.resources.cpuMillis <= this.limits.totalCpuMillis
      && this.allocated.memoryMb + job.resources.memoryMb <= this.limits.totalMemoryMb;
  }

  _start(job) {
    job.status = ExecutionStatus.RUNNING; job.startedAt = Date.now(); job.queueWaitMs = job.startedAt - job.submittedAt; clearTimeout(job.queueTimer);
    this.running++; increment(this.runningBySession, job.sessionId); increment(this.runningByAgent, job.agentId);
    this.allocated.cpuMillis += job.resources.cpuMillis; this.allocated.memoryMb += job.resources.memoryMb;
    this.metrics.started++; this.metrics.totalQueueWaitMs += job.queueWaitMs;
    addTraceEvent('execution.started', { jobId: job.id, label: job.label, priority: job.priority, resources: job.resources, queueWaitMs: job.queueWaitMs });
    Promise.resolve().then(() => job.run(job.controller.signal)).then((output) => this._finish(job, ExecutionStatus.SUCCEEDED, output)).catch((error) => this._finish(job, job.controller.signal.aborted ? ExecutionStatus.CANCELLED : ExecutionStatus.FAILED, error));
  }

  _finish(job, status, value) {
    if (TERMINAL_STATUSES.has(job.status)) return;
    const wasRunning = job.status === ExecutionStatus.RUNNING;
    job.status = status; job.finishedAt = Date.now(); job.runMs = job.startedAt ? job.finishedAt - job.startedAt : 0; clearTimeout(job.queueTimer);
    if (wasRunning) {
      this.running--; decrement(this.runningBySession, job.sessionId); decrement(this.runningByAgent, job.agentId);
      this.allocated.cpuMillis -= job.resources.cpuMillis; this.allocated.memoryMb -= job.resources.memoryMb; this.metrics.totalRunMs += job.runMs;
    }
    if (status === ExecutionStatus.SUCCEEDED) this.metrics.succeeded++;
    if (status === ExecutionStatus.FAILED) this.metrics.failed++;
    if (status === ExecutionStatus.CANCELLED) this.metrics.cancelled++;
    if (status === ExecutionStatus.QUEUE_TIMEOUT) this.metrics.queueTimedOut++;
    if (status === ExecutionStatus.RESOURCE_REJECTED) this.metrics.resourceRejected++;
    addTraceEvent('execution.finished', { jobId: job.id, label: job.label, status, resources: job.resources, queueWaitMs: job.queueWaitMs, runMs: job.runMs });
    if (status === ExecutionStatus.SUCCEEDED) job.resolve(value); else job.reject(value instanceof Error ? value : new Error(String(value)));
    this._drain();
  }
}

function normalizeResources(resources) {
  const result = { cpuMillis: resources?.cpuMillis ?? DEFAULT_RESOURCES.cpuMillis, memoryMb: resources?.memoryMb ?? DEFAULT_RESOURCES.memoryMb };
  validatePositiveInteger('resources.cpuMillis', result.cpuMillis); validatePositiveInteger('resources.memoryMb', result.memoryMb); return result;
}
function normalizePriority(priority) { if (!Number.isInteger(priority)) throw new Error('priority 必须是整数'); return priority; }
function increment(counter, key) { counter.set(key, (counter.get(key) || 0) + 1); }
function decrement(counter, key) { const next = (counter.get(key) || 1) - 1; if (next <= 0) counter.delete(key); else counter.set(key, next); }
function validatePositiveInteger(name, value) { if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`); }
