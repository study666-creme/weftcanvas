import { expect, test, type Page } from "@playwright/test";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type GenerationStatus = "running" | "completed";

type BrowserNodeSnapshot = {
  body: string;
  status: string;
  progress: number | null;
  jobId: string | null;
  jobStatus: string | null;
  mediaId: string | null;
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          version: "generation-history-empty-catalog",
          capabilityVersion: "generation-history-empty-capability",
          pricingVersion: "generation-history-empty-pricing",
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          quoteAvailable: false,
          models: [],
        },
      },
    }),
  );
  await page.route("**/api/v1/generation-jobs*", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 500,
        json: { ok: false, error: { message: "Unexpected generation POST" } },
      });
    }
    return route.fulfill({ json: { ok: true, data: [] } });
  });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
});

test("Ctrl+Z keeps a newly created running generation node while undoing a normal prompt edit", async ({
  page,
}) => {
  let generationPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/api/v1/generation-jobs")
    ) {
      generationPosts += 1;
    }
  });

  await openCanvas(page);
  const nodeId = await createGenerationNode(page, "running");
  const node = page.locator(`.react-flow__node-weftcanvas[data-id="${nodeId}"]`);

  await expect(node).toBeVisible();
  await expect(node.locator(".wc-node-loading")).toHaveAttribute(
    "data-generation-stage",
    "running",
  );
  await expect
    .poll(() => readNode(page, nodeId))
    .toMatchObject({
      status: "running",
      progress: 37,
      jobId: "job-browser-running",
      jobStatus: "running",
      mediaId: null,
    });

  await pressUndo(page);

  await expect(node).toBeVisible();
  await expect(node.locator(".wc-node-loading")).toHaveAttribute(
    "data-generation-stage",
    "running",
  );
  await expect
    .poll(() => readNode(page, nodeId))
    .toMatchObject({
      body: "initial prompt",
      status: "running",
      progress: 37,
      jobId: "job-browser-running",
      jobStatus: "running",
      mediaId: null,
    });

  await updatePrompt(page, nodeId, "ordinary prompt edit");
  await expect
    .poll(() => readNode(page, nodeId))
    .toMatchObject({
      body: "ordinary prompt edit",
      status: "running",
    });

  await pressUndo(page);

  await expect(node).toBeVisible();
  await expect
    .poll(() => readNode(page, nodeId))
    .toEqual({
      body: "initial prompt",
      status: "running",
      progress: 37,
      jobId: "job-browser-running",
      jobStatus: "running",
      mediaId: null,
    });
  expect(generationPosts).toBe(0);
});

test("Ctrl+Z keeps a completed generation node and media through prompt and creation history", async ({
  page,
}) => {
  let generationPosts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/api/v1/generation-jobs")
    ) {
      generationPosts += 1;
    }
  });
  await page.route("**/api/v1/media/browser-result/content", (route) =>
    route.fulfill({
      body: PIXEL,
      contentType: "image/png",
    }),
  );

  await openCanvas(page);
  const nodeId = await createGenerationNode(page, "completed");
  const node = page.locator(`.react-flow__node-weftcanvas[data-id="${nodeId}"]`);
  const image = node.locator('img[data-media-id="browser-result"]');

  await expect(node).toBeVisible();
  await expect(image).toBeVisible();
  await expect
    .poll(() => readNode(page, nodeId))
    .toMatchObject({
      body: "initial prompt",
      status: "success",
      progress: null,
      jobId: "job-browser-completed",
      jobStatus: "completed",
      mediaId: "browser-result",
    });

  await updatePrompt(page, nodeId, "ordinary completed edit");
  await expect
    .poll(() => readNode(page, nodeId))
    .toMatchObject({ body: "ordinary completed edit" });
  await pressUndo(page);

  await expect(node).toBeVisible();
  await expect(image).toBeVisible();
  await expect
    .poll(() => readNode(page, nodeId))
    .toEqual({
      body: "initial prompt",
      status: "success",
      progress: null,
      jobId: "job-browser-completed",
      jobStatus: "completed",
      mediaId: "browser-result",
    });

  await pressUndo(page);
  await pressUndo(page);

  await expect(node).toBeVisible();
  await expect(image).toBeVisible();
  await expect
    .poll(() => readNode(page, nodeId))
    .toMatchObject({
      status: "success",
      jobId: "job-browser-completed",
      jobStatus: "completed",
      mediaId: "browser-result",
    });
  expect(generationPosts).toBe(0);
});

