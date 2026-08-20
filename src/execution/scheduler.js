// ===========================================
// execution/scheduler.js
// ===========================================
// 本地执行调度器：将“收到 bash 调用就立即 spawn”改为
// “任务入队 → 配额准入 → 执行 → 状态/指标归档”。
//
// 这是单进程、本机版本：不负责容器隔离或跨机器调度，
// 但为后续 DockerBackend / 远程 Worker 保留统一任务边界。
// ===========================================

import { randomUUID } from 'node:crypto';
import { addTraceEvent } from '../observability/trace.js';

export const ExecutionStatus = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  QUEUE_TIMEOUT: 'QUEUE_TIMEOUT',
});

const TERMINAL_STATUSES = new Set([
  ExecutionStatus.SUCCEEDED,
  ExecutionStatus.FAILED,
  ExecutionStatus.CANCELLED,
  ExecutionStatus.QUEUE_TIMEOUT,
]);

export class ExecutionScheduler {
  constructor({ maxConcurrent = 4, maxPerSession = 2, maxPerAgent = 2, maxQueueWaitMs = 30_000 } = {}) {
    validatePositiveInteger('maxConcurrent', maxConcurrent);
    validatePositiveInteger('maxPerSession', maxPerSession);
    validatePositiveInteger('maxPerAgent', maxPerAgent);
    validatePositiveInteger('maxQueueWaitMs', maxQueueWaitMs);

    this.limits = { maxConcurrent, maxPerSession, maxPerAgent, maxQueueWaitMs };
    this.pending = [];
    this.jobs = new Map();
    this.running = 0;
    this.runningBySession = new Map();
    this.runningByAgent = new Map();
    this.metrics = {
      submitted: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      queueTimedOut: 0,
      totalQueueWaitMs: 0,
      totalRunMs: 0,
    };
  }

  submit({ sessionId = 'default', agentId = 'default', label = 'execution', run }) {
    if (typeof run !== 'function') throw new Error('执行任务必须提供 run(signal) 函数');
    const job = {
      id: randomUUID(),
      sessionId,
      agentId,
      label,
      status: ExecutionStatus.PENDING,
      submittedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      queueWaitMs: null,
      runMs: null,
      controller: new AbortController(),
      resolve: null,
      reject: null,
      queueTimer: null,
      promise: null,
      run,
    };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.queueTimer = setTimeout(() => {
      if (job.status !== ExecutionStatus.PENDING) return;
      this._finish(job, ExecutionStatus.QUEUE_TIMEOUT, new Error(`任务排队超过 ${this.limits.maxQueueWaitMs}ms，已被拒绝`));
    }, this.limits.maxQueueWaitMs);

    this.jobs.set(job.id, job);
    this.pending.push(job);
    this.metrics.submitted++;
    addTraceEvent('execution.queued', { jobId: job.id, label, sessionId, agentId });
    this._drain();
    return job;
  }

  cancel(jobId, reason = '任务被取消') {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return false;
    if (job.status === ExecutionStatus.PENDING) {
      this._finish(job, ExecutionStatus.CANCELLED, new Error(reason));
      return true;
    }
    job.controller.abort(new Error(reason));
    return true;
  }

  getSnapshot() {
    const completed = this.metrics.succeeded + this.metrics.failed + this.metrics.cancelled + this.metrics.queueTimedOut;
    return {
      limits: { ...this.limits },
      queued: this.pending.filter((job) => job.status === ExecutionStatus.PENDING).length,
      running: this.running,
      metrics: {
        ...this.metrics,
        averageQueueWaitMs: this.metrics.started ? Math.round(this.metrics.totalQueueWaitMs / this.metrics.started) : 0,
        averageRunMs: completed ? Math.round(this.metrics.totalRunMs / completed) : 0,
      },
    };
  }

  _drain() {
    let startedAny = true;
    while (startedAny && this.running < this.limits.maxConcurrent) {
      startedAny = false;
      const next = this.pending.find((job) => job.status === ExecutionStatus.PENDING && this._canRun(job));
      if (next) {
        this._start(next);
        startedAny = true;
      }
    }
  }

  _canRun(job) {
    return (this.runningBySession.get(job.sessionId) || 0) < this.limits.maxPerSession
      && (this.runningByAgent.get(job.agentId) || 0) < this.limits.maxPerAgent;
  }

  _start(job) {
    job.status = ExecutionStatus.RUNNING;
    job.startedAt = Date.now();
    job.queueWaitMs = job.startedAt - job.submittedAt;
    clearTimeout(job.queueTimer);
    this.running++;
    increment(this.runningBySession, job.sessionId);
    increment(this.runningByAgent, job.agentId);
    this.metrics.started++;
    this.metrics.totalQueueWaitMs += job.queueWaitMs;
    addTraceEvent('execution.started', { jobId: job.id, label: job.label, queueWaitMs: job.queueWaitMs });

    Promise.resolve()
      .then(() => job.run(job.controller.signal))
      .then((output) => this._finish(job, ExecutionStatus.SUCCEEDED, output))
      .catch((error) => {
        const status = job.controller.signal.aborted ? ExecutionStatus.CANCELLED : ExecutionStatus.FAILED;
        this._finish(job, status, error);
      });
  }

  _finish(job, status, value) {
    if (TERMINAL_STATUSES.has(job.status)) return;
    const wasRunning = job.status === ExecutionStatus.RUNNING;
    job.status = status;
    job.finishedAt = Date.now();
    job.runMs = job.startedAt ? job.finishedAt - job.startedAt : 0;
    clearTimeout(job.queueTimer);
    if (wasRunning) {
      this.running--;
      decrement(this.runningBySession, job.sessionId);
      decrement(this.runningByAgent, job.agentId);
      this.metrics.totalRunMs += job.runMs;
    }
    if (status === ExecutionStatus.SUCCEEDED) this.metrics.succeeded++;
    if (status === ExecutionStatus.FAILED) this.metrics.failed++;
    if (status === ExecutionStatus.CANCELLED) this.metrics.cancelled++;
    if (status === ExecutionStatus.QUEUE_TIMEOUT) this.metrics.queueTimedOut++;
    addTraceEvent('execution.finished', { jobId: job.id, label: job.label, status, queueWaitMs: job.queueWaitMs, runMs: job.runMs });

    if (status === ExecutionStatus.SUCCEEDED) job.resolve(value);
    else job.reject(value instanceof Error ? value : new Error(String(value)));
    this._drain();
  }
}

function increment(counter, key) { counter.set(key, (counter.get(key) || 0) + 1); }
function decrement(counter, key) {
  const next = (counter.get(key) || 1) - 1;
  if (next <= 0) counter.delete(key);
  else counter.set(key, next);
}
function validatePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
}
