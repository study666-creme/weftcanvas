import { expect, test, type Locator, type Page } from "@playwright/test";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
});

test("cached server media survives a refresh when the media API is unavailable", async ({
  page,
}) => {
  const mediaId = "server-cached-image";
  let mediaAvailable = true;
  let mediaReads = 0;
  let unavailableReads = 0;

  await seedServerImageProject(page, mediaId);
  await page.route(`**/api/v1/media/${mediaId}/content`, (route) => {
    mediaReads += 1;
    if (!mediaAvailable) {
      unavailableReads += 1;
      return route.fulfill({ status: 503, body: "temporarily unavailable" });
    }
    return route.fulfill({ body: PIXEL, contentType: "image/png" });
  });

  await page.goto("/canvas");
  const image = page.locator(`img[alt="server-result.png"]`);
  await expectLoadedImage(image);
  await expect
    .poll(() => readCachedMedia(page, mediaId))
    .toEqual({
      id: mediaId,
      source: "server",
      blobSize: PIXEL.length,
      blobType: "image/png",
    });

  const readsBeforeRefresh = mediaReads;
  mediaAvailable = false;
  await page.reload();

  await expectLoadedImage(image);
  await expect(image).toHaveAttribute("src", /^blob:/);
  expect(unavailableReads).toBe(0);
  expect(mediaReads).toBe(readsBeforeRefresh);
});

test("completed server media shows an explicit loading state and appears without a fade", async ({
  page,
}) => {
  const mediaId = "fresh-server-image";
  let releaseMedia!: () => void;
  const mediaGate = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });

  await seedServerImageProject(page, mediaId);
  await page.route(`**/api/v1/media/${mediaId}/content`, async (route) => {
    await mediaGate;
    await route.fulfill({ body: PIXEL, contentType: "image/png" });
  });

  await page.goto("/canvas", { waitUntil: "domcontentloaded" });
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await expect(imageNode.getByText("结果已生成，正在载入")).toBeVisible();
  await expect(imageNode.locator('img[alt="server-result.png"]')).toHaveCount(1);

  releaseMedia();
  await expectLoadedImage(imageNode.locator('img[alt="server-result.png"]'));
  await expect(imageNode.locator(".wc-media-result-state")).toHaveCount(0);
  await expect(imageNode.locator('img[alt="server-result.png"]')).toHaveCSS(
    "visibility",
    "visible",
  );
  await expect(imageNode.locator('img[alt="server-result.png"]')).toHaveCSS("opacity", "1");
});

test("replaced local media remains available to undo history and the canvas clipboard", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/canvas");

  const imageNodes = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const originalNode = imageNodes.first();
  const input = originalNode.locator('input[type="file"]');
  await input.setInputFiles({ name: "undo-source.png", mimeType: "image/png", buffer: PIXEL });
  await expectLoadedImage(originalNode.locator('img[alt="undo-source.png"]'));
  await expect(page.locator(".wc-workspace-assets-trigger")).toHaveAttribute(
    "data-save-state",
    "saved",
  );

  const originalMediaId = await activeImageMediaId(page);
  expect(originalMediaId).toBeTruthy();
  await originalNode.locator(".wc-node-drag-strip").click();
  await page.keyboard.press("Control+C");

  await ageCachedMedia(page, originalMediaId!);
  await input.setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: PIXEL });
  await expectLoadedImage(originalNode.locator('img[alt="replacement.png"]'));
  await expect(page.locator(".wc-workspace-assets-trigger")).toHaveAttribute(
    "data-save-state",
    "saved",
  );
  await expect.poll(() => readCachedMedia(page, originalMediaId!)).not.toBeNull();

  await originalNode.locator(".wc-node-drag-strip").click();
  await page.keyboard.press("Control+Z");
  await expectLoadedImage(originalNode.locator('img[alt="undo-source.png"]'));

  await page.keyboard.press("Control+Shift+Z");
  await expectLoadedImage(originalNode.locator('img[alt="replacement.png"]'));
  await page.keyboard.press("Control+V");

  await expect(imageNodes).toHaveCount(2);
  await expectLoadedImage(imageNodes.locator('img[alt="undo-source.png"]'));
});

async function expectLoadedImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}

async function activeImageMediaId(page: Page) {
  return page.evaluate(() => {
    const projectId = localStorage.getItem("weftcanvas:active-project:v1");
    const raw = projectId
      ? localStorage.getItem(`weftcanvas:project-data:v1:${encodeURIComponent(projectId)}`)
      : null;
    if (!raw) return null;
    const project = JSON.parse(raw) as {
      nodes?: Array<{ data?: { kind?: string; media?: { id?: string } | null } }>;
    };
    return project.nodes?.find((node) => node.data?.kind === "image")?.data?.media?.id ?? null;
  });
}

async function readCachedMedia(page: Page, mediaId: string) {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weftcanvas-media", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const record = await new Promise<{
        id: string;
        source: string;
        blob: Blob;
      } | null>((resolve, reject) => {
        const request = database.transaction("media", "readonly").objectStore("media").get(id);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
      return record
        ? {
            id: record.id,
            source: record.source,
            blobSize: record.blob.size,
            blobType: record.blob.type,
          }
        : null;
    } finally {
      database.close();
    }
  }, mediaId);
}

async function ageCachedMedia(page: Page, mediaId: string) {
  await page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("weftcanvas-media", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("media", "readwrite");
        const store = transaction.objectStore("media");
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result) store.put({ ...request.result, storedAt: Date.now() - 61_000 });
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, mediaId);
}

async function seedServerImageProject(page: Page, mediaId: string) {
  await page.addInitScript(
    ({ id, size }) => {
      localStorage.clear();
      sessionStorage.clear();
      const now = Date.now();
      const projectId = "server-media-cache-project";
      const project = {
        schemaVersion: 1,
        id: projectId,
        name: "Server media cache",
        nodes: [
          {
            id: "server-image-node",
            type: "weftcanvas",
            position: { x: 420, y: 180 },
            width: 360,
            height: 360,
            selected: false,
            data: {
              kind: "image",
              body: "",
              accent: "blue",
              status: "success",
              progress: null,
              media: {
                id,
                name: "server-result.png",
                mimeType: "image/png",
                size,
                source: "server",
                serverId: id,
                width: 1,
                height: 1,
                durationMs: null,
              },
              directorCapture: null,
              config: null,
              generation: {
                modelId: null,
                parameters: {},
                maxOutputTokens: null,
                referenceMode: "auto",
                referenceNodeIds: [],
                jobId: null,
                jobVersion: null,
                jobCreatedAt: null,
                jobStatus: null,
                error: null,
              },
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
        edges: [],
        groups: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: now,
        updatedAt: now,
      };
      localStorage.setItem(
        `weftcanvas:project-data:v1:${encodeURIComponent(projectId)}`,
        JSON.stringify(project),
      );
      localStorage.setItem(
        "weftcanvas:projects:v1",
        JSON.stringify({
          version: 1,
          projects: [
            { id: projectId, name: project.name, createdAt: now, updatedAt: now, nodeCount: 1 },
          ],
        }),
      );
      localStorage.setItem("weftcanvas:active-project:v1", projectId);
    },
    { id: mediaId, size: PIXEL.length },
  );
}
