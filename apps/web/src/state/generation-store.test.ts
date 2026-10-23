import type { PublicGenerationJob, PublicModel, PublicModelCatalog } from "@weftcanvas/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasApiError } from "../lib/api-client";

const api = vi.hoisted(() => ({
  fetchModelCatalog: vi.fn(),
  fetchGenerationJob: vi.fn(),
  listGenerationJobs: vi.fn(),
  reconcileGenerationJob: vi.fn(),
  subscribeGenerationJob: vi.fn(),
  submitGenerationJob: vi.fn(),
}));
const artifactPersistence = vi.hoisted(() => ({ persist: vi.fn() }));

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api-client")>();
  return {
    ...actual,
    fetchModelCatalog: api.fetchModelCatalog,
    fetchGenerationJob: api.fetchGenerationJob,
    listGenerationJobs: api.listGenerationJobs,
    reconcileGenerationJob: api.reconcileGenerationJob,
    subscribeGenerationJob: api.subscribeGenerationJob,
    submitGenerationJob: api.submitGenerationJob,
  };
});
vi.mock("../lib/generated-artifact-persistence", () => ({
  persistCompletedGenerationArtifacts: artifactPersistence.persist,
}));

const STORAGE_KEY = "weftcanvas:model-catalogs:v1";
const previouslyFilteredImageModelIds = [
  "image2",
  "image2-economy",
  "gpt-image-2",
  "gpt-image-2-1k",
  "lingtu-fast",
  "lingtu-lite",
  "lingtu",
  "nano-banana-fast",
  "nano-banana-2-lite",
  "nano-banana",
] as const;
const previouslyFilteredVideoModelIds = [
  "motion-video",
  "motion-video-1-5",
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  "firefly-seedance2-fast-480p",
] as const;

