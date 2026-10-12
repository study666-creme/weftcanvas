import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginBrowserGeneration,
  beginBrowserSubmission,
  browserSubmissionIdentity,
  endBrowserGeneration,
  endBrowserSubmission,
  isAmbiguousSubmissionStatus,
  isBrowserGenerationActive,
  isBrowserSubmissionInFlight,
  persistBrowserSubmissionIdentity,
  releaseBrowserSubmissionIdentity,
  resolvePendingSubmissionIdentity,
} from "./browser-generation-runtime";

const PENDING_SUBMISSION_STORAGE_KEY = "weftcanvas:pending-generation-requests:v1";

describe("browser generation runtime", () => {
  afterEach(() => {
    endBrowserGeneration("job-any");
    endBrowserSubmission("node-any");
    endBrowserSubmission("node-other");
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("tracks an optimistic submission per node until it ends", () => {
    expect(isBrowserSubmissionInFlight("node-any")).toBe(false);

    beginBrowserSubmission("node-any");

    expect(isBrowserSubmissionInFlight("node-any")).toBe(true);
    expect(isBrowserSubmissionInFlight("node-other")).toBe(false);

    endBrowserSubmission("node-any");

    expect(isBrowserSubmissionInFlight("node-any")).toBe(false);
  });

  it("keeps the job tracking set independent from the submission tracking set", () => {
    beginBrowserGeneration("job-any");
    beginBrowserSubmission("node-any");

    expect(isBrowserGenerationActive("job-any")).toBe(true);
    expect(isBrowserGenerationActive("node-any")).toBe(false);
    expect(isBrowserSubmissionInFlight("node-any")).toBe(true);
    expect(isBrowserSubmissionInFlight("job-any")).toBe(false);

    endBrowserGeneration("job-any");
    endBrowserSubmission("node-any");

    expect(isBrowserGenerationActive("job-any")).toBe(false);
    expect(isBrowserSubmissionInFlight("node-any")).toBe(false);
  });

  it("ends the submission flag once and does not leak it into other nodes", () => {
    beginBrowserSubmission("node-any");
    beginBrowserSubmission("node-other");
    endBrowserSubmission("node-any");

    expect(isBrowserSubmissionInFlight("node-any")).toBe(false);
    expect(isBrowserSubmissionInFlight("node-other")).toBe(true);

    endBrowserSubmission("node-other");
  });
});

describe("durable pending submission identity", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("persists and releases an idempotency identity scoped to a project node", () => {
    expect(browserSubmissionIdentity("project-a", "node-a")).toBeNull();

    persistBrowserSubmissionIdentity("project-a", "node-a", "job:key-one");

    expect(browserSubmissionIdentity("project-a", "node-a")).toEqual({
      key: "job:key-one",
      createdAt: expect.any(Number),
    });
    expect(browserSubmissionIdentity("project-a", "node-b")).toBeNull();
    expect(browserSubmissionIdentity("project-b", "node-a")).toBeNull();

    releaseBrowserSubmissionIdentity("project-a", "node-a");

    expect(browserSubmissionIdentity("project-a", "node-a")).toBeNull();
  });

  it("reuses the durable identity inside the ambiguous window", () => {
    persistBrowserSubmissionIdentity("project-a", "node-a", "job:key-one");
    const createKey = vi.fn(() => "job:fresh");

    const { key, reused } = resolvePendingSubmissionIdentity(
      "project-a",
      "node-a",
      "submission_unknown",
      createKey,
    );

    expect(reused).toBe(true);
    expect(key).toBe("job:key-one");
    expect(createKey).not.toHaveBeenCalled();
    expect(browserSubmissionIdentity("project-a", "node-a")?.key).toBe("job:key-one");
  });

  it("reuses the durable identity while the node is still inside the submitting window", () => {
    persistBrowserSubmissionIdentity("project-a", "node-a", "job:key-one");
    const createKey = vi.fn(() => "job:fresh");

    const { key, reused } = resolvePendingSubmissionIdentity(
      "project-a",
      "node-a",
      "submitting",
      createKey,
    );

    expect(reused).toBe(true);
    expect(key).toBe("job:key-one");
    expect(createKey).not.toHaveBeenCalled();
    expect(browserSubmissionIdentity("project-a", "node-a")?.key).toBe("job:key-one");
  });

  it("treats only submitting and submission_unknown as the ambiguous reuse window", () => {
    expect(isAmbiguousSubmissionStatus("submitting")).toBe(true);
    expect(isAmbiguousSubmissionStatus("submission_unknown")).toBe(true);
    expect(isAmbiguousSubmissionStatus("queued")).toBe(false);
    expect(isAmbiguousSubmissionStatus("running")).toBe(false);
    expect(isAmbiguousSubmissionStatus("completed")).toBe(false);
    expect(isAmbiguousSubmissionStatus("failed")).toBe(false);
    expect(isAmbiguousSubmissionStatus(null)).toBe(false);
  });

  it("mints a fresh identity for a genuinely new submission and clears stale state", () => {
    persistBrowserSubmissionIdentity("project-a", "node-a", "job:stale");

    const { key, reused } = resolvePendingSubmissionIdentity(
      "project-a",
      "node-a",
      "completed",
      () => "job:fresh",
    );

    expect(reused).toBe(false);
    expect(key).toBe("job:fresh");
    expect(browserSubmissionIdentity("project-a", "node-a")?.key).toBe("job:fresh");
  });
});

describe("durable pending submission identity reload", () => {
  beforeEach(() => {
    installMemoryStorage();
    vi.resetModules();
  });

  it("keeps the pending identity across a module reload through the durable store", async () => {
    const first = await import("./browser-generation-runtime");
    first.persistBrowserSubmissionIdentity("project-a", "node-a", "job:key-survives");

    vi.resetModules();
    const reloaded = await import("./browser-generation-runtime");

    expect(reloaded.browserSubmissionIdentity("project-a", "node-a")).toEqual({
      key: "job:key-survives",
      createdAt: expect.any(Number),
    });
  });
});

describe("durable pending submission identity storage safety", () => {
  beforeEach(() => {
    installMemoryStorage();
    vi.resetModules();
  });

  it("ignores corrupt stored entries and keeps generation usable", async () => {
    const runtime = await import("./browser-generation-runtime");
    localStorage.setItem(PENDING_SUBMISSION_STORAGE_KEY, "{not-valid-json");

    expect(runtime.browserSubmissionIdentity("project-a", "node-a")).toBeNull();
    runtime.persistBrowserSubmissionIdentity("project-a", "node-a", "job:fresh-after-corrupt");
    expect(runtime.browserSubmissionIdentity("project-a", "node-a")?.key).toBe(
      "job:fresh-after-corrupt",
    );
  });

  it("skips malformed per-entry records instead of failing the whole map", async () => {
    const runtime = await import("./browser-generation-runtime");
    localStorage.setItem(
      PENDING_SUBMISSION_STORAGE_KEY,
      JSON.stringify({
        "project-a:node-a": { key: "job:valid", createdAt: 123 },
        "project-a:node-b": { key: 7, createdAt: "not-a-number" },
        "project-a:node-c": "not-an-object",
        "project-a:node-d": null,
      }),
    );

    expect(runtime.browserSubmissionIdentity("project-a", "node-a")?.key).toBe("job:valid");
    expect(runtime.browserSubmissionIdentity("project-a", "node-b")).toBeNull();
    expect(runtime.browserSubmissionIdentity("project-a", "node-c")).toBeNull();
    expect(runtime.browserSubmissionIdentity("project-a", "node-d")).toBeNull();
  });

  it("keeps the in-memory identity when storage writes are rejected", async () => {
    const runtime = await import("./browser-generation-runtime");
    const failing = storageWithRejectedWrites();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: failing });

    expect(() =>
      runtime.persistBrowserSubmissionIdentity("project-a", "node-a", "job:memory-only"),
    ).not.toThrow();
    expect(runtime.browserSubmissionIdentity("project-a", "node-a")?.key).toBe("job:memory-only");
  });

  it("stores only the opaque key and local creation time, never media or credentials", async () => {
    const runtime = await import("./browser-generation-runtime");
    runtime.persistBrowserSubmissionIdentity("project-a", "node-a", "job:key-one");
    runtime.persistBrowserSubmissionIdentity("project-b", "node-b", "job:key-two");

    const stored = JSON.parse(localStorage.getItem(PENDING_SUBMISSION_STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({
      "project-a:node-a": { key: "job:key-one", createdAt: expect.any(Number) },
      "project-b:node-b": { key: "job:key-two", createdAt: expect.any(Number) },
    });
  });

  it("keeps localStorage bounded by evicting the oldest identities only when over the cap", async () => {
    const runtime = await import("./browser-generation-runtime");
    const cap = 2_000;
    for (let index = 0; index < cap + 50; index += 1) {
      runtime.persistBrowserSubmissionIdentity(`project-${index}`, "node-a", `job:key-${index}`);
    }

    const stored = JSON.parse(localStorage.getItem(PENDING_SUBMISSION_STORAGE_KEY) ?? "{}");
    expect(Object.keys(stored)).toHaveLength(cap);
    expect(stored["project-0:node-a"]).toBeUndefined();
    expect(stored[`project-${cap - 1}:node-a`]).toEqual({
      key: `job:key-${cap - 1}`,
      createdAt: expect.any(Number),
    });
  });
});

describe("durable pending submission identity parser bounds", () => {
  beforeEach(() => {
    installMemoryStorage();
    vi.resetModules();
  });

  it("treats malformed and non-object top-level payloads as empty without throwing", async () => {
    for (const payload of ["{oops", "null", "42", '"text"', "[1, 2, 3]"]) {
      localStorage.setItem(PENDING_SUBMISSION_STORAGE_KEY, payload);
      vi.resetModules();
      const runtime = await import("./browser-generation-runtime");
      expect(() => runtime.browserSubmissionIdentity("project-a", "node-a")).not.toThrow();
      expect(runtime.browserSubmissionIdentity("project-a", "node-a")).toBeNull();
    }
  });

  it("keeps only well-formed records and drops empty, oversized, and dangerous keys", async () => {
    localStorage.setItem(
      PENDING_SUBMISSION_STORAGE_KEY,
      JSON.stringify({
        "": { key: "job:valid", createdAt: 1_000 },
        [`p1:n-${"x".repeat(600)}`]: { key: "job:valid", createdAt: 1_000 },
        "p\n:n-ctrl": { key: "job:valid", createdAt: 1_000 },
        "p1:n-empty-key": { key: "", createdAt: 1_000 },
        "p1:n-oversized-key": { key: "y".repeat(300), createdAt: 1_000 },
        "p1:n-valid": { key: "job:valid", createdAt: 1_000 },
      }),
    );
    const runtime = await import("./browser-generation-runtime");

    expect(runtime.browserSubmissionIdentity("p1", "n-valid")).toEqual({
      key: "job:valid",
      createdAt: 1_000,
    });
    expect(runtime.browserSubmissionIdentity("p1", "n-empty-key")).toBeNull();
    expect(runtime.browserSubmissionIdentity("p1", "n-oversized-key")).toBeNull();
    expect(runtime.browserSubmissionIdentity("p\n", "n-ctrl")).toBeNull();
    expect(runtime.browserSubmissionIdentity("", "")).toBeNull();
  });

  it("rejects non-finite, negative, and future-impossible timestamps", async () => {
    localStorage.setItem(
      PENDING_SUBMISSION_STORAGE_KEY,
      JSON.stringify({
        "p1:n-nan": { key: "job:nan", createdAt: Number.NaN },
        "p1:n-infinity": { key: "job:infinity", createdAt: Number.POSITIVE_INFINITY },
        "p1:n-negative": { key: "job:negative", createdAt: -5 },
        "p1:n-future": { key: "job:future", createdAt: Date.now() + 30 * 24 * 60 * 60 * 1000 },
        "p1:n-valid": { key: "job:valid", createdAt: 1_000 },
      }),
    );
    const runtime = await import("./browser-generation-runtime");

    expect(runtime.browserSubmissionIdentity("p1", "n-valid")).toEqual({
      key: "job:valid",
      createdAt: 1_000,
    });
    expect(runtime.browserSubmissionIdentity("p1", "n-nan")).toBeNull();
    expect(runtime.browserSubmissionIdentity("p1", "n-infinity")).toBeNull();
    expect(runtime.browserSubmissionIdentity("p1", "n-negative")).toBeNull();
    expect(runtime.browserSubmissionIdentity("p1", "n-future")).toBeNull();
  });

  it("caps the number of parsed pending identities", async () => {
    const record: Record<string, unknown> = {};
    for (let index = 0; index < 2_050; index += 1) {
      record[`p1:n-${index}`] = { key: `job:key-${index}`, createdAt: 1_000 + index };
    }
    localStorage.setItem(PENDING_SUBMISSION_STORAGE_KEY, JSON.stringify(record));
    const runtime = await import("./browser-generation-runtime");

    expect(runtime.browserSubmissionIdentity("p1", "n-0")).toEqual({
      key: "job:key-0",
      createdAt: 1_000,
    });
    expect(runtime.browserSubmissionIdentity("p1", "n-1999")).toEqual({
      key: "job:key-1999",
      createdAt: 1_000 + 1999,
    });
    expect(runtime.browserSubmissionIdentity("p1", "n-2000")).toBeNull();
  });

  it("preserves the in-memory identity when the durable write fails without throwing", async () => {
    const runtime = await import("./browser-generation-runtime");
    const storage = globalThis.localStorage as Storage;
    const spy = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() =>
      runtime.persistBrowserSubmissionIdentity("project-a", "node-a", "job:memory-key"),
    ).not.toThrow();
    expect(runtime.browserSubmissionIdentity("project-a", "node-a")?.key).toBe("job:memory-key");

    spy.mockRestore();
  });
});

function installMemoryStorage() {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

function storageWithRejectedWrites() {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
  };
  return storage;
}
