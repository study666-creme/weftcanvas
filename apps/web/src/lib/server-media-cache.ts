// 有界、低优先级的空闲队列，用于把非关键写盘推迟到没有视口/节点手势时执行。
// 手势期间只维持一个有限的轮询重试计时器；队列按 key 去重并设上限，绝不无界增长。

export type MediaCacheIdleHooks = {
  isGestureActive: () => boolean;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
};

type PendingWrite = {
  run: () => Promise<boolean>;
  settled: boolean;
  settle: (ok: boolean) => void;
};

const DEFAULT_MAX_PENDING = 64;
const DEFAULT_RETRY_MS = 250;

export class MediaCacheIdleQueue {
  private readonly pending = new Map<string, PendingWrite>();
  private processing = false;
  private retryTimer: number | null = null;

  constructor(
    private readonly hooks: MediaCacheIdleHooks,
    private readonly maxPending = DEFAULT_MAX_PENDING,
    private readonly retryMs = DEFAULT_RETRY_MS,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  enqueue(key: string, run: () => Promise<boolean>): Promise<boolean> {
    let settle!: (ok: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.pending.set(key, { run, settled: false, settle });
    this.evictIfNeeded();
    this.schedule();
    return promise;
  }

  clear(): void {
    this.cancelRetry();
    for (const entry of this.pending.values()) {
      if (!entry.settled) {
        entry.settled = true;
        entry.settle(false);
      }
    }
    this.pending.clear();
  }

  private evictIfNeeded(): void {
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.pending.get(oldest)!;
      this.pending.delete(oldest);
      if (!entry.settled) {
        entry.settled = true;
        entry.settle(false);
      }
    }
  }

  private schedule(): void {
    if (this.processing) return;
    if (this.pending.size === 0) return;
    if (this.hooks.isGestureActive()) {
      this.armRetry();
      return;
    }
    void this.process();
  }

  private armRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = this.hooks.setTimeout(() => {
      this.retryTimer = null;
      this.schedule();
    }, this.retryMs);
  }

  private cancelRetry(): void {
    if (this.retryTimer === null) return;
    this.hooks.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async process(): Promise<void> {
    this.processing = true;
    try {
      while (this.pending.size > 0) {
        if (this.hooks.isGestureActive()) {
          this.armRetry();
          return;
        }
        const first = this.pending.entries().next().value;
        if (!first) break;
        const key = first[0];
        const entry = first[1];
        this.pending.delete(key);
        let ok = false;
        try {
          ok = await entry.run();
        } catch {
          ok = false;
        }
        if (!entry.settled) {
          entry.settled = true;
          entry.settle(ok);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

export function workspaceMediaGestureActive(): boolean {
  const workspace = document.querySelector<HTMLElement>(".wc-workspace");
  return Boolean(
    workspace?.classList.contains("is-viewport-moving") ||
    workspace?.classList.contains("is-node-dragging") ||
    workspace?.classList.contains("is-space-pan"),
  );
}
