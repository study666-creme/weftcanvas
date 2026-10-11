import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// Historical node recovery fixtures: a project reopened long after submission
// must converge to authoritative success or failure through the exact
// idempotency reconciliation (and direct job fetch for capped-list omissions),
// and a completed media whose fetch/decode/metadata never settles must leave
// loading into the existing truthful media-load error/retry surface.
const visiblePng = readFileSync(new URL("../src/assets/resource-library-mark.png", import.meta.url));

const nowIso = () => new Date().toISOString();

const session = {
  user: {
    id: "07d3b269-6bc3-4dbb-b67f-28664c787f00",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: nowIso(),
  },
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
};

const emptyCatalog = {
  version: "recovery-catalog",
  capabilityVersion: "recovery-capability",
  pricingVersion: "recovery-pricing",
  fetchedAt: nowIso(),
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  quoteAvailable: false,
  models: [],
};

function quote(modelLabel = "全能模型") {
  return {
    id: "quote-recovery-1",
    modelId: "image-batch",
    modelLabel,
    modality: "image",
    quantity: 1,
    normalizedParameters: { prompt: "历史节点", n: 1 },
    creditMicros: 2_000_000,
    credits: "2",
    yuanMicros: 20_000,
    yuan: "0.02",
    estimated: false,
    pricingUnit: "image",
    catalogVersion: "recovery-catalog",
    capabilityVersion: "recovery-capability",
    pricingVersion: "recovery-pricing",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

function job(id: string, nodeId: string, overrides: Record<string, unknown> = {}) {
  const createdAt = nowIso();
  return {
    schemaVersion: 1,
    version: 1,
    id,
    projectId: "recovery-project",
    nodeId,
    modelId: "image-batch",
    modelLabel: "全能模型",
    modality: "image",
    status: "running",
    progress: 30,
    quote: quote(),
    artifacts: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    ...overrides,
  };
}

function completedJob(id: string, nodeId: string, mediaId: string) {
  const createdAt = nowIso();
  return job(id, nodeId, {
    version: 4,
    status: "completed",
    progress: 100,
    artifacts: [{
      id: `artifact-${id}`,
      kind: "image",
      mediaId,
      name: "result.png",
      mimeType: "image/png",
      size: visiblePng.byteLength,
      width: 128,
      height: 128,
      createdAt,
    }],
    completedAt: createdAt,
    updatedAt: createdAt,
  });
}

function mediaNode(id: string, x: number, y: number, generation: Record<string, unknown>) {
  const time = Date.now();
  return {
    id,
    type: "kachang",
    position: { x, y },
    width: 340,
    height: 214,
    selected: false,
    data: {
      kind: "image",
      body: "历史生成节点",
      accent: "blue",
      status: "running",
      progress: null,
      media: null,
      directorCapture: null,
      config: null,
      generation: {
        modelId: "image-batch",
        parameters: { n: 1 },
        maxOutputTokens: null,
        referenceMode: "auto",
        referenceNodeIds: [],
        jobId: null,
        jobVersion: null,
        jobCreatedAt: null,
        jobStatus: null,
        error: null,
        ...generation,
      },
      createdAt: time,
      updatedAt: time,
    },
  };
}

// A persisted completed generation node whose media is server-owned. The media
// route below decides whether it resolves, hangs, or arrives late.
function completedMediaNode(id: string, x: number, y: number, kind: "image" | "video", mediaId: string) {
  const time = Date.now();
  return {
    ...mediaNode(id, x, y, {
      jobId: `job-${id}`,
      jobVersion: 4,
      jobCreatedAt: nowIso(),
      jobStatus: "completed",
      progress: null,
      error: null,
    }),
    data: {
      ...mediaNode(id, x, y, {
        jobId: `job-${id}`,
        jobVersion: 4,
        jobCreatedAt: nowIso(),
        jobStatus: "completed",
        progress: null,
        error: null,
      }).data,
      kind,
      status: "success" as const,
      media: {
        id: mediaId,
        name: kind === "image" ? "result.png" : "result.mp4",
        mimeType: kind === "image" ? "image/png" : "video/mp4",
        size: kind === "image" ? visiblePng.byteLength : 1_024,
        source: "server" as const,
        serverId: mediaId,
        width: 128,
        height: 128,
        durationMs: kind === "video" ? 1_000 : null,
      },
    },
  };
}

async function seedProject(page: Page, nodes: unknown[], pendingRequests: Record<string, { key: string; createdAt: number }> = {}) {
  const time = Date.now();
  const project = {
    schemaVersion: 1,
    id: "recovery-project",
    name: "Historical recovery",
    nodes,
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: time,
    updatedAt: time,
  };
  await page.addInitScript((seed) => {
    localStorage.clear();
    localStorage.setItem(`kachang-canvas:project-data:v1:${encodeURIComponent(seed.project.id)}`, JSON.stringify(seed.project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: seed.project.id, name: seed.project.name, createdAt: seed.project.createdAt, updatedAt: seed.project.updatedAt, nodeCount: seed.project.nodes.length }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", seed.project.id);
    if (seed.pending && Object.keys(seed.pending).length) {
      localStorage.setItem("kachang-canvas:pending-generation-requests:v1", JSON.stringify(seed.pending));
    }
  }, { project, pending: pendingRequests });
}

async function mockBaseApis(page: Page) {
  await mockAuthenticatedBackgroundApis(page);
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await page.route("**/api/v1/wallet", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        credits: 100,
        creditsPermanent: 100,
        dailyCredits: 0,
        creditGrantMode: "bundle",
        dailyCreditsNote: "",
        membership: { tier: null, until: null, active: false, genDiscount: null },
        lifetimeCreditsSpent: 0,
      },
    },
  }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({ json: { ok: true, data: emptyCatalog } }));
}

