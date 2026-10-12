import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
});

async function cleanProjectLibrary(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("weftcanvas-project-library-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("weftcanvas-project-library-e2e-cleaned", "1");
  });
}

async function seedFixtureProject(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("weftcanvas-project-library-e2e-fixture")) return;
    sessionStorage.setItem("weftcanvas-project-library-e2e-fixture", "1");
    const now = Date.now();
    const generation = {
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
    };
    const project = {
      schemaVersion: 1,
      id: "library-fixture-project",
      name: "纬线 1",
      nodes: [
        {
          id: "fixture-text",
          type: "weftcanvas",
          position: { x: 40, y: 40 },
          width: 308,
          height: 176,
          data: {
            kind: "text",
            body: "低机位跟拍，湿润石板路反射零散霓虹。人物从画面右侧冲入，急促回头，远处渡轮鸣笛。",
            accent: "jade",
            status: "idle",
            progress: null,
            media: null,
            directorCapture: null,
            config: null,
            generation,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: "fixture-config",
          type: "weftcanvas",
          position: { x: 40, y: 260 },
          width: 308,
          height: 176,
          data: {
            kind: "config",
            body: "",
            accent: "jade",
            status: "idle",
            progress: null,
            media: null,
            directorCapture: null,
            config: { modality: "image" },
            generation,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: "fixture-image",
          type: "weftcanvas",
          position: { x: 440, y: 42 },
          width: 340,
          height: 191,
          data: {
            kind: "image",
            body: "16:9 · 冷雨夜 · 暖色实景光",
            accent: "blue",
            status: "idle",
            progress: null,
            media: null,
            directorCapture: null,
            config: null,
            generation,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      edges: [
        { id: "fixture-edge-text", source: "fixture-text", target: "fixture-image" },
        { id: "fixture-edge-config", source: "fixture-config", target: "fixture-image" },
      ],
      groups: [],
      viewport: { x: 185, y: 138, zoom: 0.9 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem(
      `weftcanvas:project-data:v1:${encodeURIComponent(project.id)}`,
      JSON.stringify(project),
    );
    localStorage.setItem(
      "weftcanvas:projects:v1",
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: project.id,
            name: project.name,
            createdAt: now,
            updatedAt: now,
            nodeCount: project.nodes.length,
          },
        ],
      }),
    );
    localStorage.setItem("weftcanvas:active-project:v1", project.id);
  });
}