async function openCanvas(page: Page) {
  await page.goto("/canvas");
  await expect(page.locator(".wc-canvas-entry-loader")).toHaveCount(0, { timeout: 4_000 });
}

async function createGenerationNode(page: Page, status: GenerationStatus) {
  const imageNodes = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const existingNodeIds = await imageNodes.evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute("data-id"))
      .filter((id): id is string => Boolean(id)),
  );
  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加图片节点" })
    .click();
  await expect(imageNodes).toHaveCount(existingNodeIds.length + 1);
  const currentNodeIds = await imageNodes.evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute("data-id"))
      .filter((id): id is string => Boolean(id)),
  );
  const nodeId = currentNodeIds.find((id) => !existingNodeIds.includes(id));
  if (!nodeId) throw new Error("Failed to locate the created browser history node");

  await page.evaluate(
    async ({ nodeId, status }) => {
      const storeUrl = "/src/state/canvas-store.ts";
      const { useCanvasStore } = await import(/* @vite-ignore */ storeUrl);
      const store = useCanvasStore.getState();
      store.updateNodeData(nodeId, { body: "initial prompt" }, false);
      const createdAt = "2026-07-29T02:00:00.000Z";
      const jobId = `job-browser-${status}`;
      const quote = {
        id: `quote-browser-${status}`,
        modelId: "browser-image-model",
        modelLabel: "Browser image model",
        modality: "image" as const,
        quantity: 1,
        normalizedParameters: { prompt: "initial prompt" },
        creditMicros: 1,
        credits: "0.000001",
        yuanMicros: 1,
        yuan: "0.000001",
        estimated: false,
        pricingUnit: "image" as const,
        catalogVersion: "browser-catalog",
        capabilityVersion: "browser-capability",
        pricingVersion: "browser-pricing",
        expiresAt: "2026-07-29T03:00:00.000Z",
      };

      store.applyGenerationJob({
        schemaVersion: 1,
        version: status === "completed" ? 2 : 1,
        id: jobId,
        projectId: store.projectId,
        nodeId,
        modelId: "browser-image-model",
        modelLabel: "Browser image model",
        modality: "image",
        status,
        progress: status === "completed" ? 100 : 37,
        quote,
        artifacts:
          status === "completed"
            ? [
                {
                  id: "artifact-browser-result",
                  kind: "image" as const,
                  mediaId: "browser-result",
                  name: "browser-result.png",
                  mimeType: "image/png",
                  size: 68,
                  width: 1,
                  height: 1,
                  createdAt,
                },
              ]
            : [],
        error: null,
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt,
        completedAt: status === "completed" ? createdAt : null,
      });
    },
    { nodeId, status },
  );
  return nodeId;
}

async function updatePrompt(page: Page, nodeId: string, body: string) {
  await page.evaluate(
    async ({ nodeId, body }) => {
      const storeUrl = "/src/state/canvas-store.ts";
      const { useCanvasStore } = await import(/* @vite-ignore */ storeUrl);
      useCanvasStore.getState().updateNodeData(nodeId, { body });
    },
    { nodeId, body },
  );
}

async function readNode(page: Page, nodeId: string): Promise<BrowserNodeSnapshot | null> {
  return page.evaluate(
    async ({ nodeId }) => {
      const storeUrl = "/src/state/canvas-store.ts";
      const { useCanvasStore } = await import(/* @vite-ignore */ storeUrl);
      const node = useCanvasStore
        .getState()
        .nodes.find((item: { id: string }) => item.id === nodeId);
      if (!node) return null;
      return {
        body: node.data.body,
        status: node.data.status,
        progress: node.data.progress,
        jobId: node.data.generation.jobId,
        jobStatus: node.data.generation.jobStatus,
        mediaId: node.data.media?.id ?? null,
      };
    },
    { nodeId },
  );
}

async function pressUndo(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+Z");
}
