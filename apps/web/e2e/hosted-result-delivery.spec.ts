import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// Hosted result delivery gate: a job that has completed upstream (an
// APIMart-shaped public result) must be deterministically delivered to the
// owning Canvas node over the browser observation lifecycle (SSE, then bounded
// polling), applied exactly once, and leave the node settled after reload.
// A genuinely non-progressing observation must exit the ordinary animation
// into the explicit temporarily-unavailable state. All upstream routes are
// mocked; no real provider or generation request is ever issued.
const visiblePng = readFileSync(new URL("../src/assets/card-library-logo.png", import.meta.url));

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
  version: "hosted-catalog",
  capabilityVersion: "hosted-capability",
  pricingVersion: "hosted-pricing",
  fetchedAt: nowIso(),
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  quoteAvailable: false,
  models: [],
};

function quote() {
  return {
    id: "quote-hosted-1",
    modelId: "mj-v81",
    modelLabel: "Midjourney 8.1",
    modality: "image",
    quantity: 1,
    normalizedParameters: { prompt: "hosted fixture", n: 1 },
    creditMicros: 40_000_000,
    credits: "40",
    yuanMicros: 400_000,
    yuan: "0.4",
    estimated: false,
    pricingUnit: "request",
    outputCount: 2,
    catalogVersion: "hosted-catalog",
    capabilityVersion: "hosted-capability",
    pricingVersion: "hosted-pricing",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

function runningJob(id: string, nodeId: string, projectId = "hosted-project") {
  const createdAt = nowIso();
  return {
    schemaVersion: 1,
    version: 1,
    id,
    projectId,
    nodeId,
    modelId: "mj-v81",
    modelLabel: "Midjourney 8.1",
    modality: "image",
    status: "running",
    progress: 42,
    quote: quote(),
    artifacts: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
  };
}

function completedJob(id: string, nodeId: string, projectId = "hosted-project") {
  const createdAt = nowIso();
  const primary = {
    id: `artifact-${id}-primary`,
    kind: "image",
    mediaId: "phm_hosted_primary",
    name: "result-1.png",
    mimeType: "image/png",
    size: visiblePng.byteLength,
    width: 128,
    height: 128,
    createdAt,
  };
  const extra = {
    id: `artifact-${id}-extra`,
    kind: "image",
    mediaId: "phm_hosted_extra",
    name: "result-2.png",
    mimeType: "image/png",
    size: visiblePng.byteLength,
    width: 128,
    height: 128,
    createdAt,
  };
  return {
    schemaVersion: 1,
    version: 2,
    id,
    projectId,
    nodeId,
    modelId: "mj-v81",
    modelLabel: "Midjourney 8.1",
    modality: "image",
    status: "completed",
    progress: 100,
    quote: quote(),
    artifacts: [primary, extra],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
  };
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
      body: "托管生成节点",
      accent: "blue",
      status: "running",
      progress: null,
      media: null,
      directorCapture: null,
      config: null,
      generation: {
        modelId: "mj-v81",
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

async function seedProject(page: Page, nodes: unknown[]) {
  const time = Date.now();
  const project = {
    schemaVersion: 1,
    id: "hosted-project",
    name: "Hosted delivery",
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
  }, { project });
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
  await page.route("**/api/v1/card-library/groups", (route) => route.fulfill({ json: { ok: true, data: { groups: [] } } }));
  await page.route("**/api/v1/card-library/cards*", (route) => route.fulfill({
    json: { ok: true, data: { cards: [], total: 0, page: 1, limit: 18 } },
  }));
  await page.route((url) => url.pathname.startsWith("/api/v1/media/phm_hosted_") && url.pathname.endsWith("/content"), (route) => {
    return route.fulfill({ body: visiblePng, contentType: "image/png" });
  });
}

function routeJobList(page: Page, jobs: unknown[]) {
  return page.route((url) => url.pathname === "/api/v1/generation-jobs" && url.searchParams.has("projectId"), (route) => {
    return route.fulfill({ json: { ok: true, data: jobs } });
  });
}

function sseBody(events: Array<{ id: string; job: unknown }>) {
  return events.map(({ id, job }) => `id: ${id}\nevent: job\ndata: ${JSON.stringify({ type: "job", job })}\n\n`).join("");
}

test("a running image node receives its completed hosted result over the event stream, applies it exactly once, and stays settled after reload", async ({ page }) => {
  test.setTimeout(60_000);
  await seedProject(page, [mediaNode("node-hosted", 40, 80, {
    jobId: "job-hosted-1",
    jobVersion: 1,
    jobCreatedAt: nowIso(),
    jobStatus: "running",
    progress: 42,
    error: null,
  })]);
  await mockBaseApis(page);
  const completed = completedJob("job-hosted-1", "node-hosted");
  const running = runningJob("job-hosted-1", "node-hosted");
  await routeJobList(page, [running]);
  // A stale running public snapshot first, then the completed APIMart-shaped
  // public result, on the same bounded event stream.
  await page.route((url) => url.pathname === "/api/v1/generation-jobs/job-hosted-1/events", (route) => {
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: sseBody([
        { id: "generation:job-hosted-1:1", job: running },
        { id: "generation:job-hosted-1:2", job: completed },
      ]),
    });
  });
  // Polling GETs (should not be needed once SSE delivers) still stay truthful.
  await page.route((url) => url.pathname === "/api/v1/generation-jobs/job-hosted-1" && !url.pathname.endsWith("/events"), (route) => {
    return route.fulfill({ json: { ok: true, data: running } });
  });

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-hosted"]');

  // The primary artifact replaces the origin node and the additional artifact
  // becomes one connected node exactly once, and the spinner/effect disappears.
  await expect(node.locator('img[data-media-id="phm_hosted_primary"]')).toBeVisible({ timeout: 10_000 });
  await expect(node.locator(".kc-node-loading")).toHaveCount(0);
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(2);
  await expect(page.locator('img[data-media-id="phm_hosted_extra"]')).toHaveCount(1);
  await expect(node.locator(".kc-node-wrap")).toHaveAttribute("data-node-status", "success");

  // Reload remains settled: recovery re-lists the completed job and applies it
  // idempotently (no duplicate nodes, no spinner).
  await page.route((url) => url.pathname === "/api/v1/generation-jobs/job-hosted-1" && !url.pathname.endsWith("/events"), (route) => {
    return route.fulfill({ json: { ok: true, data: completed } });
  });
  await page.reload();
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });
  await expect(node.locator('img[data-media-id="phm_hosted_primary"]')).toBeVisible({ timeout: 10_000 });
  await expect(node.locator(".kc-node-loading")).toHaveCount(0);
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(2);
  await expect(page.locator('img[data-media-id="phm_hosted_extra"]')).toHaveCount(1);
});

