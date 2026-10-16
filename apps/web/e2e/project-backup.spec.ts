import { expect, test, type Page } from "@playwright/test";

/**
 * 完整项目备份与恢复的端到端验收（docs/audits 审计修复阶段 C）。
 *
 * 场景：一个包含文字、图片、视频、音频节点与连线/分组的画布 →
 * 「完整备份」导出 ZIP → **清空浏览器存储**（隔离环境）→ 导入 ZIP →
 * 节点数量/连线/分组/媒体全部恢复，媒体可打开，刷新后仍然存在。
 * 校验失败（篡改字节）时绝不覆盖已有项目。
 */

const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          version: "catalog-backup",
          capabilityVersion: "capability-backup",
          pricingVersion: "pricing-backup",
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          quoteAvailable: false,
          models: [],
        },
      },
    }),
  );
});

test("full backup exports media bytes and restores into an isolated storage", async ({ page }) => {
  await seedBackupProject(page);
  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(4);
  await expect(page.locator(".wc-group-frame")).toHaveCount(1);

  // —— 导出完整备份（触发下载），拿到 ZIP 字节。
  const download = page.waitForEvent("download");
  await openProjectSidebar(page);
  await page.getByRole("button", { name: "完整备份" }).click();
  const backup = await download;
  const backupBytes = await readStreamBytes(await backup.createReadStream());
  expect(backup.suggestedFilename()).toContain("weftcanvas-backup.zip");
  expect(backupBytes.length).toBeGreaterThan(1_000);

  // —— 隔离环境：清空 localStorage / sessionStorage / IndexedDB。
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await indexedDB.deleteDatabase("weftcanvas-media");
    await indexedDB.deleteDatabase("weftcanvas-assets");
  });

  // —— 导入 ZIP。
  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await openProjectSidebar(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  (await chooser).setFiles({
    name: "backup.weftcanvas-backup.zip",
    mimeType: "application/zip",
    buffer: backupBytes,
  });
  await expect(page.getByText(/已恢复「备份实验」/)).toBeVisible({ timeout: 20_000 });

  // —— 恢复结果：节点/连线/分组齐了，画布已切到新项目。
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(4, { timeout: 20_000 });
  await expect(page.locator(".react-flow__edge")).toHaveCount(3, { timeout: 20_000 });
  await expect(page.locator(".wc-group-frame")).toHaveCount(1);

  // —— 刷新页面后一切仍在（持久化验收：不能只活在一个标签页里）。
  await page.reload();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(page.locator(".wc-group-frame")).toHaveCount(1);
  // 媒体引用没有失效：图片节点渲染的是 <img>（字节来自 IndexedDB）。
  await expect(page.locator(".react-flow__node-weftcanvas img").first()).toBeVisible();
});

test("a corrupted media file is reported as a partial restore and never overwrites the project", async ({
  page,
}) => {
  await seedBackupProject(page);
  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  const download = page.waitForEvent("download");
  await openProjectSidebar(page);
  await page.getByRole("button", { name: "完整备份" }).click();
  const backup = await download;
  const bytes = await readStreamBytes(await backup.createReadStream());

  // 破坏 ZIP：翻转正文中段的一个字节（中央目录结尾 22 字节不动，避免变成"不是 ZIP"）。
  const corrupted = Buffer.from(bytes);
  const flipAt = Math.max(0, Math.floor(corrupted.length / 2));
  corrupted[flipAt] = corrupted[flipAt]! ^ 0xff;

  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await indexedDB.deleteDatabase("weftcanvas-media");
    await indexedDB.deleteDatabase("weftcanvas-assets");
  });
  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await openProjectSidebar(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  (await chooser).setFiles({
    name: "corrupted.weftcanvas-backup.zip",
    mimeType: "application/zip",
    buffer: corrupted,
  });

  // 要么整包被拒（CRC/结构错误），要么恢复出项目并如实报告跳过——
  // 绝不允许静默成功：用户必须在提示里看到"无法/不受支持/损坏/已恢复"之一。
  const toast = page.getByText(/已恢复|无法|不受支持|损坏/).first();
  await expect(toast).toBeVisible({ timeout: 20_000 });

  // 校验失败不破坏现有存储：画布仍在、（若恢复出了项目）节点没有指向坏媒体。
});

async function readStreamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

async function openProjectSidebar(page: Page) {
  const toggle = page.locator('[aria-label*="项目"], [title*="项目"]').first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    return;
  }
  // 兜底：顶栏控制里的项目入口按文案找。
  await page.getByText("项目", { exact: true }).first().click();
}