function routeJobList(page: Page, jobs: unknown[]) {
  return page.route((url) => url.pathname === "/api/v1/generation-jobs" && url.searchParams.has("projectId"), (route) => {
    return route.fulfill({ json: { ok: true, data: jobs } });
  });
}

function routeReconcile(page: Page, handler: (key: string, route: Parameters<Parameters<Page["route"]>[1]>[0]) => void | Promise<void>) {
  return page.route((url) => url.pathname === "/api/v1/generation-jobs/reconcile", (route) => {
    const key = new URL(route.request().url()).searchParams.get("key") ?? "";
    return handler(key, route);
  });
}

test("an old project with a durable identity reconciles to the authoritative completed job and releases the identity", async ({ page }) => {
  await seedProject(page, [mediaNode("node-settled", 40, 80, {
    jobStatus: "submitting",
    error: null,
  })], {
    "recovery-project:node-settled": { key: "canvas:reconcile-settled-001", createdAt: Date.now() - 10 * 60_000 },
  });
  await mockBaseApis(page);
  await routeJobList(page, []);
  await routeReconcile(page, (key, route) => {
    if (key === "canvas:reconcile-settled-001") {
      return route.fulfill({ json: { ok: true, data: completedJob("job-settled", "node-settled", "recovery-media-settled") } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "GENERATION_JOB_NOT_FOUND", message: "没有找到这个生成任务" } } });
  });
  await page.route((url) => url.pathname === "/api/v1/media/recovery-media-settled/content", (route) => route.fulfill({ body: visiblePng, contentType: "image/png" }));

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-settled"]');
  await expect(node.locator('img[data-media-id="recovery-media-settled"]')).toBeVisible();
  await expect(node.locator(".kc-node-loading")).toHaveCount(0);
  const released = await page.evaluate(() => {
    const raw = localStorage.getItem("kachang-canvas:pending-generation-requests:v1");
    return raw ? JSON.parse(raw) : {};
  });
  expect(released).not.toHaveProperty("recovery-project:node-settled");
});

test("an accepted job omitted by the capped list is restored by direct fetch and converges to success", async ({ page }) => {
  await seedProject(page, [mediaNode("node-omitted", 40, 80, {
    jobId: "job-capped-out",
    jobVersion: 1,
    jobCreatedAt: nowIso(),
    jobStatus: "running",
    progress: 35,
    error: null,
  })]);
  await mockBaseApis(page);
  await routeJobList(page, []);
  await page.route((url) => url.pathname === "/api/v1/generation-jobs/job-capped-out" && !url.pathname.endsWith("/events"), (route) => {
    return route.fulfill({ json: { ok: true, data: job("job-capped-out", "node-omitted", { progress: 44, version: 2 }) } });
  });
  await page.route("**/api/v1/generation-jobs/job-capped-out/events", (route) => {
    const done = completedJob("job-capped-out", "node-omitted", "recovery-media-omitted");
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: `id: generation:job-capped-out:4\nevent: job\ndata: ${JSON.stringify({ type: "job", job: done })}\n\n`,
    });
  });
  await page.route((url) => url.pathname === "/api/v1/media/recovery-media-omitted/content", (route) => route.fulfill({ body: visiblePng, contentType: "image/png" }));

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-omitted"]');
  await expect(node.locator('img[data-media-id="recovery-media-omitted"]')).toBeVisible();
  await expect(node.locator(".kc-node-loading")).toHaveCount(0);
});