describe("generation state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    installMemoryStorage();
    installWindow();
    api.listGenerationJobs.mockResolvedValue([]);
    api.fetchGenerationJob.mockRejectedValue(
      new CanvasApiError(404, "GENERATION_JOB_NOT_FOUND", "没有找到这个生成任务"),
    );
    api.reconcileGenerationJob.mockResolvedValue(null);
    api.subscribeGenerationJob.mockReturnValue(vi.fn());
    artifactPersistence.persist.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
    Reflect.deleteProperty(globalThis, "window");
  });

  it("loads the complete catalog once for concurrent modality requests", async () => {
    api.fetchModelCatalog.mockResolvedValue(catalog());
    const { useGenerationStore } = await import("./generation-store");

    await Promise.all([
      useGenerationStore.getState().loadCatalog("image"),
      useGenerationStore.getState().loadCatalog("video"),
      useGenerationStore.getState().loadCatalog("audio"),
      useGenerationStore.getState().loadCatalog("text"),
    ]);

    expect(api.fetchModelCatalog).toHaveBeenCalledTimes(1);
    expect(api.fetchModelCatalog).toHaveBeenCalledWith();
    expect(
      useGenerationStore.getState().catalogs.image.data?.models.map((model) => model.id),
    ).toEqual(["image-model"]);
    expect(
      useGenerationStore.getState().catalogs.video.data?.models.map((model) => model.id),
    ).toEqual(["video-model"]);
    expect(useGenerationStore.getState().catalogs.image.status).toBe("ready");
  });

  it("keeps every image and video model exactly as the server catalog publishes them", async () => {
    const source = catalog();
    api.fetchModelCatalog.mockResolvedValue({
      ...source,
      models: [
        ...source.models,
        ...previouslyFilteredImageModelIds.map((id) => model(id, "image")),
        ...previouslyFilteredVideoModelIds.map((id) => model(id, "video")),
      ],
    });
    const { useGenerationStore } = await import("./generation-store");

    await useGenerationStore.getState().loadCatalog("video");

    expect(
      useGenerationStore.getState().catalogs.video.data?.models.map((item) => item.id),
    ).toEqual(["video-model", ...previouslyFilteredVideoModelIds]);
    expect(
      useGenerationStore.getState().catalogs.image.data?.models.map((item) => item.id),
    ).toEqual(["image-model", ...previouslyFilteredImageModelIds]);
  });

  it("keeps the server-published video models in an existing browser catalog cache", async () => {
    const savedAt = Date.now() - 2 * 60_000;
    const source = catalog();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        image: {
          savedAt,
          data: {
            ...source,
            models: [
              model("image-model", "image"),
              ...previouslyFilteredImageModelIds.map((id) => model(id, "image")),
            ],
          },
        },
        video: {
          savedAt,
          data: {
            ...source,
            models: [
              model("video-model", "video"),
              ...previouslyFilteredVideoModelIds.map((id) => model(id, "video")),
            ],
          },
        },
      }),
    );

    const { useGenerationStore } = await import("./generation-store");

    expect(
      useGenerationStore.getState().catalogs.video.data?.models.map((item) => item.id),
    ).toEqual(["video-model", ...previouslyFilteredVideoModelIds]);
    expect(
      useGenerationStore.getState().catalogs.image.data?.models.map((item) => item.id),
    ).toEqual(["image-model", ...previouslyFilteredImageModelIds]);
  });

  it("keeps a saved catalog ready while its background refresh fails", async () => {
    const savedAt = Date.now() - 2 * 60_000;
    const saved = catalog();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        image: {
          savedAt,
          data: { ...saved, models: saved.models.filter((model) => model.modality === "image") },
        },
      }),
    );
    api.fetchModelCatalog.mockRejectedValue(new Error("offline"));
    const { useGenerationStore } = await import("./generation-store");

    const before = useGenerationStore.getState().catalogs.image;
    expect(before.status).toBe("ready");
    expect(before.data?.models[0]?.id).toBe("image-model");

    await useGenerationStore.getState().loadCatalog("image", true);

    const after = useGenerationStore.getState().catalogs.image;
    expect(api.fetchModelCatalog).toHaveBeenCalledWith(undefined, true);
    expect(after.status).toBe("ready");
    expect(after.refreshing).toBe(false);
    expect(after.error).toBe("模型列表暂时无法读取");
    expect(after.data?.models[0]?.id).toBe("image-model");
  });

  it("shows one error toast when a watched job first transitions to failed", async () => {
    let deliver: ((job: PublicGenerationJob) => void) | null = null;
    const stop = vi.fn();
    api.subscribeGenerationJob.mockImplementation(
      (_jobId: string, handlers: { onJob: (job: PublicGenerationJob) => void }) => {
        deliver = handlers.onJob;
        return stop;
      },
    );
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useToastStore } = await import("./toast-store");
    const projectId = useCanvasStore.getState().projectId;
    const running = generationJob(projectId);
    const failed = generationJob(projectId, {
      version: 2,
      status: "failed",
      error: { code: "UPSTREAM_FAILED", message: "视频生成失败，请稍后重试", retryable: true },
      completedAt: "2026-07-23T08:02:00.000Z",
      updatedAt: "2026-07-23T08:02:00.000Z",
    });

    useGenerationStore.getState().watchJob(running);
    expect(deliver).not.toBeNull();
    deliver!(failed);
    deliver!(failed);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().items.map(({ message, tone }) => ({ message, tone }))).toEqual([
      {
        message: "视频生成失败，请稍后重试",
        tone: "error",
      },
    ]);
  });

  it("marks a watched job observation as exhausted when the stream budget is spent", async () => {
    let exhaust: (() => void) | null = null;
    api.subscribeGenerationJob.mockImplementation(
      (
        _jobId: string,
        handlers: {
          onJob?: (job: PublicGenerationJob) => void;
          onObservationExhausted?: () => void;
        },
      ) => {
        exhaust = handlers.onObservationExhausted ?? null;
        return vi.fn();
      },
    );
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const projectId = useCanvasStore.getState().projectId;
    const running = generationJob(projectId);

    useGenerationStore.getState().watchJob(running);
    expect(exhaust).not.toBeNull();
    exhaust!();

    expect(useGenerationStore.getState().exhaustedObservations[running.id]).toBe(true);
  });

  it("clears an exhausted observation when a fresh snapshot arrives", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const projectId = useCanvasStore.getState().projectId;
    const running = generationJob(projectId);

    useGenerationStore.setState((state) => ({
      exhaustedObservations: { ...state.exhaustedObservations, [running.id]: true },
    }));
    useGenerationStore.getState().recordJob(running);

    expect(useGenerationStore.getState().exhaustedObservations[running.id]).toBeUndefined();
  });

  it("clears the degraded marker when the observation stream recovers", async () => {
    let recover: (() => void) | null = null;
    api.subscribeGenerationJob.mockImplementation(
      (
        _jobId: string,
        handlers: {
          onObservationExhausted?: () => void;
          onObservationRecovered?: () => void;
        },
      ) => {
        recover = handlers.onObservationRecovered ?? null;
        return vi.fn();
      },
    );
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const running = generationJob(useCanvasStore.getState().projectId);

    useGenerationStore.getState().watchJob(running);
    useGenerationStore.getState().markObservationExhausted(running.id);
    expect(useGenerationStore.getState().exhaustedObservations[running.id]).toBe(true);
    expect(recover).not.toBeNull();

    recover!();

    // 丢包链路上网络恢复后，节点要自己回到正常的生成中展示。
    expect(useGenerationStore.getState().exhaustedObservations[running.id]).toBeUndefined();
  });

  it("keeps watching a degraded job instead of releasing its watcher", async () => {
    const stop = vi.fn();
    let exhaust: (() => void) | null = null;
    api.subscribeGenerationJob.mockImplementation(
      (
        _jobId: string,
        handlers: {
          onJob?: (job: PublicGenerationJob) => void;
          onObservationExhausted?: () => void;
          onObservationRecovered?: () => void;
        },
      ) => {
        exhaust = handlers.onObservationExhausted ?? null;
        return stop;
      },
    );
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const projectId = useCanvasStore.getState().projectId;
    const running = generationJob(projectId);

    useGenerationStore.getState().watchJob(running);
    exhaust!();

    // 降级不是停表：观测还在，网络恢复时才能自己接上。
    expect(stop).not.toHaveBeenCalled();
    useGenerationStore.getState().clearRuntime();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous submission in the background instead of waiting for a reload", async () => {
    const { useGenerationStore, AMBIGUOUS_RECONCILE_DELAYS_MS } =
      await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const scheduled: Array<{ delay: number; run: () => void }> = [];
    const clearTimeout = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        innerWidth: 1440,
        innerHeight: 900,
        setTimeout: (callback: () => void, delay?: number) => {
          scheduled.push({ delay: delay ?? 0, run: callback });
          return scheduled.length;
        },
        clearTimeout,
      },
    });
    const projectId = useCanvasStore.getState().projectId;
    useIdentityStore.setState({
      status: "authenticated",
      session: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          displayName: "Creator",
          createdAt: "2026-07-23T08:00:00.000Z",
        },
        expiresAt: "2026-08-23T08:00:00.000Z",
      },
    });
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    useGenerationStore.getState().beginHostedSubmission(nodeId, () => "job:pending-key");
    api.reconcileGenerationJob.mockResolvedValue(generationJob(projectId));

    useGenerationStore.getState().reconcileAmbiguousSubmissions(projectId);

    // 三次核对按分钟级退避排好：一次没成功就再问一次，网络恢复时节点自愈。
    expect(scheduled.map((entry) => entry.delay)).toEqual([...AMBIGUOUS_RECONCILE_DELAYS_MS]);
    expect(api.reconcileGenerationJob).not.toHaveBeenCalled();

    scheduled[0]!.run();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.reconcileGenerationJob).toHaveBeenCalledWith("job:pending-key");

    // 再排一份之前必须先清掉上一份，避免换项目后旧核对还在跑。
    useGenerationStore.getState().reconcileAmbiguousSubmissions(projectId);
    expect(clearTimeout).toHaveBeenCalledTimes(AMBIGUOUS_RECONCILE_DELAYS_MS.length);
  });

  it("filters exhausted observations to the active project on recovery", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    useIdentityStore.setState({
      status: "authenticated",
      session: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          displayName: "Creator",
          createdAt: "2026-07-23T08:00:00.000Z",
        },
        expiresAt: "2026-08-23T08:00:00.000Z",
      },
    });
    const activeJob = generationJob(projectId);
    const otherJob = generationJob("other-project", { id: "job-other-1" });
    api.listGenerationJobs.mockResolvedValue([activeJob]);

    useGenerationStore.setState(() => ({
      jobsById: { [activeJob.id]: activeJob, [otherJob.id]: otherJob },
      exhaustedObservations: { [activeJob.id]: true, [otherJob.id]: true },
    }));

    await useGenerationStore.getState().recoverProject(projectId);

    const exhausted = useGenerationStore.getState().exhaustedObservations;
    expect(exhausted[activeJob.id]).toBe(true);
    expect(exhausted[otherJob.id]).toBeUndefined();
  });

  it("does not toast historical failed jobs restored by project recovery", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { useToastStore } = await import("./toast-store");
    const projectId = useCanvasStore.getState().projectId;
    const failed = generationJob(projectId, {
      version: 4,
      status: "failed",
      error: { code: "UPSTREAM_FAILED", message: "历史生成失败", retryable: true },
      completedAt: "2026-07-23T08:02:00.000Z",
      updatedAt: "2026-07-23T08:02:00.000Z",
    });
    api.listGenerationJobs.mockResolvedValue([failed]);
    useIdentityStore.setState({
      status: "authenticated",
      session: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          displayName: "创作者",
          createdAt: "2026-07-23T08:00:00.000Z",
        },
        expiresAt: "2026-08-23T08:00:00.000Z",
      },
    });

    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.subscribeGenerationJob).not.toHaveBeenCalled();
    expect(useToastStore.getState().items).toEqual([]);
  });
  it("keeps a missing recovered task terminal across undo history", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      progress: 35,
      generation: {
        ...node.data.generation,
        jobId: "missing-job",
        jobStatus: "running",
        error: null,
      },
    });
    useCanvasStore.getState().updateNodeData(nodeId, { body: "ordinary edit" });
    useIdentityStore.setState({
      status: "authenticated",
      session: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          displayName: "Creator",
          createdAt: "2026-07-23T08:00:00.000Z",
        },
        expiresAt: "2026-08-23T08:00:00.000Z",
      },
    });

    await useGenerationStore.getState().recoverProject(projectId);

    let recovered = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    expect(recovered?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: {
        jobId: "missing-job",
        jobStatus: "failed",
        error: "没有找到这个账号下的生成任务",
      },
    });

    useCanvasStore.getState().undo();
    recovered = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    expect(recovered?.data.status).toBe("error");
    expect(recovered?.data.generation.jobStatus).toBe("failed");

    useCanvasStore.getState().redo();
    recovered = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    expect(recovered?.data.status).toBe("error");
    expect(recovered?.data.generation.jobStatus).toBe("failed");
  });

  it("only terminates missing hosted jobs and keeps optimistic plus browser-owned work running", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const {
      beginBrowserGeneration,
      beginBrowserSubmission,
      endBrowserGeneration,
      endBrowserSubmission,
    } = await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const submittingId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const activeBrowserId = useCanvasStore.getState().addNode("image", { x: 400, y: 60 });
    const staleBrowserId = useCanvasStore.getState().addNode("image", { x: 760, y: 60 });
    const missingHostedId = useCanvasStore.getState().addNode("image", { x: 1120, y: 60 });
    const submitting = useCanvasStore.getState().nodes.find((item) => item.id === submittingId)!;
    const activeBrowser = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === activeBrowserId)!;
    const staleBrowser = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === staleBrowserId)!;
    const missingHosted = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === missingHostedId)!;
    useCanvasStore.getState().applyGenerationUpdate(submittingId, {
      status: "running",
      generation: {
        ...submitting.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    useCanvasStore.getState().applyGenerationUpdate(activeBrowserId, {
      status: "running",
      generation: {
        ...activeBrowser.data.generation,
        jobId: "browser:active-job",
        jobStatus: "running",
      },
    });
    useCanvasStore.getState().applyGenerationUpdate(staleBrowserId, {
      status: "running",
      generation: {
        ...staleBrowser.data.generation,
        jobId: "browser:stale-job",
        jobStatus: "running",
      },
    });
    useCanvasStore.getState().applyGenerationUpdate(missingHostedId, {
      status: "running",
      generation: {
        ...missingHosted.data.generation,
        jobId: "missing-hosted-job",
        jobStatus: "running",
      },
    });
    beginBrowserGeneration("browser:active-job");
    beginBrowserSubmission(submittingId);
    useIdentityStore.setState(authenticatedIdentity());

    try {
      await useGenerationStore.getState().recoverProject(projectId);
    } finally {
      endBrowserGeneration("browser:active-job");
      endBrowserSubmission(submittingId);
    }

    expect(
      useCanvasStore.getState().nodes.find((item) => item.id === submittingId)?.data,
    ).toMatchObject({
      status: "running",
      generation: { jobId: null, jobStatus: "submitting" },
    });
    expect(
      useCanvasStore.getState().nodes.find((item) => item.id === activeBrowserId)?.data,
    ).toMatchObject({
      status: "running",
      generation: { jobId: "browser:active-job", jobStatus: "running" },
    });
    expect(
      useCanvasStore.getState().nodes.find((item) => item.id === staleBrowserId)?.data,
    ).toMatchObject({
      status: "running",
      generation: { jobId: "browser:stale-job", jobStatus: "running" },
    });
    expect(
      useCanvasStore.getState().nodes.find((item) => item.id === missingHostedId)?.data,
    ).toMatchObject({
      status: "error",
      generation: { jobId: "missing-hosted-job", jobStatus: "failed" },
    });
  });

  it("releases a stale optimistic submission after recovery so the node stays actionable", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: {
        jobId: null,
        jobStatus: null,
        error: "任务无法恢复，请重新生成",
      },
    });
  });

  it("keeps a submitting node protected with the ordinary presentation while its durable identity is inside the confirmation window", async () => {
    const { selectProject, useCanvasStore } = await import("./canvas-store");
    const runtime = await import("../lib/browser-generation-runtime");
    const { writeProject } = await import("../lib/project-library");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    // The pre-refresh submission recorded its stable idempotency identity and
    // the optimistic submitting state was persisted with the project.
    runtime.persistBrowserSubmissionIdentity(projectId, nodeId, "job:stable-key-001");
    writeProject(selectProject(useCanvasStore.getState()));

    // Force reload: module instances are fresh and in-flight session state is
    // lost, while the durable identity and project snapshot survive.
    vi.resetModules();
    const reloadedGeneration = await import("./generation-store");
    const reloadedCanvas = await import("./canvas-store");
    const reloadedIdentity = await import("./identity-store");
    const reloadedRuntime = await import("../lib/browser-generation-runtime");
    reloadedIdentity.useIdentityStore.setState(authenticatedIdentity());
    expect(reloadedCanvas.useCanvasStore.getState().projectId).toBe(projectId);
    expect(
      reloadedCanvas.useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data,
    ).toMatchObject({
      status: "running",
      generation: { jobId: null, jobStatus: "submitting" },
    });

    // Recovery runs before the accepted-but-not-yet-listed job appears. The
    // exact key lookup confirms the durable request does not exist yet, and the
    // identity is still inside its finite window, so the node stays protected
    // and keeps the ordinary generating presentation (never an indefinite
    // unknown or locked spinner).
    await reloadedGeneration.useGenerationStore.getState().recoverProject(projectId);

    expect(api.reconcileGenerationJob).toHaveBeenCalledWith("job:stable-key-001");
    expect(api.submitGenerationJob).not.toHaveBeenCalled();
    expect(
      reloadedCanvas.useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data,
    ).toMatchObject({
      status: "running",
      progress: null,
      generation: {
        jobId: null,
        jobVersion: null,
        jobStatus: "submitting",
        error: null,
      },
    });
    expect(reloadedRuntime.browserSubmissionIdentity(projectId, nodeId)?.key).toBe(
      "job:stable-key-001",
    );

    // An immediate repeated user action cannot mint a fresh identity: it would
    // reuse the exact same logical request key instead.
    const createKey = vi.fn(() => "job:fresh-identity");
    const identity = reloadedRuntime.resolvePendingSubmissionIdentity(
      projectId,
      nodeId,
      "submitting",
      createKey,
    );
    expect(identity).toEqual({ key: "job:stable-key-001", reused: true });
    expect(createKey).not.toHaveBeenCalled();
  });

  it("locks a submitting node carrying a durable identity that only appears in older snapshots", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { persistBrowserSubmissionIdentity } = await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const visible = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    const hiddenSubmitting = structuredClone(visible);
    hiddenSubmitting.data = {
      ...hiddenSubmitting.data,
      status: "running",
      progress: null,
      generation: {
        ...hiddenSubmitting.data.generation,
        jobId: null,
        jobStatus: "submitting",
        error: null,
      },
    };
    useCanvasStore.setState({
      nodes: [visible],
      edges: [],
      groups: [],
      past: [{ nodes: [hiddenSubmitting], edges: [], groups: [] }],
      future: [{ nodes: [structuredClone(hiddenSubmitting)], edges: [], groups: [] }],
      transactionBase: null,
    });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:stable-key-003");
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    const state = useCanvasStore.getState();
    expect(state.nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "idle",
      generation: { jobId: null, jobStatus: null },
    });
    expect(state.past[0]?.nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      progress: null,
      generation: { jobId: null, jobStatus: "submitting" },
    });
    expect(state.future[0]?.nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      progress: null,
      generation: { jobId: null, jobStatus: "submitting" },
    });
  });

  it("keeps the durable pending identity when a live job is observed without authoritative correlation", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:stable-key-002");
    const live = generationJob(projectId, {
      id: "job-live-1",
      nodeId,
      version: 1,
      status: "queued",
    });

    useGenerationStore.getState().recordJob(live);

    // A same-node job cannot be authoritatively correlated to the pending
    // identity (the public snapshot carries no clientRequestId), so the
    // conservative lock must stay until a fresh resolution or explicit
    // abandonment.
    expect(browserSubmissionIdentity(projectId, nodeId)?.key).toBe("job:stable-key-002");
  });

  it("keeps a newer durable pending identity when only an unrelated older live job is observed", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    // The newer interrupted submission minted its durable identity while an
    // older unrelated job for the same node is still queued. The public job
    // snapshot has no clientRequestId, so that older job must not unlock the
    // newer ambiguous request and allow a second paid task.
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:newer-key");
    const older = generationJob(projectId, {
      id: "job-older-active",
      nodeId,
      version: 1,
      status: "queued",
      createdAt: "2026-07-22T08:00:00.000Z",
      updatedAt: "2026-07-22T08:00:05.000Z",
    });

    useGenerationStore.getState().recordJob(older);

    expect(browserSubmissionIdentity(projectId, nodeId)?.key).toBe("job:newer-key");
  });

  it("keeps a newer durable pending identity when a newer unrelated live job is observed", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    // Even a job created after the durable identity cannot be authoritatively
    // correlated to it: createdAt ordering never clears the pending record,
    // because the snapshot lacks the clientRequestId. The identity stays until
    // a fresh resolution, a definitive failure, or explicit abandonment.
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:newer-key");
    const newer = generationJob(projectId, {
      id: "job-newer-active",
      nodeId,
      version: 1,
      status: "queued",
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    });

    useGenerationStore.getState().recordJob(newer);

    expect(browserSubmissionIdentity(projectId, nodeId)?.key).toBe("job:newer-key");
  });

  it("mints a fresh identity for a genuinely new hosted submission on a settled node", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "success",
      generation: { ...node.data.generation, jobId: null, jobStatus: "completed" },
    });
    // A stale durable identity from an earlier interrupted submission lingers on
    // an otherwise settled node; the genuinely new action must not reuse it.
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:stale-key");
    const createKey = vi.fn(() => "job:fresh-key");

    const identity = useGenerationStore.getState().beginHostedSubmission(nodeId, createKey);

    expect(identity).toEqual({ key: "job:fresh-key", reused: false });
    expect(createKey).toHaveBeenCalledTimes(1);
    expect(browserSubmissionIdentity(projectId, nodeId)?.key).toBe("job:fresh-key");
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      progress: 0,
      generation: { jobId: null, jobStatus: "submitting" },
    });
  });

  it("reuses the durable identity while the node is already inside the ambiguous window", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: { ...node.data.generation, jobId: null, jobStatus: "submitting" },
    });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:stable-key");
    const createKey = vi.fn(() => "job:fresh-key");

    const identity = useGenerationStore.getState().beginHostedSubmission(nodeId, createKey);

    expect(identity).toEqual({ key: "job:stable-key", reused: true });
    expect(createKey).not.toHaveBeenCalled();
    expect(browserSubmissionIdentity(projectId, nodeId)?.key).toBe("job:stable-key");
  });

  it("reuses the same durable identity when the submit action fires twice in a row (double-click)", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { browserSubmissionIdentity } = await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const createKey = vi.fn(() => "job:key-once");

    const first = useGenerationStore.getState().beginHostedSubmission(nodeId, createKey);
    // The optimistic submitting window is now active; a double-clicked second
    // call must reuse the exact same logical request identity.
    const second = useGenerationStore.getState().beginHostedSubmission(nodeId, createKey);

    expect(first).toEqual({ key: "job:key-once", reused: false });
    expect(second).toEqual({ key: "job:key-once", reused: true });
    expect(createKey).toHaveBeenCalledTimes(1);
    expect(browserSubmissionIdentity(projectId, nodeId)?.key).toBe("job:key-once");
  });

  it("explicit abandonment releases the durable identity and makes the node actionable again", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const {
      browserSubmissionIdentity,
      persistBrowserSubmissionIdentity,
      releaseBrowserSubmissionIdentity,
    } = await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:to-abandon");

    // The panel's abandon action mirrors this store-level release: it clears
    // the durable identity and resets the node to an actionable state. A
    // subsequent fresh submission therefore mints a brand-new key instead of
    // reusing the abandoned request.
    releaseBrowserSubmissionIdentity(projectId, nodeId);
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().updateNodeData(
      nodeId,
      {
        status: node.data.media ? "success" : "idle",
        progress: null,
        generation: {
          ...node.data.generation,
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: "已放弃未确认的提交，请重新提交",
        },
      },
      false,
    );

    expect(browserSubmissionIdentity(projectId, nodeId)).toBeNull();
    const createKey = vi.fn(() => "job:after-abandon");
    const identity = useGenerationStore.getState().beginHostedSubmission(nodeId, createKey);
    expect(identity).toEqual({ key: "job:after-abandon", reused: false });
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it("keeps a durable pending identity when recovery only surfaces an older terminal job", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    const olderCompleted = generationJob(projectId, {
      id: "job-old-completed",
      nodeId,
      version: 4,
      status: "completed",
      progress: 100,
      createdAt: "2026-07-23T07:00:00.000Z",
      updatedAt: "2026-07-23T07:01:00.000Z",
      completedAt: "2026-07-23T07:01:00.000Z",
    });
    api.listGenerationJobs.mockResolvedValue([olderCompleted]);
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:stable-key-004");
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    // The terminal snapshot restores the completed result (existing recovery
    // compatibility), but it must not release the still-unconfirmed identity.
    expect(api.submitGenerationJob).not.toHaveBeenCalled();
    expect(browserSubmissionIdentity(projectId, nodeId)?.key).toBe("job:stable-key-004");
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "success",
      generation: { jobId: "job-old-completed", jobStatus: "completed" },
    });
  });

  it("keeps an in-flight optimistic submission while recovery is running", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { beginBrowserSubmission, endBrowserSubmission } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    useIdentityStore.setState(authenticatedIdentity());
    beginBrowserSubmission(nodeId);

    try {
      await useGenerationStore.getState().recoverProject(projectId);
    } finally {
      endBrowserSubmission(nodeId);
    }

    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      generation: { jobId: null, jobStatus: "submitting" },
    });
  });

  it("replaces stale state with a reconcile-found settled job and releases the identity across undo/redo", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    useCanvasStore.getState().updateNodeData(nodeId, { body: "ordinary edit" });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:settled-key");
    const settled = generationJob(projectId, {
      id: "job-reconciled-settled",
      nodeId,
      version: 4,
      status: "completed",
      progress: 100,
      completedAt: "2026-07-23T08:02:00.000Z",
      updatedAt: "2026-07-23T08:02:00.000Z",
    });
    api.reconcileGenerationJob.mockResolvedValue(settled);
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.reconcileGenerationJob).toHaveBeenCalledWith("job:settled-key");
    expect(api.submitGenerationJob).not.toHaveBeenCalled();
    expect(browserSubmissionIdentity(projectId, nodeId)).toBeNull();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "success",
      generation: { jobId: "job-reconciled-settled", jobStatus: "completed" },
    });

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "success",
      generation: { jobId: "job-reconciled-settled", jobStatus: "completed" },
    });
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "success",
      generation: { jobId: "job-reconciled-settled", jobStatus: "completed" },
    });
  });

  it("applies and watches a reconcile-found live job and releases the identity", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:live-key");
    const live = generationJob(projectId, {
      id: "job-reconciled-live",
      nodeId,
      version: 1,
      status: "queued",
      progress: 12,
    });
    api.reconcileGenerationJob.mockResolvedValue(live);
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(browserSubmissionIdentity(projectId, nodeId)).toBeNull();
    expect(api.subscribeGenerationJob).toHaveBeenCalledWith(
      "job-reconciled-live",
      expect.anything(),
    );
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      progress: 12,
      generation: { jobId: "job-reconciled-live", jobStatus: "queued" },
    });
  });

  it("renders a reconcile-found failed job as the authoritative outcome and releases the identity", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:failed-key");
    const failed = generationJob(projectId, {
      id: "job-reconciled-failed",
      nodeId,
      version: 3,
      status: "failed",
      progress: 0,
      error: { code: "GENERATION_FAILED", message: "生成失败", retryable: false },
      completedAt: "2026-07-23T08:03:00.000Z",
    });
    api.reconcileGenerationJob.mockResolvedValue(failed);
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.submitGenerationJob).not.toHaveBeenCalled();
    expect(browserSubmissionIdentity(projectId, nodeId)).toBeNull();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: { jobId: "job-reconciled-failed", jobStatus: "failed", error: "生成失败" },
    });
  });

  it("releases an expired identity and converges the node to an explicit actionable failure with snapshot repair", async () => {
    const T0 = Date.parse("2026-07-23T08:00:00.000Z");
    const WINDOW = 2 * 60 * 60 * 1_000;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    useCanvasStore.getState().updateNodeData(nodeId, { body: "ordinary edit" });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:expired-key");
    useIdentityStore.setState(authenticatedIdentity());

    // The identity is already older than the finite confirmation window when
    // the old project is reopened, and the exact lookup confirms no job.
    vi.setSystemTime(T0 + WINDOW + 1_000);
    api.reconcileGenerationJob.mockResolvedValue(null);
    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.submitGenerationJob).not.toHaveBeenCalled();
    expect(browserSubmissionIdentity(projectId, nodeId)).toBeNull();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: {
        jobId: null,
        jobVersion: null,
        jobCreatedAt: null,
        jobStatus: null,
        error: "任务无法恢复，请重新生成",
      },
    });

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      generation: { jobStatus: null, error: "任务无法恢复，请重新生成" },
    });
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      generation: { jobStatus: null, error: "任务无法恢复，请重新生成" },
    });
    vi.useRealTimers();
  });

  it("keeps an expired identity protected when the authoritative lookup still finds its job", async () => {
    const T0 = Date.parse("2026-07-23T08:00:00.000Z");
    const WINDOW = 2 * 60 * 60 * 1_000;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:old-but-accepted-key");
    useIdentityStore.setState(authenticatedIdentity());

    vi.setSystemTime(T0 + WINDOW + 60_000);
    api.reconcileGenerationJob.mockResolvedValue(
      generationJob(projectId, {
        id: "job-old-but-accepted",
        nodeId,
        version: 3,
        status: "running",
        progress: 72,
      }),
    );
    await useGenerationStore.getState().recoverProject(projectId);

    // Authoritative resolution wins over expiry: the node converges to the live
    // job and the identity is released, never a permanent unknown or spinner.
    expect(browserSubmissionIdentity(projectId, nodeId)).toBeNull();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      progress: 72,
      generation: { jobId: "job-old-but-accepted", jobStatus: "running" },
    });
    vi.useRealTimers();
  });

  it("directly resolves an accepted job omitted by the capped recovery list without terminalizing it", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      progress: 35,
      generation: {
        ...node.data.generation,
        jobId: "job-capped-out",
        jobStatus: "running",
      },
    });
    api.fetchGenerationJob.mockResolvedValue(
      generationJob(projectId, {
        id: "job-capped-out",
        nodeId,
        version: 2,
        status: "running",
        progress: 44,
      }),
    );
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.fetchGenerationJob).toHaveBeenCalledWith("job-capped-out");
    expect(api.subscribeGenerationJob).toHaveBeenCalledWith("job-capped-out", expect.anything());
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      progress: 44,
      generation: { jobId: "job-capped-out", jobStatus: "running", jobVersion: 2 },
    });
  });

  it("does not erase a still-recent legitimate request when reconciliation fails", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const { browserSubmissionIdentity, persistBrowserSubmissionIdentity } =
      await import("../lib/browser-generation-runtime");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    persistBrowserSubmissionIdentity(projectId, nodeId, "job:recent-key");
    api.reconcileGenerationJob.mockRejectedValue(
      new CanvasApiError(0, "NETWORK_UNAVAILABLE", "无法连接画布服务"),
    );
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.submitGenerationJob).not.toHaveBeenCalled();
    expect(browserSubmissionIdentity(projectId, nodeId)?.key).toBe("job:recent-key");
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      generation: { jobId: null, jobStatus: "submitting" },
    });
  });

  it("keeps a submitting node when the server already accepted a matching job", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
      },
    });
    const accepted = generationJob(projectId, {
      id: "job-accepted-submitting",
      nodeId,
      version: 1,
      status: "submitting",
      progress: 0,
      createdAt: "2026-07-23T08:00:05.000Z",
      updatedAt: "2026-07-23T08:00:05.000Z",
    });
    api.listGenerationJobs.mockResolvedValue([accepted]);
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.subscribeGenerationJob).toHaveBeenCalledWith(
      "job-accepted-submitting",
      expect.anything(),
    );
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      generation: { jobId: "job-accepted-submitting", jobStatus: "submitting" },
    });
  });

  it("restores a completed result for a submitting node whose old job is in the recovery list", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: "job-already-completed",
        jobStatus: "submitting",
      },
    });
    api.listGenerationJobs.mockResolvedValue([
      generationJob(projectId, {
        id: "job-already-completed",
        nodeId,
        version: 4,
        status: "completed",
        progress: 100,
        createdAt: "2026-07-23T08:00:00.000Z",
        updatedAt: "2026-07-23T08:01:00.000Z",
        completedAt: "2026-07-23T08:01:00.000Z",
      }),
    ]);
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "success",
      progress: null,
      generation: {
        jobId: "job-already-completed",
        jobStatus: "completed",
        error: null,
      },
    });
  });

  it("shows a reconciled submission_unknown job as an error while recovery continues", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: "job-unknown",
        jobVersion: 1,
        jobStatus: "submission_unknown",
        error: null,
      },
    });
    api.listGenerationJobs.mockResolvedValue([
      generationJob(projectId, {
        id: "job-unknown",
        nodeId,
        version: 1,
        status: "submission_unknown",
        progress: 0,
        error: {
          code: "GENERATION_SUBMISSION_UNCONFIRMED",
          message: "任务提交结果待确认",
          retryable: false,
        },
        createdAt: "2026-07-23T08:00:05.000Z",
        updatedAt: "2026-07-23T08:00:05.000Z",
      }),
    ]);
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.subscribeGenerationJob).toHaveBeenCalledWith("job-unknown", expect.anything());
    expect(api.submitGenerationJob).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: {
        jobId: "job-unknown",
        jobStatus: "submission_unknown",
        error: "任务提交结果待确认",
      },
    });
  });

  it("releases a stale submission with a preserved media result without resubmitting", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      media: {
        id: "media-kept",
        name: "kept.png",
        mimeType: "image/png",
        size: 1_024,
        source: "server",
        serverId: "media-kept",
        width: 1_024,
        height: 768,
        durationMs: null,
      },
      generation: {
        ...node.data.generation,
        jobId: null,
        jobStatus: "submitting",
        error: null,
      },
    });
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.submitGenerationJob).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "success",
      progress: null,
      media: { id: "media-kept" },
      generation: {
        jobId: null,
        jobStatus: null,
        error: "任务无法恢复，请重新生成",
      },
    });
  });

  it("ignores a delayed stale snapshot of the same job after a newer version", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: "job-feedback-1",
        jobStatus: "running",
      },
    });
    const newer = generationJob(projectId, {
      id: "job-feedback-1",
      nodeId,
      version: 2,
      status: "running",
      progress: 42,
    });
    const delayed = generationJob(projectId, {
      id: "job-feedback-1",
      nodeId,
      version: 1,
      status: "running",
      progress: 12,
    });

    useGenerationStore.getState().recordJob(newer);
    useGenerationStore.getState().recordJob(delayed);
    useGenerationStore.getState().recordJob(newer);

    expect(useGenerationStore.getState().jobsById["job-feedback-1"]?.version).toBe(2);
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "running",
      progress: 42,
      generation: { jobId: "job-feedback-1", jobStatus: "running", jobVersion: 2 },
    });
  });

  it("marks a hidden missing hosted task terminal without restoring the deleted node", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { findCanvasGenerationNode, useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      progress: 35,
      generation: {
        ...node.data.generation,
        jobId: "missing-hidden-job",
        jobStatus: "running",
      },
    });
    useCanvasStore.getState().deleteNode(nodeId);
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    expect(useCanvasStore.getState().nodes.some((item) => item.id === nodeId)).toBe(false);
    expect(findCanvasGenerationNode(useCanvasStore.getState(), nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: { jobId: "missing-hidden-job", jobStatus: "failed" },
    });
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: { jobId: "missing-hidden-job", jobStatus: "failed" },
    });
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().nodes.some((item) => item.id === nodeId)).toBe(false);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: { jobId: "missing-hidden-job", jobStatus: "failed" },
    });
  });

  it("terminalizes missing hosted jobs masked in past and future snapshots", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const visible = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    const hiddenRunning = structuredClone(visible);
    hiddenRunning.data = {
      ...hiddenRunning.data,
      status: "running",
      progress: 35,
      generation: {
        ...hiddenRunning.data.generation,
        jobId: "missing-history-job",
        jobStatus: "running",
        error: null,
      },
    };
    useCanvasStore.setState({
      nodes: [visible],
      edges: [],
      groups: [],
      past: [{ nodes: [hiddenRunning], edges: [], groups: [] }],
      future: [{ nodes: [structuredClone(hiddenRunning)], edges: [], groups: [] }],
      transactionBase: null,
    });
    useIdentityStore.setState(authenticatedIdentity());

    await useGenerationStore.getState().recoverProject(projectId);

    let state = useCanvasStore.getState();
    expect(state.nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "idle",
      generation: { jobId: null, jobStatus: null },
    });
    expect(state.past[0]?.nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: { jobId: "missing-history-job", jobStatus: "failed" },
    });
    expect(state.future[0]?.nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      progress: null,
      generation: { jobId: "missing-history-job", jobStatus: "failed" },
    });

    useCanvasStore.getState().undo();
    state = useCanvasStore.getState();
    expect(state.nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "error",
      generation: { jobId: "missing-history-job", jobStatus: "failed" },
    });
  });

  it("persists a completed Canvas job delivered by the live watcher", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const completed = generationJob(useCanvasStore.getState().projectId, {
      version: 2,
      status: "completed",
      progress: 100,
      completedAt: "2026-07-23T08:02:00.000Z",
      updatedAt: "2026-07-23T08:02:00.000Z",
    });

    useGenerationStore.getState().recordJob(completed);

    expect(artifactPersistence.persist).toHaveBeenCalledWith(completed);
  });

  it("persists historical completed jobs during project recovery", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const completed = generationJob(projectId, {
      version: 3,
      status: "completed",
      progress: 100,
      completedAt: "2026-07-23T08:02:00.000Z",
      updatedAt: "2026-07-23T08:02:00.000Z",
    });
    api.listGenerationJobs.mockResolvedValue([completed]);
    useIdentityStore.setState({
      status: "authenticated",
      session: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          displayName: "Creator",
          createdAt: "2026-07-23T08:00:00.000Z",
        },
        expiresAt: "2026-08-23T08:00:00.000Z",
      },
    });

    await useGenerationStore.getState().recoverProject(projectId);

    expect(artifactPersistence.persist).toHaveBeenCalledWith(completed);
  });

  it("applies completed artifacts exactly once across duplicate and higher-version terminal deliveries", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      generation: {
        ...node.data.generation,
        jobId: "job-exact-once",
        jobStatus: "running",
        error: null,
      },
    });
    const artifacts = [
      {
        id: "artifact-primary",
        kind: "image" as const,
        mediaId: "media-primary",
        name: "primary.png",
        mimeType: "image/png",
        size: 1,
        width: 1,
        height: 1,
        createdAt: "2026-07-23T08:02:00.000Z",
      },
      {
        id: "artifact-extra",
        kind: "image" as const,
        mediaId: "media-extra",
        name: "extra.png",
        mimeType: "image/png",
        size: 1,
        width: 1,
        height: 1,
        createdAt: "2026-07-23T08:02:00.000Z",
      },
    ];
    const completed = generationJob(projectId, {
      id: "job-exact-once",
      nodeId,
      version: 2,
      status: "completed",
      progress: 100,
      artifacts,
      completedAt: "2026-07-23T08:02:00.000Z",
      updatedAt: "2026-07-23T08:02:00.000Z",
    });
    const higherVersion = { ...completed, version: 3 };

    useGenerationStore.getState().recordJob(completed);
    // Duplicate SSE/poll/refresh deliveries of the same terminal version and of
    // a higher terminal version must apply the primary media and the additional
    // artifact exactly once.
    useGenerationStore.getState().recordJob(completed);
    useGenerationStore.getState().recordJob(higherVersion);

    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "success",
      progress: null,
      media: { id: "media-primary" },
      generation: { jobId: "job-exact-once", jobStatus: "completed", jobVersion: 3 },
    });
    const additional = useCanvasStore.getState().nodes.filter((item) => item.id !== nodeId);
    expect(additional).toHaveLength(1);
    expect(additional[0]?.data).toMatchObject({
      status: "success",
      media: { id: "media-extra" },
      generation: { jobId: "job-exact-once", jobStatus: "completed" },
    });
    expect(useCanvasStore.getState().edges.filter((edge) => edge.source === nodeId)).toHaveLength(
      1,
    );
  });

  it("recovers a pre-existing running node to a completed result exactly once and stops the generation effect", async () => {
    const { useGenerationStore } = await import("./generation-store");
    const { useCanvasStore } = await import("./canvas-store");
    const { useIdentityStore } = await import("./identity-store");
    const projectId = useCanvasStore.getState().projectId;
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      progress: 35,
      generation: {
        ...node.data.generation,
        jobId: "job-history-completed",
        jobStatus: "running",
        jobVersion: 1,
        error: null,
      },
    });
    const completed = generationJob(projectId, {
      id: "job-history-completed",
      nodeId,
      version: 2,
      status: "completed",
      progress: 100,
      artifacts: [
        {
          id: "artifact-history-primary",
          kind: "image" as const,
          mediaId: "media-history-primary",
          name: "result.png",
          mimeType: "image/png",
          size: 1,
          width: 1,
          height: 1,
          createdAt: "2026-07-23T08:02:00.000Z",
        },
        {
          id: "artifact-history-extra",
          kind: "image" as const,
          mediaId: "media-history-extra",
          name: "extra.png",
          mimeType: "image/png",
          size: 1,
          width: 1,
          height: 1,
          createdAt: "2026-07-23T08:02:00.000Z",
        },
      ],
      completedAt: "2026-07-23T08:02:00.000Z",
      updatedAt: "2026-07-23T08:02:00.000Z",
    });
    api.listGenerationJobs.mockResolvedValue([completed]);
    useIdentityStore.setState({
      status: "authenticated",
      session: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "creator@example.com",
          displayName: "Creator",
          createdAt: "2026-07-23T08:00:00.000Z",
        },
        expiresAt: "2026-08-23T08:00:00.000Z",
      },
    });

    // Reopen the project: the persisted running node's server job is now
    // completed and must be recovered with all authorized artifacts.
    await useGenerationStore.getState().recoverProject(projectId);
    await useGenerationStore.getState().recoverProject(projectId);

    expect(api.subscribeGenerationJob).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data).toMatchObject({
      status: "success",
      progress: null,
      media: { id: "media-history-primary" },
      generation: { jobId: "job-history-completed", jobStatus: "completed", jobVersion: 2 },
    });
    const additional = useCanvasStore.getState().nodes.filter((item) => item.id !== nodeId);
    expect(additional).toHaveLength(1);
    expect(additional[0]?.data).toMatchObject({ media: { id: "media-history-extra" } });
    expect(useCanvasStore.getState().edges.filter((edge) => edge.source === nodeId)).toHaveLength(
      1,
    );
  });
});

