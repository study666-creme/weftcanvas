import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteServerMedia: vi.fn(),
  removeMedia: vi.fn(),
  readAllProjects: vi.fn(),
}));

// 放进 hoisted 工厂：vi.mock 会被提升到类声明之前，普通类会触发 TDZ。
const FakeCanvasApiError = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "CanvasApiError";
    }
  }
  return ApiError;
});

vi.mock("./api-client", () => ({
  deleteServerMedia: mocks.deleteServerMedia,
  CanvasApiError: FakeCanvasApiError,
}));
vi.mock("./media-store", () => ({ removeMedia: mocks.removeMedia }));
vi.mock("./project-library", () => ({ readAllProjects: mocks.readAllProjects }));

import {
  cancelServerMediaDeletion,
  flushPendingServerMediaDeletions,
  scheduleServerMediaDeletion,
} from "./server-media-deletion";
import type { CanvasMedia } from "@weftcanvas/contracts";

const QUEUE_KEY = "weftcanvas:pending-server-media-deletions:v1";

function serverMedia(id: string): CanvasMedia {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 10,
    source: "server",
    serverId: id,
    width: null,
    height: null,
    durationMs: null,
  };
}

type Stubs = {
  queue: () => Record<string, number>;
  timers: Map<number, () => void>;
  flushTimers: () => void;
};

let stubs: Stubs;

function installBrowserStubs(initialQueue?: Record<string, number>) {
  const store = new Map<string, string>();
  if (initialQueue) store.set(QUEUE_KEY, JSON.stringify(initialQueue));
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const windowStub = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    setTimeout: (fn: () => void) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    addEventListener: vi.fn(),
  };
  const documentStub = { addEventListener: vi.fn(), visibilityState: "visible" };
  (globalThis as { window?: unknown }).window = windowStub;
  (globalThis as { document?: unknown }).document = documentStub;
  stubs = {
    queue: () => {
      const raw = store.get(QUEUE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    },
    timers,
    flushTimers: () => {
      for (const fn of [...timers.values()]) fn();
    },
  };
}

function uninstallBrowserStubs() {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
}

async function expectDeleted(mediaId: string) {
  await vi.waitFor(() => expect(mocks.deleteServerMedia).toHaveBeenCalledWith(mediaId));
  await vi.waitFor(() => expect(stubs.queue()[mediaId]).toBeUndefined());
}

async function expectIdle() {
  // 等几个宏任务：确认定时器回调里的异步链已跑完且没有触发删除。
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  mocks.deleteServerMedia.mockReset();
  mocks.removeMedia.mockReset();
  mocks.readAllProjects.mockReset();
  mocks.readAllProjects.mockReturnValue([]);
  mocks.deleteServerMedia.mockResolvedValue({ id: "x" });
  mocks.removeMedia.mockResolvedValue(undefined);
});

afterEach(() => {
  uninstallBrowserStubs();
});

describe("server media deletion queue", () => {
  it("persists the schedule and deletes after the grace window", async () => {
    installBrowserStubs();
    scheduleServerMediaDeletion(serverMedia("m-1"));
    expect(stubs.queue()["m-1"]).toBeTypeOf("number");

    stubs.flushTimers();
    await expectDeleted("m-1");
    expect(mocks.removeMedia).toHaveBeenCalledWith("m-1");
  });

  it("cancel clears both the timer and the persisted entry", async () => {
    installBrowserStubs();
    scheduleServerMediaDeletion(serverMedia("m-1"));
    cancelServerMediaDeletion("m-1");
    expect(stubs.queue()).toEqual({});
    stubs.flushTimers();
    await expectIdle();
    expect(mocks.deleteServerMedia).not.toHaveBeenCalled();
  });

  it("flush deletes entries past grace that no local project references", async () => {
    installBrowserStubs({ "m-old": Date.now() - 1_000 });
    await flushPendingServerMediaDeletions();
    expect(mocks.deleteServerMedia).toHaveBeenCalledWith("m-old");
    expect(stubs.queue()).toEqual({});
  });

  it("flush keeps entries still referenced by local projects (node media or clip)", async () => {
    installBrowserStubs({ "m-node": Date.now() - 1_000, "m-clip": Date.now() - 1_000 });
    mocks.readAllProjects.mockReturnValue([
      {
        nodes: [
          { data: { media: { id: "m-node", serverId: "m-node" } } },
          { data: { media: null, edit: { clips: [{ mediaId: "m-clip" }] } } },
        ],
      },
    ]);
    await flushPendingServerMediaDeletions();
    expect(mocks.deleteServerMedia).not.toHaveBeenCalled();
    // 保留并推后：下次 flush/定时器再评估，不误删。
    expect(Object.keys(stubs.queue()).sort()).toEqual(["m-clip", "m-node"]);
    for (const scheduledAt of Object.values(stubs.queue())) {
      expect(scheduledAt).toBeGreaterThan(Date.now());
    }
  });

  it("404/409 responses dequeue the entry; network errors schedule a retry", async () => {
    installBrowserStubs({
      "m-404": Date.now() - 1_000,
      "m-409": Date.now() - 1_000,
      "m-net": Date.now() - 1_000,
    });
    mocks.deleteServerMedia.mockImplementation(async (id: string) => {
      if (id === "m-404") throw new FakeCanvasApiError(404, "MEDIA_NOT_FOUND", "gone");
      if (id === "m-409") throw new FakeCanvasApiError(409, "MEDIA_REFERENCED_BY_PROJECT", "bound");
      throw new FakeCanvasApiError(0, "NETWORK_UNAVAILABLE", "offline");
    });
    await flushPendingServerMediaDeletions();
    expect(stubs.queue()["m-404"]).toBeUndefined();
    expect(stubs.queue()["m-409"]).toBeUndefined();
    // 网络失败：保留队列并推迟到重试窗口。
    expect(stubs.queue()["m-net"]).toBeGreaterThan(Date.now());
  });

  it("flush re-arms in-grace entries instead of deleting now", async () => {
    installBrowserStubs({ "m-fresh": Date.now() + 30_000 });
    await flushPendingServerMediaDeletions();
    expect(mocks.deleteServerMedia).not.toHaveBeenCalled();
    stubs.flushTimers();
    await expectDeleted("m-fresh");
  });

  it("skips non-server media entirely", () => {
    installBrowserStubs();
    scheduleServerMediaDeletion({ ...serverMedia("m-local"), source: "local" });
    expect(stubs.queue()).toEqual({});
  });
});
