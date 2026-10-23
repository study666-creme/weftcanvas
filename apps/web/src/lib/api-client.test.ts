import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acceptCloudProjectInvitation,
  declineCloudProjectInvitation,
  fetchGenerationJob,
  fetchModelCatalog,
  inviteCloudProjectMember,
  listCloudProjectInvitations,
  listCloudProjectMembers,
  loginIdentity,
  mediaContentPath,
  reconcileGenerationJob,
  removeCloudProjectMember,
  revokeCloudProjectInvitation,
  saveCloudProject,
  submitGenerationJob,
  subscribeGenerationJob,
  uploadMediaBlob,
} from "./api-client";

const createdAt = "2026-07-22T10:00:00.000Z";
const expiresAt = "2026-07-22T11:00:00.000Z";

describe("generation submission retries", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries one network failure with the same idempotency key", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("socket closed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, data: job() }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = submitGenerationJob(submission());
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "job-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstBody.idempotencyKey).toBe("image-request-123456");
    expect(secondBody).toEqual(firstBody);
  });

  it("recovers repeated tunnel failures without changing the idempotency key", async () => {
    vi.useFakeTimers();
    // 三次尝试（1 次重试延迟预算各一次）：这条链路上一次尝试要等十几秒，四次
    // 尝试会把提交按钮锁住一分多钟。余下的不确定交给后台按幂等键核对。
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "CLOUDFLARE_EDGE_UNAVAILABLE", message: "temporary edge outage" },
          }),
          { status: 530, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, data: job() }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = submitGenerationJob(submission());
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "job-1" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)),
    );
    expect(new Set(bodies.map((body) => body.idempotencyKey))).toEqual(
      new Set(["image-request-123456"]),
    );
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
  });

  it("reports submit retry progress so the panel can say it is still trying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, data: job() }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const retries: Array<{ attempt: number; attempts: number }> = [];

    const pending = submitGenerationJob(submission(), {
      onRetry: (progress) => retries.push(progress),
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "job-1" });

    expect(retries).toEqual([{ attempt: 2, attempts: 3 }]);
  });

  it("retries transient login and model-catalog failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "CLOUDFLARE_EDGE_UNAVAILABLE", message: "temporary edge outage" },
          }),
          { status: 530, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              user: {
                id: "07d3b269-6bc3-4dbb-b67f-28664c787f00",
                email: "creator@example.com",
                displayName: "Creator",
                createdAt,
              },
              expiresAt,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockRejectedValueOnce(new TypeError("catalog connection reset"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              version: "catalog-1",
              capabilityVersion: "capability-1",
              pricingVersion: "pricing-1",
              fetchedAt: createdAt,
              expiresAt,
              quoteAvailable: true,
              models: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const login = loginIdentity({ email: "creator@example.com", password: "correct-password" });
    await vi.runAllTimersAsync();
    await expect(login).resolves.toMatchObject({
      data: { user: { email: "creator@example.com" } },
    });
    const catalog = fetchModelCatalog("video");
    await vi.runAllTimersAsync();
    await expect(catalog).resolves.toMatchObject({ version: "catalog-1", models: [] });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const loginBodies = fetchMock.mock.calls
      .slice(0, 2)
      .map((call) => String((call[1] as RequestInit).body));
    expect(loginBodies[1]).toBe(loginBodies[0]);
  });

  it("falls back to polling after two event streams open and fail without a job", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonJob(job({ status: "queued", version: 1 })));
    vi.stubGlobal("fetch", fetchMock);

    class FlakyEventSource {
      static instance: FlakyEventSource | null = null;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      constructor() {
        FlakyEventSource.instance = this;
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FlakyEventSource);

    const stop = subscribeGenerationJob("job-1", { onJob: () => undefined });
    const source = FlakyEventSource.instance;
    if (!source) throw new Error("expected EventSource instance");
    source.onopen?.({} as Event);
    source.onerror?.({} as Event);
    source.onopen?.({} as Event);
    source.onerror?.({} as Event);
    await vi.advanceTimersByTimeAsync(1);

    expect(source.closed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("falls back to snapshot polling when an open event stream stays silent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonJob(job({ status: "queued", version: 1 })));
    vi.stubGlobal("fetch", fetchMock);

    class SilentEventSource {
      static instance: SilentEventSource | null = null;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      constructor() {
        SilentEventSource.instance = this;
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", SilentEventSource);

    const stop = subscribeGenerationJob("job-1", { onJob: () => undefined });
    const source = SilentEventSource.instance;
    if (!source) throw new Error("expected EventSource instance");
    source.onopen?.({} as Event);
    await vi.advanceTimersByTimeAsync(29_999);

    expect(source.closed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(source.closed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("restarts the event silence window after a valid job update", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonJob(job({ status: "running", version: 2 })));
    vi.stubGlobal("fetch", fetchMock);

    class UpdatingEventSource {
      static instance: UpdatingEventSource | null = null;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      listeners = new Map<string, (event: Event) => void>();
      constructor() {
        UpdatingEventSource.instance = this;
      }
      addEventListener(name: string, listener: EventListener) {
        this.listeners.set(name, listener);
      }
      emit(name: string, event: Event) {
        this.listeners.get(name)?.(event);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", UpdatingEventSource);
    const received: number[] = [];

    const stop = subscribeGenerationJob("job-1", { onJob: (next) => received.push(next.version) });
    const source = UpdatingEventSource.instance;
    if (!source) throw new Error("expected EventSource instance");
    source.onopen?.({} as Event);
    await vi.advanceTimersByTimeAsync(20_000);
    source.emit("job", {
      data: JSON.stringify({ type: "job", job: job({ status: "running", version: 1 }) }),
    } as MessageEvent<string>);
    await vi.advanceTimersByTimeAsync(29_999);

    expect(received).toEqual([1]);
    expect(source.closed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(source.closed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("continues status polling while a submission is being reconciled", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonJob(
          job({
            status: "submission_unknown",
            version: 1,
            error: {
              code: "GENERATION_SUBMISSION_UNCONFIRMED",
              message: "pending",
              retryable: false,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(jsonJob(job({ status: "queued", version: 2 })));
    vi.stubGlobal("fetch", fetchMock);
    const received: string[] = [];

    const stop = subscribeGenerationJob("job-1", { onJob: (next) => received.push(next.status) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received).toEqual(["submission_unknown", "queued"]);
    stop();
  });

  it("degrades to a slow retry after the transport budget, then stops for good", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi.fn().mockResolvedValue(serviceUnavailable());
    vi.stubGlobal("fetch", fetchMock);
    let exhausted = 0;

    const stop = subscribeGenerationJob("job-1", {
      onJob: () => undefined,
      onObservationExhausted: () => {
        exhausted += 1;
      },
    });
    // 花完连续传输失败预算：只是降级（节点显示「暂时无法更新」），观测继续。
    await vi.advanceTimersByTimeAsync(120_000);
    expect(exhausted).toBe(1);
    const callsAtDegrade = fetchMock.mock.calls.length;
    expect(callsAtDegrade).toBeGreaterThanOrEqual(8);

    // 降级窗口按分钟级重试：丢包链路上网络恢复时节点会自己接上，而不是永远停表。
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(callsAtDegrade + 4);

    // 降级预算（30 次、每 60 秒一次）用尽后才真正停表：之后不再有任何请求。
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const callsAfterGiveUp = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterGiveUp);
    stop();
  });

  it("recovers the fast cadence and clears the exhausted marker when the network returns", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(
        calls <= 8
          ? serviceUnavailable()
          : jsonJob(job({ status: "running", version: 3, progress: 12 })),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    let exhausted = 0;
    let recovered = 0;

    const stop = subscribeGenerationJob("job-1", {
      onJob: () => undefined,
      onObservationExhausted: () => {
        exhausted += 1;
      },
      onObservationRecovered: () => {
        recovered += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(exhausted).toBe(1);
    expect(recovered).toBe(1);

    // 恢复后回到 2 秒节奏：5 秒内至少再有两次快照。
    const callsAfterRecovery = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(callsAfterRecovery + 2);
    stop();
  });

  it("resets the failure budget after a successful snapshot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const failing = new Response(
      JSON.stringify({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE", message: "temporary outage" },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(failing)
      .mockResolvedValue(failing)
      .mockResolvedValue(failing)
      .mockResolvedValueOnce(jsonJob(job({ status: "running", version: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    let exhausted = 0;

    const stop = subscribeGenerationJob("job-1", {
      onJob: () => undefined,
      onObservationExhausted: () => {
        exhausted += 1;
      },
    });
    // Three failures then one success resets the consecutive-failure budget, so
    // observation never exhausts and keeps polling for the job.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(exhausted).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    stop();
  });

  it("exhausts observation when the same nonterminal snapshot never advances", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonJob(job({ status: "running", version: 1, progress: 42 }))),
      );
    vi.stubGlobal("fetch", fetchMock);
    let exhausted = 0;

    const stop = subscribeGenerationJob("job-1", {
      onJob: () => undefined,
      onObservationExhausted: () => {
        exhausted += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    // A healthy route returning the same stale running version is transport
    // success but not job progress: the state-aware stagnation window must
    // eventually exhaust observation instead of spinning forever.
    await vi.advanceTimersByTimeAsync(61 * 60_000);

    expect(exhausted).toBe(1);
    const callsAfterExhaustion = fetchMock.mock.calls.length;
    // Once exhausted, no further fetch or timer runs.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterExhaustion);
    stop();
  });

  it("keeps observing a genuinely advancing job across the stagnation window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    let version = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      version += 1;
      return Promise.resolve(jsonJob(job({ status: "running", version, progress: 42 })));
    });
    vi.stubGlobal("fetch", fetchMock);
    let exhausted = 0;
    const received: number[] = [];

    const stop = subscribeGenerationJob("job-1", {
      onJob: (next) => received.push(next.version),
      onObservationExhausted: () => {
        exhausted += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    // Every poll advances the public version, so the stagnation marker keeps
    // resetting and a legitimate long-running job is never exhausted.
    await vi.advanceTimersByTimeAsync(61 * 60_000);

    expect(exhausted).toBe(0);
    expect(received.length).toBeGreaterThan(1);
    stop();
  });

  it("keeps observing submission_unknown without stagnation exhaustion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonJob(
          job({
            status: "submission_unknown",
            version: 1,
            progress: 0,
            error: {
              code: "GENERATION_SUBMISSION_UNCONFIRMED",
              message: "pending",
              retryable: false,
            },
          }),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let exhausted = 0;

    const stop = subscribeGenerationJob("job-1", {
      onJob: () => undefined,
      onObservationExhausted: () => {
        exhausted += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    // submission_unknown keeps its existing read-only recovery semantics: it is
    // excluded from the stagnation budget and keeps its slow polling cadence.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(exhausted).toBe(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    stop();
  });

  it("delivers a completed result after an EventSource old snapshot stays silent and falls back to polling", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonJob(job({ status: "running", version: 1 })))
      .mockResolvedValueOnce(jsonJob(job({ status: "completed", version: 2, progress: 100 })));
    vi.stubGlobal("fetch", fetchMock);

    class SilentThenClosedEventSource {
      static instance: SilentThenClosedEventSource | null = null;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      listeners = new Map<string, (event: Event) => void>();
      constructor() {
        SilentThenClosedEventSource.instance = this;
      }
      addEventListener(name: string, listener: EventListener) {
        this.listeners.set(name, listener);
      }
      emit(name: string, event: Event) {
        this.listeners.get(name)?.(event);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", SilentThenClosedEventSource);
    const received: string[] = [];

    const stop = subscribeGenerationJob("job-1", { onJob: (next) => received.push(next.status) });
    const source = SilentThenClosedEventSource.instance;
    if (!source) throw new Error("expected EventSource instance");
    source.onopen?.({} as Event);
    source.emit("job", {
      data: JSON.stringify({ type: "job", job: job({ status: "running", version: 1 }) }),
    } as MessageEvent<string>);
    // The stream emits the old running snapshot then stays silent; the silence
    // watchdog falls back to bounded polling, which delivers the completed
    // terminal snapshot without a reload or a second user action.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(2_001);

    expect(received).toEqual(["running", "completed"]);
    expect(source.closed).toBe(true);
    stop();
  });

  it("stops observation and releases resources on session expiry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          error: { code: "UNAUTHENTICATED", message: "登录已过期" },
        },
        401,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let expired = 0;
    let exhausted = 0;

    const stop = subscribeGenerationJob("job-1", {
      onJob: () => undefined,
      onSessionExpired: () => {
        expired += 1;
      },
      onObservationExhausted: () => {
        exhausted += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(expired).toBe(1);
    expect(exhausted).toBe(0);
    const callsAfterExpiry = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterExpiry);
    stop();
  });

  it("aborts a hanging generation job fetch after the timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchGenerationJob("job-1");
    const assertion = expect(pending).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(12_001);
    await assertion;
  });

  it("preserves the current cloud revision from a conflict response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "CLOUD_PROJECT_REVISION_CONFLICT", message: "conflict" },
          }),
          {
            status: 409,
            headers: {
              "Content-Type": "application/json",
              "X-Canvas-Current-Revision": "7",
            },
          },
        ),
      ),
    );

    await expect(
      saveCloudProject("project-1", {
        baseRevision: 1,
        document: {
          schemaVersion: 1,
          projectId: "project-1",
          title: "Project",
          nodes: [],
          edges: [],
          groups: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          createdAt: 1,
          updatedAt: 2,
        },
        checkpoint: false,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_PROJECT_REVISION_CONFLICT",
      currentRevision: 7,
    });
  });

  it("scopes shared media URLs to the cloud project", () => {
    expect(mediaContentPath("media/id", "shared project")).toBe(
      "/api/v1/media/media%2Fid/content?projectId=shared+project",
    );
    expect(mediaContentPath("media/id")).toBe("/api/v1/media/media%2Fid/content");
    expect(mediaContentPath("media/id", "shared project", { download: true })).toBe(
      "/api/v1/media/media%2Fid/content?projectId=shared+project&download=1",
    );
  });

  it("leaves retry-after unset when the response omits the header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "RATE_LIMITED", message: "try later" },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      saveCloudProject("project-1", {
        baseRevision: 1,
        document: {
          schemaVersion: 1,
          projectId: "project-1",
          title: "Project",
          nodes: [],
          edges: [],
          groups: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          createdAt: 1,
          updatedAt: 2,
        },
        checkpoint: false,
      }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: null,
    });
  });

  it("uses the collaboration endpoints and parses their contracts", async () => {
    const invitation = {
      id: "c1b4f5d8-2ce7-4fb1-9341-2efaf9e4afca",
      projectId: "project-1",
      inviterId: "owner-1",
      inviteeId: "member-1",
      role: "member" as const,
      status: "pending" as const,
      createdAt,
      expiresAt: "2026-07-29T10:00:00.000Z",
      acceptedAt: null,
    };
    const member = {
      projectId: "project-1",
      principalId: "member-1",
      role: "member" as const,
      createdAt,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: { members: [member], invitations: [invitation], seatUsage: { limit: 1, used: 1 } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: invitation }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { invitations: [invitation] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: member }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listCloudProjectMembers("project-1", "owner-1")).resolves.toEqual({
      members: [member],
      invitations: [invitation],
      seatUsage: { limit: 1, used: 1 },
    });
    await expect(inviteCloudProjectMember("project-1", "member-1")).resolves.toEqual(invitation);
    await expect(removeCloudProjectMember("project-1", "member-1")).resolves.toBeUndefined();
    await expect(revokeCloudProjectInvitation("project-1", invitation.id)).resolves.toBeUndefined();
    await expect(listCloudProjectInvitations()).resolves.toEqual([invitation]);
    await expect(acceptCloudProjectInvitation(invitation.id)).resolves.toEqual(member);
    await expect(declineCloudProjectInvitation(invitation.id)).resolves.toBeUndefined();

    expect(
      fetchMock.mock.calls.map((call) => [
        call[0],
        (call[1] as RequestInit | undefined)?.method ?? "GET",
      ]),
    ).toEqual([
      ["/api/v1/cloud-projects/project-1/members?ownerId=owner-1", "GET"],
      ["/api/v1/cloud-projects/project-1/members/invitations", "POST"],
      ["/api/v1/cloud-projects/project-1/members/member-1", "DELETE"],
      [`/api/v1/cloud-projects/project-1/members/invitations/${invitation.id}`, "DELETE"],
      ["/api/v1/cloud-project-invitations", "GET"],
      [`/api/v1/cloud-project-invitations/${invitation.id}/accept`, "POST"],
      [`/api/v1/cloud-project-invitations/${invitation.id}`, "DELETE"],
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      inviteeId: "member-1",
    });
  });

  it("uploads a multipart media intent in signed batches and returns its ready media", async () => {
    const sessionId = "f0dd055e-d094-48ef-aa47-7583b5deadc1";
    const pendingMedia = media({ status: "pending" });
    const readyMedia = media({ status: "ready" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            sessionId,
            parts: [
              {
                partNumber: 1,
                method: "PUT",
                url: "https://uploads.example/part-1",
                headers: { "x-part": "1" },
                expiresAt,
              },
              {
                partNumber: 2,
                method: "PUT",
                url: "https://uploads.example/part-2",
                headers: { "x-part": "2" },
                expiresAt,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            sessionId,
            phase: "ready",
            partSize: 8 * 1024 * 1024,
            partCount: 2,
            uploadedParts: [
              { partNumber: 1, size: 8 * 1024 * 1024 },
              { partNumber: 2, size: 1 },
            ],
            expiresAt,
            media: readyMedia,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadMediaBlob(
      pendingMedia,
      {
        strategy: "multipart",
        sessionId,
        partSize: 8 * 1024 * 1024,
        partCount: 2,
        expiresAt,
        signPartsUrl: "/api/v1/media/media-1/multipart/session/parts",
        reconcileUrl: "/api/v1/media/media-1/multipart/session",
        completeUrl: "/api/v1/media/media-1/multipart/session/complete",
        abortUrl: "/api/v1/media/media-1/multipart/session",
      },
      new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]),
    );

    expect(result).toEqual(readyMedia);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "/api/v1/media/media-1/multipart/session/parts",
      "https://uploads.example/part-1",
      "https://uploads.example/part-2",
      "/api/v1/media/media-1/multipart/session/complete",
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      partNumbers: [1, 2],
    });
    expect(((fetchMock.mock.calls[1]?.[1] as RequestInit).body as Blob).size).toBe(8 * 1024 * 1024);
    expect(((fetchMock.mock.calls[2]?.[1] as RequestInit).body as Blob).size).toBe(1);
  });

  it("cancels a multipart session when a signed part upload fails", async () => {
    const sessionId = "f0dd055e-d094-48ef-aa47-7583b5deadc1";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            sessionId,
            parts: [
              {
                partNumber: 1,
                method: "PUT",
                url: "https://uploads.example/part-1",
                headers: {},
                expiresAt,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "UPLOAD_REJECTED", message: "rejected" },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            sessionId,
            phase: "aborted",
            partSize: 8 * 1024 * 1024,
            partCount: 1,
            uploadedParts: [],
            expiresAt,
            media: media({
              status: "failed",
              error: { code: "UPLOAD_REJECTED", message: "rejected" },
            }),
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadMediaBlob(
        media({ status: "pending" }),
        {
          strategy: "multipart",
          sessionId,
          partSize: 8 * 1024 * 1024,
          partCount: 1,
          expiresAt,
          signPartsUrl: "/api/v1/media/media-1/multipart/session/parts",
          reconcileUrl: "/api/v1/media/media-1/multipart/session",
          completeUrl: "/api/v1/media/media-1/multipart/session/complete",
          abortUrl: "/api/v1/media/media-1/multipart/session",
        },
        new Blob(["x"]),
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_REJECTED" });

    expect(
      fetchMock.mock.calls.map((call) => [
        String(call[0]),
        (call[1] as RequestInit | undefined)?.method,
      ]),
    ).toEqual([
      ["/api/v1/media/media-1/multipart/session/parts", "POST"],
      ["https://uploads.example/part-1", "PUT"],
      ["/api/v1/media/media-1/multipart/session", "DELETE"],
    ]);
  });

  it("retries confirming a direct upload when the store is briefly unreachable", async () => {
    // 字节此时已在隔离区，重新确认一次就能成功；让用户重新选文件再传一遍
    // 代价高得多，所以"存储暂时不可达"要有界重试而不是直接失败。
    vi.useFakeTimers();
    // 直传地址要与页面同源解析（node 环境下没有 DOM 的 window）。
    vi.stubGlobal("window", { location: { href: "http://localhost:4173/" } });
    const readyMedia = media({ status: "ready" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "素材存储暂时不可达，请重试" },
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "MEDIA_UPLOAD_IN_PROGRESS", message: "素材正在处理中" },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: readyMedia }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = uploadMediaBlob(
      media({ status: "pending" }),
      {
        method: "PUT",
        url: "https://uploads.example/media-1",
        headers: { "Content-Type": "video/mp4" },
        expiresAt,
        completeUrl: "/api/v1/media/media-1/complete",
      },
      new Blob(["x"]),
    );

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: readyMedia.id, status: "ready" });
    expect(
      fetchMock.mock.calls.map((call) => [
        String(call[0]),
        (call[1] as RequestInit | undefined)?.method,
      ]),
    ).toEqual([
      ["https://uploads.example/media-1", "PUT"],
      ["/api/v1/media/media-1/complete", "POST"],
      ["/api/v1/media/media-1/complete", "POST"],
      ["/api/v1/media/media-1/complete", "POST"],
    ]);
  });

  it("does not retry confirming a direct upload the server rejected on content", async () => {
    vi.stubGlobal("window", { location: { href: "http://localhost:4173/" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error: { code: "MEDIA_TYPE_UNAVAILABLE", message: "当前素材格式无法安全处理" },
          },
          422,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadMediaBlob(
        media({ status: "pending" }),
        {
          method: "PUT",
          url: "https://uploads.example/media-1",
          headers: { "Content-Type": "video/mp4" },
          expiresAt,
          completeUrl: "/api/v1/media/media-1/complete",
        },
        new Blob(["x"]),
      ),
    ).rejects.toMatchObject({ code: "MEDIA_TYPE_UNAVAILABLE" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function submission() {
  return {
    projectId: "project-1",
    nodeId: "node-1",
    modelId: "image-model",
    modality: "image" as const,
    parameters: { prompt: "city lights", n: 2 },
    inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
    quantity: 1,
    expectedQuote: {
      id: "quote-1",
      modelId: "image-model",
      creditMicros: 4_000_000,
      pricingVersion: "pricing-1",
      expiresAt,
    },
    idempotencyKey: "image-request-123456",
  };
}

describe("generation reconciliation lookup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves a durable job by its idempotency identity with no submit or replay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonJob(job({ id: "job-found", status: "completed", version: 5 })));
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await reconcileGenerationJob("canvas:stable-key-001");

    expect(resolved).toMatchObject({ id: "job-found", status: "completed", version: 5 });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe("/api/v1/generation-jobs/reconcile?key=canvas%3Astable-key-001");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("returns null for the authoritative 404 miss and throws on transient errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            ok: false,
            error: { code: "GENERATION_JOB_NOT_FOUND", message: "没有找到这个生成任务" },
          },
          404,
        ),
      ),
    );
    await expect(reconcileGenerationJob("canvas:stable-key-001")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            ok: false,
            error: { code: "GENERATION_RATE_LIMITED", message: "状态刷新过于频繁，请稍后再试" },
          },
          429,
        ),
      ),
    );
    await expect(reconcileGenerationJob("canvas:stable-key-001")).rejects.toMatchObject({
      status: 429,
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("socket closed")));
    await expect(reconcileGenerationJob("canvas:stable-key-001")).rejects.toMatchObject({
      code: "NETWORK_UNAVAILABLE",
    });
  });
});

function jsonJob(value: ReturnType<typeof job>) {
  return new Response(JSON.stringify({ ok: true, data: value }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** 观测轮询里最常见的可重试失败：服务端 503。 */
function serviceUnavailable() {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE", message: "temporary outage" },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function media(overrides: Record<string, unknown> = {}) {
  return {
    id: "84c8146f-5125-44c7-a5fd-ef79d88bb2b7",
    kind: "video" as const,
    name: "clip.mp4",
    mimeType: "video/mp4",
    size: 8 * 1024 * 1024 + 1,
    sha256: null,
    width: null,
    height: null,
    durationMs: null,
    status: "pending" as const,
    error: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version: 0,
    id: "job-1",
    projectId: "project-1",
    nodeId: "node-1",
    modelId: "image-model",
    modelLabel: "Image model",
    modality: "image",
    status: "queued",
    progress: 0,
    quote: {
      id: "quote-1",
      modelId: "image-model",
      modelLabel: "Image model",
      modality: "image",
      quantity: 1,
      normalizedParameters: { prompt: "city lights", n: 2 },
      creditMicros: 4_000_000,
      credits: "4",
      yuanMicros: 40_000,
      yuan: "0.04",
      estimated: false,
      pricingUnit: "image",
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt,
    },
    artifacts: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    ...overrides,
  };
}