async function openProjectLibrary(page: Page) {
  await page.getByLabel("项目菜单").click();
  const sidebar = page.locator(".wc-project-sidebar");
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function editStarterText(page: Page, body: string) {
  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  await textNode.hover();
  await page.locator(".wc-node-action-toolbar").getByLabel("全屏编辑").click();
  const dialog = page.getByRole("dialog", { name: "编辑文本节点" });
  await dialog.getByLabel("节点内容").fill(body);
  await dialog.getByLabel("收起").click();
  await expect(textNode.locator(".wc-node-text-preview")).toHaveText(body);
}

function projectRow(page: Page, name: string) {
  return page.locator(".wc-project-row", {
    has: page.locator(".wc-project-copy strong", {
      hasText: new RegExp(`^${escapeRegExp(name)}$`),
    }),
  });
}

async function uploadStarterImage(page: Page, name: string) {
  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  await imageNode.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(imageNode.locator("img")).toBeVisible();
  await expect
    .poll(async () =>
      imageNode.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
}

test("local project library keeps project graphs isolated through create, switch, and duplicate", async ({
  page,
}) => {
  await cleanProjectLibrary(page);
  await seedFixtureProject(page);
  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  const projectName = page.getByLabel("项目名称");
  await projectName.fill("项目 A");
  await projectName.blur();
  await editStarterText(page, "项目 A 的独立分镜");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  let sidebar = await openProjectLibrary(page);
  await expect(sidebar.locator(".wc-project-row")).toHaveCount(1);
  await expect(projectRow(page, "项目 A")).toContainText("3 个节点");
  await sidebar.getByLabel("新建项目").click();

  await expect(projectName).toHaveValue("纬线 1");
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加文本节点" })
    .click();
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(1);
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  sidebar = await openProjectLibrary(page);
  await expect(sidebar.locator(".wc-project-row")).toHaveCount(2);
  await projectRow(page, "项目 A").locator(".wc-project-open").click();
  await expect(projectName).toHaveValue("项目 A");
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(3);
  await expect(page.getByLabel("文本节点内容")).toHaveText("项目 A 的独立分镜");

  sidebar = await openProjectLibrary(page);
  const sourceRow = projectRow(page, "项目 A");
  await sourceRow.locator(".wc-project-more").click();
  await sourceRow.getByRole("button", { name: "创建副本" }).click();
  await expect(projectName).toHaveValue("项目 A 副本");
  await expect(page.getByLabel("文本节点内容")).toHaveText("项目 A 的独立分镜");

  await editStarterText(page, "只修改副本");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  sidebar = await openProjectLibrary(page);
  await projectRow(page, "项目 A").locator(".wc-project-open").click();
  await expect(page.getByLabel("文本节点内容")).toHaveText("项目 A 的独立分镜");
});

test("replacing media in a duplicate keeps shared local media available in the original project", async ({
  page,
}) => {
  await cleanProjectLibrary(page);
  await seedFixtureProject(page);
  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  const projectName = page.getByLabel("项目名称");
  await projectName.fill("Original media project");
  await projectName.blur();
  await uploadStarterImage(page, "original.png");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await openProjectLibrary(page);
  const originalRow = projectRow(page, "Original media project");
  await originalRow.locator(".wc-project-more").click();
  await originalRow.getByRole("button", { name: "创建副本" }).click();
  await expect(projectName).toHaveValue("Original media project 副本");

  await uploadStarterImage(page, "duplicate.png");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await openProjectLibrary(page);
  await projectRow(page, "Original media project").locator(".wc-project-open").click();
  const originalImage = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"]) img',
  );
  await expect(originalImage).toBeVisible();
  await expect
    .poll(async () => originalImage.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test("project library renames, exports, imports, and deletes without losing the remaining project", async ({
  page,
}) => {
  await cleanProjectLibrary(page);
  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  const projectName = page.getByLabel("项目名称");
  await projectName.fill("可交付项目");
  await projectName.blur();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  let sidebar = await openProjectLibrary(page);
  const row = projectRow(page, "可交付项目");
  await row.locator(".wc-project-more").click();
  await row.getByRole("button", { name: "重命名" }).click();
  const rename = sidebar.getByLabel("项目名称");
  await rename.fill("已重命名项目");
  await rename.press("Enter");
  await expect(projectName).toHaveValue("已重命名项目");

  const downloadPromise = page.waitForEvent("download");
  await sidebar.getByRole("button", { name: "导出当前" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("已重命名项目.weftcanvas.json");
  const exportedPath = await download.path();
  expect(exportedPath).not.toBeNull();

  await sidebar.locator('input[type="file"]').setInputFiles(exportedPath!);
  await expect(projectName).toHaveValue("已重命名项目 2");

  sidebar = await openProjectLibrary(page);
  await expect(sidebar.locator(".wc-project-row")).toHaveCount(2);
  const importedRow = projectRow(page, "已重命名项目 2");
  await importedRow.locator(".wc-project-more").click();
  await importedRow.getByRole("button", { name: "删除" }).click();
  const confirmation = page.getByRole("dialog", { name: "删除项目" });
  await expect(confirmation).toContainText("已重命名项目 2");
  await confirmation.getByRole("button", { name: "删除" }).click();

  await expect(projectName).toHaveValue("已重命名项目");
  sidebar = await openProjectLibrary(page);
  await expect(sidebar.locator(".wc-project-row")).toHaveCount(1);
  await expect(projectRow(page, "已重命名项目")).toBeVisible();
});

test("project sidebar remains readable in both themes without document overflow", async ({
  page,
}) => {
  await cleanProjectLibrary(page);
  await page.goto("/canvas");
  const sidebar = await openProjectLibrary(page);
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "返回项目首页" })).toHaveAttribute("href", "/");

  for (const theme of ["dark", "light"] as const) {
    await expect(page.locator(".wc-app")).toHaveAttribute("data-theme", theme);
    const contrast = await sidebar.evaluate((element) => {
      const styles = getComputedStyle(element);
      return { color: styles.color, background: styles.backgroundColor };
    });
    expect(contrast.color).not.toBe(contrast.background);
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.width);
    expect(dimensions.scrollHeight).toBe(dimensions.height);
    if (theme === "dark") {
      await sidebar.getByLabel("关闭项目栏").click();
      await page.getByLabel("切换主题").click();
      await openProjectLibrary(page);
    }
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
