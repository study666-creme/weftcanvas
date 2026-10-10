import { expect, test, type Locator, type Page } from "@playwright/test";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({ json: { ok: true, data: { version: "catalog-persist", capabilityVersion: "capability-persist", pricingVersion: "pricing-persist", fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), quoteAvailable: false, models: [] } } }));
});

test("graph identity, parameters, task status, groups, and media references survive reload and switching", async ({ page }) => {
  let submissionPosts = 0;
  await page.route("**/api/v1/generation-jobs", (route) => {
    if (route.request().method() === "POST") submissionPosts += 1;
    return route.fulfill({ json: { ok: true, data: [] } });
  });
  await page.route("**/api/v1/generation-quotes", (route) => route.fulfill({ json: { ok: true, data: [] } }));
  await page.route("**/api/v1/media/server-media-1/content", (route) => route.fulfill({ body: PIXEL, contentType: "image/png" }));
  await seedPersistedProject(page);

  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.getByText("持久化分镜", { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node-kachang')).toHaveCount(5);
  await expectLoadedImage(page.locator('img[alt="server-result.png"]'));
  await expect(page.locator('.react-flow__node-kachang:has(.kc-media-empty--error)')).toHaveCount(1);
  await expect(page.locator(".kc-group-frame")).toHaveCount(1);
  await expect(page.locator(".kc-group-frame")).toContainText("故事组");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  await page.reload();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.getByText("持久化分镜", { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node-kachang')).toHaveCount(5);
  await expectLoadedImage(page.locator('img[alt="server-result.png"]'));
  await expect(page.locator('.react-flow__node-kachang:has(.kc-media-empty--error)')).toHaveCount(1);
  await expect(page.locator(".kc-group-frame")).toHaveCount(1);

  const persisted = await readPersistedProject(page, "persist-project");
  expect(persisted.nodes.map((node) => node.id).sort()).toEqual(["config-c", "image-b", "image-gen", "node-unknown", "text-a"]);
  expect(persisted.edges).toHaveLength(2);
  expect(persisted.groups).toHaveLength(1);
  const imageGen = persisted.nodes.find((node) => node.id === "image-gen")!;
  expect(imageGen.data.media?.id).toBe("server-media-1");
  expect(imageGen.data.media?.source).toBe("server");
  expect(imageGen.data.generation.parameters).toEqual({ ratio: "16:9", quality: "1" });
  expect(imageGen.data.generation.jobStatus).toBe("completed");
  const localImage = persisted.nodes.find((node) => node.id === "image-b")!;
  expect(localImage.data.media?.id).toBe("media-local-1");
  expect(localImage.data.media?.name).toBe("frame.png");
  const unknown = persisted.nodes.find((node) => node.id === "node-unknown")!;
  expect(unknown.data.generation.jobStatus).toBe("submission_unknown");
  // Persist the original snapshot losslessly. The node component derives an
  // error surface from submission_unknown even for this legacy running value.
  expect(unknown.data.status).toBe("running");

  let sidebar = await openProjectLibrary(page);
  await sidebar.getByLabel("新建项目").click();
  await expect(page.getByLabel("项目名称")).toHaveValue("卡藏画布 1");
  await expect(page.locator('.react-flow__node-kachang')).toHaveCount(0);
  await expect(page.getByText("持久化分镜", { exact: true })).toHaveCount(0);

  sidebar = await openProjectLibrary(page);
  await projectRow(page, "持久化画布").locator(".kc-project-open").click();
  await expect(page.getByLabel("项目名称")).toHaveValue("持久化画布");
  await expect(page.getByText("持久化分镜", { exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node-kachang')).toHaveCount(5);
  await expectLoadedImage(page.locator('img[alt="server-result.png"]'));
  await expect(page.locator(".kc-group-frame")).toHaveCount(1);

  expect(submissionPosts).toBe(0);
});

test("importing a project file creates a fresh copy, and rejected files leave the current project intact", async ({ page }) => {
  await cleanLibrary(page);
  await seedPersistedProject(page);
  await page.route("**/api/v1/media/server-media-1/content", (route) => route.fulfill({ body: PIXEL, contentType: "image/png" }));

  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.getByLabel("项目名称")).toHaveValue("持久化画布");

  let sidebar = await openProjectLibrary(page);
  const downloadPromise = page.waitForEvent("download");
  await sidebar.getByRole("button", { name: "导出当前" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("持久化画布.kachang.json");
  const exportedPath = await download.path();
  expect(exportedPath).not.toBeNull();

  await sidebar.locator('input[type="file"]').setInputFiles(exportedPath!);
  await expect(page.getByLabel("项目名称")).toHaveValue("持久化画布 2");
  await expect(page.getByText("持久化分镜", { exact: true })).toBeVisible();

  sidebar = await openProjectLibrary(page);
  await expect(sidebar.locator(".kc-project-row")).toHaveCount(2);
  await sidebar.locator('input[type="file"]').setInputFiles(exportedPath!);
  await expect(page.getByLabel("项目名称")).toHaveValue("持久化画布 3");
  sidebar = await openProjectLibrary(page);
  await expect(sidebar.locator(".kc-project-row")).toHaveCount(3);

  await sidebar.locator('input[type="file"]').setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{ not valid json"),
  });
  await expect(page.getByText("项目文件无效或版本不兼容").first()).toBeVisible();
  await expect(page.getByLabel("项目名称")).toHaveValue("持久化画布 3");

  await sidebar.locator('input[type="file"]').setInputFiles({
    name: "old-version.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 0, id: "old", name: "旧版本" })),
  });
  await expect(page.getByText("项目文件无效或版本不兼容").first()).toBeVisible();
  await expect(page.getByLabel("项目名称")).toHaveValue("持久化画布 3");

  await sidebar.locator('input[type="file"]').setInputFiles({
    name: "huge.json",
    mimeType: "application/json",
    buffer: Buffer.from(`${"x".repeat(4 * 1024 * 1024 + 1)}\n`),
  });
  await expect(page.getByText("项目文件过大，无法导入")).toBeVisible();
  await expect(page.getByLabel("项目名称")).toHaveValue("持久化画布 3");

  await expect(page.locator('.react-flow__node-kachang')).toHaveCount(5);
  await expect(page.getByText("持久化分镜", { exact: true })).toBeVisible();
});

test("a failed project write is visible and retries once storage is available again", async ({ page }) => {
  await cleanLibrary(page);
  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { __restoreProjectStorage: () => void }).__restoreProjectStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("kachang-canvas:project-data")) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });

  const name = page.getByLabel("项目名称");
  await name.fill("写失败画布");
  await name.blur();
  await expect(page.locator('[data-save-state="error"]')).toBeVisible();

  await page.evaluate(() => (window as unknown as { __restoreProjectStorage: () => void }).__restoreProjectStorage());
  await name.fill("写失败画布 已恢复");
  await name.blur();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  const persisted = await readPersistedProject(page);
  expect(persisted.name).toBe("写失败画布 已恢复");
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
]) {
  test(`project create/open/import/export controls stay reachable without overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await cleanLibrary(page);
    await page.goto("/canvas");
    const sidebar = await openProjectLibrary(page);
    await expect(sidebar.getByLabel("新建项目")).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "导入" })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "导出当前" })).toBeVisible();

    await sidebar.getByLabel("新建项目").click();
    await expect(page.getByLabel("项目名称")).toHaveValue("卡藏画布 2");
    const sidebarAfter = await openProjectLibrary(page);
    await expect(sidebarAfter.locator(".kc-project-row")).toHaveCount(2);

    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.width);
    expect(dimensions.scrollHeight).toBe(dimensions.height);
  });
}

async function seedPersistedProject(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase("kachang-canvas-media");
    indexedDB.deleteDatabase("kachang-canvas-assets");
    const now = Date.now();
    const projectId = "persist-project";
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: "持久化画布",
      nodes: [
        {
          id: "text-a",
          type: "kachang",
          position: { x: 120, y: 80 },
          data: {
            kind: "text",
            body: "持久化分镜",
            accent: "jade",
            status: "idle",
            progress: null,
            media: null,
            directorCapture: null,
            config: null,
            generation: {
              modelId: null,
              parameters: {},
              referenceImagePurposes: {},
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
        {
          id: "image-b",
          type: "kachang",
          position: { x: 440, y: 140 },
          data: {
            kind: "image",
            body: "",
            accent: "blue",
            status: "success",
            progress: null,
            media: {
              id: "media-local-1",
              name: "frame.png",
              mimeType: "image/png",
              size: 1024,
              source: "local",
              serverId: null,
              width: 320,
              height: 240,
              durationMs: null,
            },
            directorCapture: null,
            config: null,
            generation: {
              modelId: null,
              parameters: {},
              referenceImagePurposes: {},
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
        {
          id: "image-gen",
          type: "kachang",
          position: { x: 860, y: 140 },
          data: {
            kind: "image",
            body: "夜晚的分镜",
            accent: "blue",
            status: "success",
            progress: null,
            media: {
              id: "server-media-1",
              name: "server-result.png",
              mimeType: "image/png",
              size: 2048,
              source: "server",
              serverId: "server-media-1",
              width: 640,
              height: 360,
              durationMs: null,
            },
            directorCapture: null,
            config: null,
            generation: {
              modelId: "creative-image",
              parameters: { ratio: "16:9" },
              referenceImagePurposes: {},
              maxOutputTokens: null,
              referenceMode: "auto",
              referenceNodeIds: [],
              jobId: "job-completed-1",
              jobVersion: 3,
              jobCreatedAt: "2026-08-01T00:00:00.000Z",
              jobStatus: "completed",
              artifactId: "artifact-completed-1",
              error: null,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: "config-c",
          type: "kachang",
          position: { x: 860, y: 620 },
          data: {
            kind: "config",
            body: "",
            accent: "jade",
            status: "idle",
            progress: null,
            media: null,
            directorCapture: null,
            config: { modality: "image" },
            generation: {
              modelId: "creative-image",
              parameters: { ratio: "16:9", quality: "1" },
              referenceImagePurposes: {},
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
        {
          id: "node-unknown",
          type: "kachang",
          position: { x: 120, y: 460 },
          data: {
            kind: "text",
            body: "待确认任务",
            accent: "jade",
            status: "running",
            progress: null,
            media: null,
            directorCapture: null,
            config: null,
            generation: {
              modelId: "creative-text",
              parameters: {},
              referenceImagePurposes: {},
              maxOutputTokens: 1024,
              referenceMode: "auto",
              referenceNodeIds: [],
              jobId: "browser:unknown-1",
              jobVersion: 1,
              jobCreatedAt: "2026-08-01T00:00:00.000Z",
              jobStatus: "submission_unknown",
              error: null,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      edges: [
        { id: "edge-ab", source: "text-a", target: "image-b" },
        { id: "edge-cg", source: "config-c", target: "image-gen" },
      ],
      groups: [{
        id: "group-1",
        name: "故事组",
        color: "#7dd3a8",
        nodeIds: ["text-a", "image-b"],
        frame: { x: 100, y: 60, width: 720, height: 440 },
        createdAt: now,
        updatedAt: now,
      }],
      viewport: { x: 96, y: 138, zoom: 0.9 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`, JSON.stringify(project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: projectId, name: project.name, createdAt: now, updatedAt: now, nodeCount: project.nodes.length }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", projectId);
  });
}

async function cleanLibrary(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("kachang-project-persistence-e2e-cleaned")) return;
    localStorage.clear();
    indexedDB.deleteDatabase("kachang-canvas-media");
    sessionStorage.setItem("kachang-project-persistence-e2e-cleaned", "1");
  });
}

async function openProjectLibrary(page: Page) {
  await page.getByLabel("项目菜单").click();
  const sidebar = page.locator(".kc-project-sidebar");
  await expect(sidebar).toBeVisible();
  return sidebar;
}

function projectRow(page: Page, name: string) {
  return page.locator(".kc-project-row", {
    has: page.locator(".kc-project-copy strong", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
  });
}

async function readPersistedProject(page: Page, projectId?: string) {
  return page.evaluate((id) => {
    const projectId = id ?? localStorage.getItem("kachang-canvas:active-project:v1");
    if (!projectId) throw new Error("no active project");
    const raw = localStorage.getItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`);
    if (!raw) throw new Error("project data missing");
    return JSON.parse(raw) as {
      name: string;
      nodes: Array<{
        id: string;
        data: {
          status: string;
          generation: { jobStatus: string | null; parameters: Record<string, unknown>; artifactId?: string };
          media: { id: string; name: string; source: string } | null;
        };
      }>;
      edges: unknown[];
      groups: unknown[];
    };
  }, projectId);
}

async function expectLoadedImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