function generationJob(
  projectId: string,
  overrides: Partial<PublicGenerationJob> = {},
): PublicGenerationJob {
  return {
    schemaVersion: 1,
    version: 1,
    id: "job-feedback-1",
    projectId,
    nodeId: "node-feedback-1",
    modelId: "video-model",
    modelLabel: "视频模型",
    modality: "video",
    status: "running",
    progress: 42,
    quote: {
      id: "quote-feedback-1",
      modelId: "video-model",
      modelLabel: "视频模型",
      modality: "video",
      quantity: 1,
      normalizedParameters: { prompt: "雨夜镜头" },
      creditMicros: 1_000_000,
      credits: "1",
      yuanMicros: 10_000,
      yuan: "0.01",
      estimated: false,
      pricingUnit: "second",
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt: "2026-07-23T09:00:00.000Z",
    },
    artifacts: [],
    error: null,
    createdAt: "2026-07-23T08:00:00.000Z",
    updatedAt: "2026-07-23T08:01:00.000Z",
    startedAt: "2026-07-23T08:00:30.000Z",
    completedAt: null,
    ...overrides,
  };
}

function catalog(): PublicModelCatalog {
  return {
    version: "catalog-1",
    capabilityVersion: "capability-1",
    pricingVersion: "pricing-1",
    fetchedAt: "2026-07-23T08:00:00.000Z",
    expiresAt: "2026-07-23T14:00:00.000Z",
    quoteAvailable: true,
    models: [model("image-model", "image"), model("video-model", "video")],
  };
}

function model(id: string, modality: "image" | "video"): PublicModel {
  return {
    id,
    label: id,
    description: "",
    modality,
    operation: "generate",
    order: 0,
    input: { textRequired: true },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: [],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 1_000_000,
      baseYuanMicros: 10_000,
      tiers: [],
    },
  };
}

function authenticatedIdentity() {
  return {
    status: "authenticated" as const,
    session: {
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "creator@example.com",
        displayName: "Creator",
        createdAt: "2026-07-23T08:00:00.000Z",
      },
      expiresAt: "2026-08-23T08:00:00.000Z",
    },
  };
}

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

function installWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      innerWidth: 1440,
      innerHeight: 900,
    },
  });
}