test("an identity older than the finite confirmation window converges to an explicit actionable failure with retry", async ({ page }) => {
  await seedProject(page, [mediaNode("node-expired", 40, 80, {
    jobStatus: "submitting",
    error: null,
  })], {
    "recovery-project:node-expired": { key: "canvas:expired-request-001", createdAt: Date.now() - 3 * 60 * 60_000 },
  });
  await mockBaseApis(page);
  await routeJobList(page, []);
  await routeReconcile(page, (_key, route) => route.fulfill({
    status: 404,
    json: { ok: false, error: { code: "GENERATION_JOB_NOT_FOUND", message: "没有找到这个生成任务" } },
  }));

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-expired"]');
  await expect(node).toContainText("任务无法恢复，请重新生成");
  await expect(node.locator(".kc-node-loading")).toHaveCount(0);
  const released = await page.evaluate(() => {
    const raw = localStorage.getItem("kachang-canvas:pending-generation-requests:v1");
    return raw ? JSON.parse(raw) : {};
  });
  expect(released).not.toHaveProperty("recovery-project:node-expired");

  await node.click();
  await expect(page.locator(".kc-generation-panel")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".kc-generation-panel").getByRole("button", { name: "重试" })).toBeVisible();
});

test("a recent identity inside the window stays protected with the ordinary generating presentation", async ({ page }) => {
  await seedProject(page, [mediaNode("node-recent", 40, 80, {
    jobStatus: "submitting",
    error: null,
  })], {
    "recovery-project:node-recent": { key: "canvas:recent-request-001", createdAt: Date.now() - 5 * 60_000 },
  });
  await mockBaseApis(page);
  await routeJobList(page, []);
  await routeReconcile(page, (_key, route) => route.fulfill({
    status: 404,
    json: { ok: false, error: { code: "GENERATION_JOB_NOT_FOUND", message: "没有找到这个生成任务" } },
  }));

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-recent"]');
  await expect(node.locator(".kc-node-loading")).toBeVisible();
  await expect(node.locator(".kc-node-loading")).toHaveAttribute("data-generation-stage", "submitting");
  await expect(node.locator(".kc-node-loading")).toHaveAttribute("data-loading-activity", "generation");
  await expect(node).not.toContainText("任务无法恢复");
  const kept = await page.evaluate(() => {
    const raw = localStorage.getItem("kachang-canvas:pending-generation-requests:v1");
    return raw ? JSON.parse(raw) : {};
  });
  expect(kept).toHaveProperty("recovery-project:node-recent");
});

test("a completed image whose media never loads settles to the media-load error surface without changing completion truth", async ({ page }) => {
  test.setTimeout(60_000);
  await seedProject(page, [completedMediaNode("node-hung-image", 40, 80, "image", "recovery-media-hung")]);
  await mockBaseApis(page);
  await routeJobList(page, []);
  await page.route((url) => url.pathname === "/api/v1/media/recovery-media-hung/content", () => new Promise(() => {}));

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-hung-image"]');
  await expect(node.getByText("结果已生成，正在载入")).toBeVisible();
  // The generated-image fetch never resolves: bounded attempts abort and settle
  // to the truthful media-load error instead of an indefinite spinner.
  await expect(node.getByText("结果加载失败")).toBeVisible({ timeout: 50_000 });
  await expect(node.getByText("请稍后刷新重试")).toBeVisible();
  // The completed generation truth is unchanged.
  await expect(node.locator(".kc-node-wrap")).toHaveAttribute("data-node-status", "success");
});

test("a completed video whose metadata never arrives settles to the video-load failure with retry", async ({ page }) => {
  await seedProject(page, [completedMediaNode("node-hung-video", 40, 80, "video", "recovery-media-video")]);
  await mockBaseApis(page);
  await routeJobList(page, []);
  await page.route((url) => url.pathname === "/api/v1/media/recovery-media-video/content", () => new Promise(() => {}));

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-hung-video"]');
  await expect(node.locator(".kc-node-loading").first()).toBeAttached();
  // The video metadata wait is bounded: a never-usable source settles to an
  // explicit failure with retry instead of a permanent loading spinner.
  await expect(node.getByText("视频加载失败")).toBeVisible({ timeout: 25_000 });
  await expect(node.getByRole("button", { name: "重新加载" })).toBeVisible();
});

test("a successfully delayed media still displays after its bounded wait", async ({ page }) => {
  await seedProject(page, [completedMediaNode("node-delayed", 40, 80, "image", "recovery-media-delayed")]);
  await mockBaseApis(page);
  await routeJobList(page, []);
  await page.route((url) => url.pathname === "/api/v1/media/recovery-media-delayed/content", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.fulfill({ body: visiblePng, contentType: "image/png" });
  });

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-delayed"]');
  await expect(node.getByText("结果已生成，正在载入")).toBeVisible();
  const image = node.locator('img[data-media-id="recovery-media-delayed"]');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(node.getByText("结果已生成，正在载入")).toHaveCount(0);
});