test("a genuinely non-progressing observation exits the ordinary animation into the explicit unavailable state", async ({ page }) => {
  test.setTimeout(60_000);
  await seedProject(page, [mediaNode("node-stagnant", 40, 80, {
    jobId: "job-hosted-stagnant",
    jobVersion: 1,
    jobCreatedAt: nowIso(),
    jobStatus: "running",
    progress: 42,
    error: null,
  })]);
  await mockBaseApis(page);
  const running = runningJob("job-hosted-stagnant", "node-stagnant");
  await routeJobList(page, [running]);
  // The event stream emits only the same stale running snapshot, repeatedly.
  // That is transport success but not job progress: bounded observation must
  // converge to the explicit non-spinning temporarily-unavailable state.
  const repeated = Array.from({ length: 601 }, () => ({ id: "generation:job-hosted-stagnant:1", job: running }));
  await page.route((url) => url.pathname === "/api/v1/generation-jobs/job-hosted-stagnant/events", (route) => {
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: sseBody(repeated),
    });
  });
  await page.route((url) => url.pathname === "/api/v1/generation-jobs/job-hosted-stagnant" && !url.pathname.endsWith("/events"), (route) => {
    return route.fulfill({ json: { ok: true, data: running } });
  });

  await page.goto("/canvas");
  await expect(page.locator(".kc-canvas-entry-loader")).toHaveCount(0, { timeout: 20_000 });

  const node = page.locator('.react-flow__node-kachang[data-id="node-stagnant"]');
  await expect(node.locator(".kc-node-loading")).toHaveAttribute("data-generation-stage", "running");

  // The ordinary animation visibly exits: no spinner, no beam sweep, only the
  // explicit truthful "暂时无法更新" copy with the recovery hint.
  await expect(node.locator(".kc-node-loading")).toHaveAttribute("data-observation-exhausted", "true", { timeout: 15_000 });
  await expect(node.getByText("暂时无法更新")).toBeVisible();
  await expect(node.locator(".kc-node-loading-spinner")).toHaveCount(0);
  await expect(node.locator(".kc-node-loading-beam")).toHaveCount(0);
});
