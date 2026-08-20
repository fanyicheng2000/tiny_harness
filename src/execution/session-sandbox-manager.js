// Session 是有状态 Sandbox 的边界：同一 session 复用容器和工作区；
// 不同 session 不共享容器。创建采用 single-flight，并在空闲 TTL 后回收。

export class SessionSandboxManager {
  constructor({ runtime, imageManager, image, idleTtlMs = 30 * 60_000, clock = () => Date.now(), timers = globalThis } = {}) {
    if (!runtime || typeof runtime.create !== 'function' || typeof runtime.destroy !== 'function') {
      throw new Error('SessionSandboxManager 需要包含 create(request) 和 destroy(sandbox) 的 runtime');
    }
    if (!imageManager || typeof imageManager.ensureImage !== 'function') throw new Error('SessionSandboxManager 需要 imageManager');
    if (typeof image !== 'string' || !image.trim()) throw new Error('image 必须是非空字符串');
    if (!Number.isInteger(idleTtlMs) || idleTtlMs <= 0) throw new Error('idleTtlMs 必须是正整数');
    this.runtime = runtime;
    this.imageManager = imageManager;
    this.image = image;
    this.idleTtlMs = idleTtlMs;
    this.clock = clock;
    this.timers = timers;
    this.sandboxes = new Map();
    this.creating = new Map();
    this.metrics = { created: 0, reused: 0, released: 0, expired: 0, creationJoins: 0 };
  }

  async acquire({ sessionId, workDir, resources = null }) {
    validateRequest({ sessionId, workDir });
    const existing = this.sandboxes.get(sessionId);
    if (existing) {
      this.metrics.reused++;
      this._touch(existing);
      return existing;
    }
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
  }

  async execute({ sessionId, workDir, resources = null, run }) {
    if (typeof run !== 'function') throw new Error('execute 需要 run(sandbox) 函数');
    const sandbox = await this.acquire({ sessionId, workDir, resources });
    this._touch(sandbox);
    const execution = sandbox.tail.then(() => run(sandbox));
    sandbox.tail = execution.catch(() => {});
    return execution;
  }

  async release(sessionId, reason = 'released') {
    const sandbox = this.sandboxes.get(sessionId);
    if (!sandbox) return false;
    this.sandboxes.delete(sessionId);
    if (sandbox.timer) this.timers.clearTimeout(sandbox.timer);
    await this.runtime.destroy(sandbox, reason);
    this.metrics.released++;
    return true;
  }

  async shutdown() {
    await Promise.all([...this.sandboxes.keys()].map((sessionId) => this.release(sessionId, 'shutdown')));
  }

  getSnapshot() {
    return {
      image: this.image,
      active: [...this.sandboxes.values()].map(({ timer, ...sandbox }) => ({ ...sandbox })),
      creatingSessionIds: [...this.creating.keys()],
      metrics: { ...this.metrics },
    };
  }

  async _create({ sessionId, workDir, resources }) {
    await this.imageManager.ensureImage(this.image);
    const sandbox = {
      ...(await this.runtime.create({ sessionId, workDir, image: this.image, resources })),
      sessionId,
      workDir,
      image: this.image,
      createdAt: this.clock(),
      lastUsedAt: this.clock(),
      timer: null,
      tail: Promise.resolve(),
    };
    this.sandboxes.set(sessionId, sandbox);
    this.metrics.created++;
    this._touch(sandbox);
    return sandbox;
  }

  _touch(sandbox) {
    sandbox.lastUsedAt = this.clock();
    if (sandbox.timer) this.timers.clearTimeout(sandbox.timer);
    sandbox.timer = this.timers.setTimeout(() => {
      // 旧 Sandbox 的延迟回调不能误删同 Session 后续新建的实例。
      if (this.sandboxes.get(sandbox.sessionId) !== sandbox) return;
      this.release(sandbox.sessionId, 'idle-timeout').then(() => { this.metrics.expired++; }).catch(() => {});
    }, this.idleTtlMs);
  }
}

function validateRequest({ sessionId, workDir }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId 必须是非空字符串');
  if (typeof workDir !== 'string' || !workDir.trim()) throw new Error('workDir 必须是非空字符串');
}
