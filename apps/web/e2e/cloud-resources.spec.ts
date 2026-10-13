import { expect, test } from "./zero-cost-test";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function cloudResource(id: string, name: string, extra: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  return {
    id,
    kind: "image",
    name,
    mimeType: "image/png",
    size: 68,
    status: "ready",
    source: "upload",
    width: 1,
    height: 1,
    durationMs: null,
    projectIds: [],
    orphaned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
}

test("cloud resource dialog releases in-use assets after confirm and caches them locally", async ({
  page,
}, testInfo) => {
  const orphanId = "44444444-4444-4444-8444-444444444444";
  const activeId = "55555555-5555-5555-8555-555555555555";
  const boundId = "66666666-6666-6666-8666-666666666666";
  let cleanupBody: Record<string, unknown> | null = null;

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          user: {
            id: "07d3b269-6bc3-4dbb-b67f-28664c787f00",
            email: "creator@example.com",
            displayName: "创作者",
            createdAt: new Date().toISOString(),
          },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    }),
  );
  await page.route(/\/api\/v1\/cloud-projects(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          projects: [],
          sharedProjects: [],
          usage: {
            projectCount: 0,
            projectStorageBytes: 0,
            mediaStorageBytes: 136,
            entitlements: {
              tier: "free",
              cloudProjectLimit: 3,
              projectStorageBytes: 10 * 1024 * 1024,
              mediaStorageBytes: 300 * 1024 * 1024,
              revisionRetentionCount: 3,
              multiDeviceSync: true,
            },
          },
        },
      },
    }),
  );
  await page.route(/\/api\/v1\/media(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          items: [
            cloudResource(orphanId, "遗留素材.png", { orphaned: true }),
            cloudResource(activeId, "在用素材.png", {}),
            cloudResource(boundId, "绑定素材.png", { projectIds: ["cloud-project-1"] }),
          ],
          usage: {
            usedBytes: 204,
            quotaBytes: 300 * 1024 * 1024,
            boundBytes: 68,
            orphanBytes: 68,
            totalCount: 3,
            orphanCount: 1,
          },
        },
      },
    }),
  );
  await page.route(/\/api\/v1\/media\/[^/]+\/content(?:\?.*)?$/, (route) =>
    route.fulfill({ body: Buffer.from(PNG_BASE64, "base64"), contentType: "image/png" }),
  );
  await page.route(/\/api\/v1\/media\/cleanup$/, async (route) => {
    cleanupBody = JSON.parse(route.request().postData() ?? "{}");
    const ids = new Set((cleanupBody.mediaIds as string[]) ?? []);
    return route.fulfill({
      json: {
        ok: true,
        data: {
          deleted: [
            cloudResource(orphanId, "遗留素材.png", { orphaned: true }),
            cloudResource(activeId, "在用素材.png", {}),
            cloudResource(boundId, "绑定素材.png", { projectIds: ["cloud-project-1"] }),
          ].filter((item) => ids.has(item.id)),
          skipped: [],
          freedBytes: 68 * ids.size,
          usage: {
            usedBytes: 204 - 68 * ids.size,
            quotaBytes: 300 * 1024 * 1024,
            boundBytes: 68,
            orphanBytes: 0,
            totalCount: 3 - ids.size,
            orphanCount: 0,
          },
        },
      },
    });
  });

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    const now = Date.now();
    const projectId = "cloud-resource-e2e";
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: "云资源清理测试",
      nodes: [],
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
          { id: projectId, name: project.name, createdAt: now, updatedAt: now, nodeCount: 0 },
        ],
      }),
    );
    localStorage.setItem("weftcanvas:active-project:v1", projectId);
  });

  await page.goto("/canvas");
  // 侧栏默认收起（visibility:hidden），入口按钮不挂载；直接经 openDialog 打开面板。
  await page.evaluate(async () => {
    const { useCloudResourceStore } = await import("/src/state/cloud-resource-store.ts");
    useCloudResourceStore.getState().openDialog();
  });
  const dialog = page.getByRole("dialog", { name: "云端资源清理" });
  await expect(dialog).toBeVisible();

  // 三组徽标：可清理 / 使用中 / 已被引用。
  const orphanRow = dialog.locator(".wc-cloud-res-row", { hasText: "遗留素材.png" });
  const activeRow = dialog.locator(".wc-cloud-res-row", { hasText: "在用素材.png" });
  const boundRow = dialog.locator(".wc-cloud-res-row", { hasText: "绑定素材.png" });
  await expect(orphanRow).toContainText("可清理");
  await expect(activeRow).toContainText("使用中");
  await expect(boundRow).toContainText("已被引用");
  // 「使用中」不再禁用勾选；「已被引用」保持禁用。
  await expect(activeRow.locator('input[type="checkbox"]')).toBeEnabled();
  await expect(boundRow.locator('input[type="checkbox"]')).toBeDisabled();

  // 纯遗留素材直接清理，不带 forceUnbound。
  await orphanRow.locator('input[type="checkbox"]').check();
  await dialog.getByRole("button", { name: "清理所选" }).click();
  await expect.poll(() => cleanupBody).toEqual({ mediaIds: [orphanId] });
  // 确认 mock 删除生效、列表与选中态收敛，避免残留选中混入下一次请求。
  await expect(orphanRow).toHaveCount(0);
  await expect(dialog.locator(".wc-cloud-res-row")).toHaveCount(2);

  // 「使用中」素材：二次确认前不发请求；确认后带 forceUnbound 且先本地缓存。
  await activeRow.locator('input[type="checkbox"]').check();
  await dialog.getByRole("button", { name: "清理所选" }).click();
  await expect(dialog.getByText(/已选 1 个「使用中」素材/)).toBeVisible();
  expect(cleanupBody).toEqual({ mediaIds: [orphanId] });
  await dialog.getByRole("button", { name: "确认清理" }).click();
  await expect.poll(() => cleanupBody).toEqual({ mediaIds: [activeId], forceUnbound: true });
  await expect(activeRow).toHaveCount(0);

  // 删除前已把文件缓存到本地素材库（IndexedDB 落盘是有界异步队列，轮询到出现为止）。
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const { readMedia } = await import("/src/lib/media-store.ts");
        return (await readMedia(id)) !== null;
      }, activeId),
    )
    .toBe(true);

  await page.screenshot({
    path: testInfo.outputPath("cloud-resource-confirm-cleanup.png"),
    fullPage: false,
  });
});
