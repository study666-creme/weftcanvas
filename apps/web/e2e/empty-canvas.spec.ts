import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
});

async function cleanBrowser(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("kachang-empty-canvas-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("kachang-empty-canvas-e2e-cleaned", "1");
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

test("a fresh browser starts on a valid empty canvas with zero nodes, edges, and groups", async ({ page }) => {
  await cleanBrowser(page);
  await page.goto("/canvas");

  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.getByLabel("项目名称")).toHaveValue("卡藏画布 1");
  await expect(page.locator(".kc-empty-canvas-hint")).toHaveCount(1);
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".kc-group-frame")).toHaveCount(0);
  await expect(page.locator(".react-flow__node-kachang.selected")).toHaveCount(0);
  await expect(page.getByLabel("撤销")).toBeDisabled();
  await expect(page.getByLabel("重做")).toBeDisabled();

  const viewport = await page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });
  expect(viewport.zoom).toBeCloseTo(0.7, 2);
  expect(viewport.x).toBeCloseTo(720, 0);
  expect(viewport.y).toBeCloseTo(450, 0);

  await page.reload();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(0);

  const persisted = await page.evaluate(() => {
    const projectId = localStorage.getItem("kachang-canvas:active-project:v1");
    const raw = projectId ? localStorage.getItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`) : null;
    return raw ? JSON.parse(raw) as { nodes: unknown[]; edges: unknown[]; groups: unknown[]; viewport: { zoom: number } } : null;
  });
  expect(persisted).not.toBeNull();
  expect(persisted!.nodes).toHaveLength(0);
  expect(persisted!.edges).toHaveLength(0);
  expect(persisted!.groups).toHaveLength(0);
});

test("creation tools work on the empty canvas and place one selected node at a reachable position", async ({ page }) => {
  await cleanBrowser(page);
  await page.goto("/canvas");

  const creation = page.getByRole("navigation", { name: "创建工具" });
  await expect(page.locator(".kc-empty-canvas-hint")).toHaveCount(1);
  await creation.getByRole("button", { name: "添加文本节点" }).click();

  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(1);
  await expect(page.locator(".react-flow__node-kachang.selected")).toHaveCount(1);
  await expect(page.locator(".kc-empty-canvas-hint")).toHaveCount(0);
  const textNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])');
  await expect(textNode).toBeVisible();
  const box = await textNode.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width / 2).toBeGreaterThan(0);
  expect(box!.x + box!.width / 2).toBeLessThan(1440);
  expect(box!.y + box!.height / 2).toBeGreaterThan(0);
  expect(box!.y + box!.height / 2).toBeLessThan(900);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await creation.getByRole("button", { name: "添加图片节点" }).click();
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(2);
  await expect(page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])')).toBeVisible();
  await expect(page.locator(".react-flow__node-kachang.selected")).toHaveCount(1);
  await expect(page.locator(".kc-empty-canvas-hint")).toHaveCount(0);

  await page.keyboard.press("Control+Z");
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(1);
});

test("new project starts at zero after preserving the previous project", async ({ page }) => {
  await cleanBrowser(page);
  await page.goto("/canvas");

  const creation = page.getByRole("navigation", { name: "创建工具" });
  await creation.getByRole("button", { name: "添加文本节点" }).click();
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(1);
  const projectName = page.getByLabel("项目名称");
  await projectName.fill("保留项目");
  await projectName.blur();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  const sidebar = await openProjectLibrary(page);
  await expect(projectRow(page, "保留项目")).toContainText("1 个节点");
  await sidebar.getByLabel("新建项目").click();

  await expect(projectName).toHaveValue("卡藏画布 1");
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".kc-group-frame")).toHaveCount(0);
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  const resetViewport = await page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });
  expect(resetViewport.zoom).toBeCloseTo(0.7, 2);
  expect(resetViewport.x).toBeCloseTo(720, 0);
  expect(resetViewport.y).toBeCloseTo(450, 0);

  await creation.getByRole("button", { name: "添加文本节点" }).click();
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(1);
});

test("switching back preserves the prior graph built on an empty start", async ({ page }) => {
  await cleanBrowser(page);
  await page.goto("/canvas");

  const projectName = page.getByLabel("项目名称");
  await projectName.fill("第一幕");
  await projectName.blur();
  const creation = page.getByRole("navigation", { name: "创建工具" });
  await creation.getByRole("button", { name: "添加文本节点" }).click();
  await creation.getByRole("button", { name: "添加图片节点" }).click();
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(2);

  let sidebar = await openProjectLibrary(page);
  await sidebar.getByLabel("新建项目").click();
  await expect(projectName).toHaveValue("卡藏画布 1");
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(0);

  sidebar = await openProjectLibrary(page);
  await projectRow(page, "第一幕").locator(".kc-project-open").click();
  await expect(projectName).toHaveValue("第一幕");
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(2);
  await expect(page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])')).toBeVisible();
  await expect(page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])')).toBeVisible();
});

test("deleting the last project creates an empty replacement", async ({ page }) => {
  await cleanBrowser(page);
  await page.goto("/canvas");

  const creation = page.getByRole("navigation", { name: "创建工具" });
  await creation.getByRole("button", { name: "添加文本节点" }).click();
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(1);

  const sidebar = await openProjectLibrary(page);
  const row = projectRow(page, "卡藏画布 1");
  await row.locator(".kc-project-more").click();
  await row.getByRole("button", { name: "删除" }).click();
  const confirmation = page.getByRole("dialog", { name: "删除项目" });
  await expect(confirmation).toContainText("卡藏画布 1");
  await confirmation.getByRole("button", { name: "删除" }).click();

  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".kc-group-frame")).toHaveCount(0);
  await expect(page.getByLabel("项目名称")).toHaveValue("卡藏画布 1");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await creation.getByRole("button", { name: "添加文本节点" }).click();
  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(1);
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
