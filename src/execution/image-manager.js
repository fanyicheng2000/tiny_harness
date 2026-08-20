// 镜像供应层：复用 Docker 本地镜像缓存，并把同一镜像的并发拉取合并为一次。
// Docker/OverlayFS 负责物理只读 Layer 共享；这里负责镜像就绪状态与启动预热。

export class ImageManager {
  constructor({ runtime, clock = () => Date.now() } = {}) {
    if (!runtime || typeof runtime.exists !== 'function' || typeof runtime.pull !== 'function') {
      throw new Error('ImageManager 需要包含 exists(image) 和 pull(image) 的 runtime');
    }
    this.runtime = runtime;
    this.clock = clock;
    this.ready = new Map();
    this.loading = new Map();
    this.metrics = { checks: 0, localHits: 0, pulls: 0, joinedLoads: 0, preloadRequests: 0 };
  }

  async ensureImage(image) {
    validateImage(image);
    if (this.ready.has(image)) {
      this.metrics.localHits++;
      this.ready.get(image).lastUsedAt = this.clock();
      return { image, source: 'memory-cache' };
    }
    if (this.loading.has(image)) {
      this.metrics.joinedLoads++;
      return this.loading.get(image);
    }

    const loading = this._ensure(image);
    this.loading.set(image, loading);
    try {
      return await loading;
    } finally {
      this.loading.delete(image);
    }
  }

  async preload(images) {
    if (!Array.isArray(images)) throw new Error('preload images 必须是数组');
    this.metrics.preloadRequests += images.length;
    return Promise.all(images.map((image) => this.ensureImage(image)));
  }

  invalidate(image) {
    this.ready.delete(image);
  }

  getSnapshot() {
    return {
      readyImages: [...this.ready.entries()].map(([image, value]) => ({ image, ...value })),
      loadingImages: [...this.loading.keys()],
      metrics: { ...this.metrics },
    };
  }

  async _ensure(image) {
    this.metrics.checks++;
    const exists = await this.runtime.exists(image);
    if (!exists) {
      this.metrics.pulls++;
      await this.runtime.pull(image);
    } else {
      this.metrics.localHits++;
    }
    const readyAt = this.clock();
    this.ready.set(image, { readyAt, lastUsedAt: readyAt });
    return { image, source: exists ? 'docker-local-cache' : 'pulled' };
  }
}

function validateImage(image) {
  if (typeof image !== 'string' || !image.trim()) throw new Error('image 必须是非空字符串');
}
