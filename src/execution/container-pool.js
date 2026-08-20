// 轻量 Docker 容器池：复用已启动的容器，任务结束后清理工作区再归还。
// Docker 不可用时不会被默认后端启用；该类可通过 fake runtime 做单元测试。

export class ContainerPool {
  constructor({ runtime, image, size = 2, idleTtlMs = 300_000 }) {
    if (!runtime) throw new Error('ContainerPool 需要 runtime');
    if (!image) throw new Error('ContainerPool 需要 image');
    if (!Number.isInteger(size) || size <= 0) throw new Error('size 必须是正整数');
    this.runtime = runtime;
    this.image = image;
    this.size = size;
    this.idleTtlMs = idleTtlMs;
    this.idle = [];
    this.waiters = [];
    this.created = 0;
    this.metrics = { created: 0, borrowed: 0, reused: 0, released: 0, destroyed: 0, waiters: 0 };
  }

  async warm() {
    while (this.created < this.size) this.idle.push(await this._create());
  }

  async acquire() {
    if (this.idle.length) {
      const container = this.idle.shift();
      this.metrics.borrowed++; this.metrics.reused++;
      return container;
    }
    if (this.created < this.size) {
      const container = await this._create();
      this.metrics.borrowed++;
      return container;
    }
    return new Promise((resolve) => { this.waiters.push(resolve); this.metrics.waiters = this.waiters.length; });
  }

  async release(container, { healthy = true } = {}) {
    if (!container) return;
    if (!healthy) return this.destroy(container);
    try {
      await this.runtime.reset(container);
    } catch {
      return this.destroy(container);
    }
    this.metrics.released++;
    const waiter = this.waiters.shift(); this.metrics.waiters = this.waiters.length;
    if (waiter) { this.metrics.borrowed++; waiter(container); } else this.idle.push(container);
  }

  async destroy(container) {
    this.created = Math.max(0, this.created - 1); this.metrics.destroyed++;
    await this.runtime.destroy(container);
    const waiter = this.waiters.shift(); this.metrics.waiters = this.waiters.length;
    if (waiter) { const replacement = await this._create(); this.metrics.borrowed++; waiter(replacement); }
  }

  getSnapshot() { return { image: this.image, size: this.size, created: this.created, idle: this.idle.length, ...this.metrics }; }

  async _create() {
    const container = await this.runtime.create({ image: this.image });
    this.created++; this.metrics.created++;
    return container;
  }
}
