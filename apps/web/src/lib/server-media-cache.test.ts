import { describe, expect, it } from "vitest";

import { MediaCacheIdleQueue } from "./server-media-cache";

type Timer = { fn: () => void; ms: number; cleared: boolean };

function makeHarness(options: { gesture?: boolean; maxPending?: number; retryMs?: number } = {}) {
  const timers: Timer[] = [];
  let gestureActive = options.gesture ?? false;
  const queue = new MediaCacheIdleQueue(
    {
      isGestureActive: () => gestureActive,
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms, cleared: false });
        return timers.length;
      },
      clearTimeout: (id) => {
        const timer = timers[id - 1];
        if (timer) timer.cleared = true;
      },
    },
    options.maxPending ?? 64,
    options.retryMs ?? 250,
  );
  const flushMicrotasks = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const fireNextTimer = async () => {
    const next = timers.find((timer) => !timer.cleared);
    if (!next) return false;
    next.cleared = true;
    next.fn();
    await flushMicrotasks();
    return true;
  };
  return {
    queue,
    timers,
    flushMicrotasks,
    fireNextTimer,
    setGesture: (active: boolean) => {
      gestureActive = active;
    },
  };
}

describe("MediaCacheIdleQueue", () => {
  it("does not run writes while a gesture is active", async () => {
    const harness = makeHarness({ gesture: true });
    const runs: string[] = [];
    const first = harness.queue.enqueue("a", async () => {
      runs.push("a");
      return true;
    });
    const second = harness.queue.enqueue("b", async () => {
      runs.push("b");
      return true;
    });
    await harness.flushMicrotasks();
    expect(runs).toEqual([]);
    expect(harness.queue.size).toBe(2);
    expect(harness.timers.length).toBeGreaterThan(0);
    void first;
    void second;
  });

  it("runs deferred writes once the gesture ends", async () => {
    const harness = makeHarness({ gesture: true });
    const runs: string[] = [];
    const first = harness.queue.enqueue("a", async () => {
      runs.push("a");
      return true;
    });
    const second = harness.queue.enqueue("b", async () => {
      runs.push("b");
      return true;
    });
    harness.setGesture(false);
    expect(await harness.fireNextTimer()).toBe(true);
    expect(runs).toEqual(["a", "b"]);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(harness.queue.size).toBe(0);
  });

  it("runs immediately when idle", async () => {
    const harness = makeHarness();
    const runs: string[] = [];
    await harness.queue.enqueue("a", async () => {
      runs.push("a");
      return true;
    });
    await harness.flushMicrotasks();
    expect(runs).toEqual(["a"]);
  });

  it("serializes writes so the next starts only after the previous resolves", async () => {
    const harness = makeHarness();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = harness.queue.enqueue("a", async () => {
      order.push("a-start");
      await firstGate;
      order.push("a-end");
      return true;
    });
    const second = harness.queue.enqueue("b", async () => {
      order.push("b-start");
      return true;
    });
    await harness.flushMicrotasks();
    expect(order).toEqual(["a-start"]);
    releaseFirst();
    await harness.flushMicrotasks();
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
    await Promise.all([first, second]);
  });

  it("resolves a write failure as false without fabricating success", async () => {
    const harness = makeHarness();
    const result = harness.queue.enqueue("a", async () => {
      throw new Error("write failed");
    });
    await expect(result).resolves.toBe(false);
  });

  it("bounds the queue and evicts the oldest without running it", async () => {
    const harness = makeHarness({ gesture: true, maxPending: 2 });
    const runs: string[] = [];
    const first = harness.queue.enqueue("a", async () => {
      runs.push("a");
      return true;
    });
    const second = harness.queue.enqueue("b", async () => {
      runs.push("b");
      return true;
    });
    const third = harness.queue.enqueue("c", async () => {
      runs.push("c");
      return true;
    });
    await harness.flushMicrotasks();
    await expect(first).resolves.toBe(false);
    expect(runs).toEqual([]);
    expect(harness.queue.size).toBe(2);
    void second;
    void third;
  });

  it("resolves pending promises false on clear without running writes", async () => {
    const harness = makeHarness({ gesture: true });
    const runs: string[] = [];
    const first = harness.queue.enqueue("a", async () => {
      runs.push("a");
      return true;
    });
    harness.queue.clear();
    await expect(first).resolves.toBe(false);
    expect(runs).toEqual([]);
    expect(harness.queue.size).toBe(0);
  });
});