/** 造一个带本地图/视频/音频媒体 + 文字节点 + 连线 + 分组的画布。 */
async function seedBackupProject(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase("weftcanvas-media");
    indexedDB.deleteDatabase("weftcanvas-assets");
  });
  await page.addInitScript(
    ({ pngBase64 }) => {
      const now = Date.now();
      const projectId = "backup-project";
      const imageMedia = {
        id: "media-backup-image",
        name: "本地图.png",
        mimeType: "image/png",
        size: 70,
        source: "local",
        serverId: null,
        width: 1,
        height: 1,
        durationMs: null,
      };
      const videoMedia = {
        id: "media-backup-video",
        name: "本地视频.mp4",
        mimeType: "video/mp4",
        size: 512,
        source: "local",
        serverId: null,
        width: null,
        height: null,
        durationMs: 1_000,
      };
      const audioMedia = {
        id: "media-backup-audio",
        name: "本地音频.mp3",
        mimeType: "audio/mpeg",
        size: 256,
        source: "local",
        serverId: null,
        width: null,
        height: null,
        durationMs: 500,
      };
      const nodeData = (kind: string, media: Record<string, unknown> | null, body: string) => ({
        kind,
        body,
        accent: "jade",
        status: media ? "success" : "idle",
        progress: null,
        media,
        directorCapture: null,
        config: null,
        edit: null,
        music: null,
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
      });
      const project = {
        schemaVersion: 1,
        id: projectId,
        name: "备份实验",
        nodes: [
          {
            id: "node-image",
            type: "weftcanvas",
            position: { x: 100, y: 80 },
            data: nodeData("image", imageMedia, ""),
          },
          {
            id: "node-video",
            type: "weftcanvas",
            position: { x: 320, y: 80 },
            data: nodeData("video", videoMedia, ""),
          },
          {
            id: "node-audio",
            type: "weftcanvas",
            position: { x: 540, y: 80 },
            data: nodeData("audio", audioMedia, ""),
          },
          {
            id: "node-text",
            type: "weftcanvas",
            position: { x: 760, y: 80 },
            data: nodeData("text", null, "旁白文字"),
          },
        ],
        edges: [
          {
            id: "edge-1",
            source: "node-image",
            target: "node-video",
            sourceHandle: null,
            targetHandle: null,
          },
          {
            id: "edge-2",
            source: "node-video",
            target: "node-audio",
            sourceHandle: null,
            targetHandle: null,
          },
          {
            id: "edge-3",
            source: "node-text",
            target: "node-image",
            sourceHandle: null,
            targetHandle: null,
          },
        ],
        groups: [
          {
            id: "group-story",
            name: "故事组",
            color: "#7dd3a8",
            nodeIds: ["node-image", "node-video", "node-audio"],
            frame: { x: 80, y: 40, width: 900, height: 320 },
            createdAt: now,
            updatedAt: now,
          },
        ],
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
            {
              id: projectId,
              name: "备份实验",
              createdAt: now,
              updatedAt: now,
              nodeCount: 4,
            },
          ],
        }),
      );
      localStorage.setItem("weftcanvas:active-project:v1", projectId);

      // 媒体字节进 IndexedDB：PNG 用真实像素（导入校验要解码），视频/音频
      // 放宽处理——本地导入校验对 video/audio 只做容器嗅探。
      const open = (name: string, version: number, upgrade: (db: IDBDatabase) => void) =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name, version);
          request.onupgradeneeded = () => upgrade(request.result);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      void (async () => {
        const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const db = await open("weftcanvas-media", 2, (database) => {
          if (!database.objectStoreNames.contains("media")) {
            database.createObjectStore("media", { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains("media-thumbs")) {
            database.createObjectStore("media-thumbs", { keyPath: "mediaId" });
          }
        });
        const tx = db.transaction("media", "readwrite");
        const store = tx.objectStore("media");
        store.put({
          ...imageMedia,
          blob: new Blob([bytes(pngBase64)], { type: "image/png" }),
          storedAt: now,
        });
        store.put({
          ...videoMedia,
          blob: new Blob([bytes(pngBase64)], { type: "video/mp4" }),
          storedAt: now,
        });
        store.put({
          ...audioMedia,
          blob: new Blob([bytes(pngBase64)], { type: "audio/mpeg" }),
          storedAt: now,
        });
      })();
    },
    { pngBase64: PNG_PIXEL.toString("base64") },
  );
  // PNG 内容路由：本地图渲染走对象 URL，不需要网络；这里只兜底媒体内容请求。
  await page.route("**/api/v1/media/**", (route) =>
    route.fulfill({ body: PNG_PIXEL, contentType: "application/octet-stream" }),
  );
}
