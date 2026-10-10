import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
});

async function cleanProject(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("kachang-director-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("kachang-director-e2e-cleaned", "1");
  });
}

async function readCanvasPixels(canvas: import("@playwright/test").Locator) {
  return canvas.evaluate((source: HTMLCanvasElement) => {
    const probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 40;
    const context = probe.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(source, 0, 0, probe.width, probe.height);
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set<string>();
    let min = 255;
    let max = 0;
    for (let index = 0; index < data.length; index += 16) {
      const red = data[index]!;
      const green = data[index + 1]!;
      const blue = data[index + 2]!;
      min = Math.min(min, red, green, blue);
      max = Math.max(max, red, green, blue);
      colors.add(`${red}:${green}:${blue}`);
    }
    return { colorCount: colors.size, range: max - min };
  });
}

test("director stage renders a nonblank scene and keeps its tools inside the viewport", async ({ page }, testInfo) => {
  const runtimeMessages: string[] = [];
  page.on("pageerror", (error) => runtimeMessages.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.text().toLowerCase().includes("deprecated")) runtimeMessages.push(message.text());
  });
  await cleanProject(page);
  await page.goto("/canvas");
  await page.getByLabel("打开 3D 导演台").click();

  const stage = page.getByRole("dialog", { name: "3D 导演台" });
  const canvas = page.getByTestId("director-stage-canvas");
  await expect(stage).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("complementary", { name: "镜头列表" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "场面调度" })).toBeVisible();
  await page.waitForTimeout(500);

  const pixels = await readCanvasPixels(canvas);
  expect(pixels.colorCount).toBeGreaterThan(12);
  expect(pixels.range).toBeGreaterThan(35);

  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.width);
  expect(dimensions.scrollHeight).toBe(dimensions.height);
  await page.screenshot({ path: testInfo.outputPath("director-stage-dark.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(320);
  const mobileCanvas = await canvas.boundingBox();
  expect(mobileCanvas).not.toBeNull();
  expect(mobileCanvas!.width).toBe(390);
  expect(mobileCanvas!.height).toBe(844);
  const mobilePixels = await readCanvasPixels(canvas);
  expect(mobilePixels.colorCount).toBeGreaterThan(12);
  expect(mobilePixels.range).toBeGreaterThan(35);
  const mobileDimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(mobileDimensions.scrollWidth).toBe(mobileDimensions.width);
  await page.screenshot({ path: testInfo.outputPath("director-stage-mobile.png") });
  expect(runtimeMessages).toEqual([]);
});

test("director stage edits entities, guards the floor, and returns validated captures", async ({ page }) => {
  test.setTimeout(45_000);
  await cleanProject(page);
  await page.goto("/canvas");
  await page.getByLabel("打开 3D 导演台").click();

  const stage = page.getByRole("dialog", { name: "3D 导演台" });
  await stage.getByRole("button", { name: "角色 A", exact: true }).click();
  const xInput = stage.getByLabel("左右 X精确数值");
  const yInput = stage.getByLabel("高度 Y精确数值");
  await expect(xInput).toHaveValue("-1.3");

  const canvas = page.getByTestId("director-stage-canvas");
  const beforeX = Number(await xInput.inputValue());
  await page.mouse.move(430, 470);
  await page.mouse.down();
  await page.mouse.move(520, 470, { steps: 9 });
  await page.mouse.up();
  const afterX = Number(await xInput.inputValue());
  expect(Math.abs(afterX - beforeX)).toBeGreaterThan(0.15);
  await expect(canvas).toHaveClass(/kc-director-canvas/);

  await yInput.fill("-1");
  await yInput.blur();
  await expect(yInput).toHaveValue("0.00");
  await expect(page.locator(".kc-toast")).toContainText("已在地面停止");

  await stage.getByRole("button", { name: /地面锁定/ }).click();
  await yInput.fill("-1");
  await yInput.blur();
  await expect(yInput).toHaveValue("-1.00");

  await stage.getByRole("button", { name: "道具", exact: true }).click();
  await stage.getByRole("menuitem", { name: "沙发" }).click();
  await expect(stage.getByRole("button", { name: "沙发", exact: true })).toBeVisible();

  await stage.getByRole("button", { name: "截取当前" }).click();
  await expect(page.locator(".kc-toast").filter({ hasText: "分镜截图已加入画布" })).toBeVisible();
  await stage.getByLabel("关闭导演台").click();

  const nodes = page.locator(".react-flow__node-kachang");
  await expect(nodes).toHaveCount(4);
  await expect(page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"]) img')).toHaveCount(1);
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  const directorMetadata = await page.evaluate(() => {
    const projectId = localStorage.getItem("kachang-canvas:active-project:v1");
    const raw = projectId ? localStorage.getItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`) : null;
    const project = raw ? JSON.parse(raw) : null;
    return project?.nodes?.find((node: { data?: { directorCapture?: unknown } }) => node.data?.directorCapture)?.data.directorCapture;
  });
  expect(directorMetadata).toMatchObject({ shotId: "shot-01", slot: 1 });

  await page.keyboard.press("Control+Z");
  await expect(nodes).toHaveCount(3);

  await page.waitForTimeout(450);
  await page.reload();
  await page.getByLabel("打开 3D 导演台").click();
  const reopenedStage = page.getByRole("dialog", { name: "3D 导演台" });
  await expect(reopenedStage.getByRole("button", { name: "沙发", exact: true })).toBeVisible();
  await reopenedStage.getByRole("button", { name: "角色 A", exact: true }).click();
  await expect(reopenedStage.getByRole("button", { name: /允许地下/ })).toBeVisible();
  await expect(reopenedStage.getByLabel("高度 Y精确数值")).toHaveValue("-1.00");
});

test("text nodes launch a one-shot stage draft and captures connect back to their source", async ({ page }) => {
  await cleanProject(page);
  await page.goto("/canvas");
  const textNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])');
  const sourceText = (await textNode.locator(".kc-node-text-preview").textContent())?.trim();
  expect(sourceText).toBeTruthy();

  await textNode.locator(".kc-node-drag-strip").click();
  await page.getByLabel("送入 3D 导演台").click();
  const stage = page.getByRole("dialog", { name: "3D 导演台" });
  await expect(stage).toBeVisible();
  await expect(stage.locator(".kc-director-shot-caption")).toContainText("文本预演");
  await expect(stage.locator(".kc-director-shot-caption")).toContainText(sourceText!);

  await stage.getByRole("button", { name: "截取当前" }).click();
  await expect(page.locator(".kc-toast").filter({ hasText: "分镜截图已加入画布" })).toBeVisible();
  await stage.getByLabel("关闭导演台").click();

  await expect(page.locator(".react-flow__node-kachang")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => {
    const projectId = localStorage.getItem("kachang-canvas:active-project:v1");
    const raw = projectId ? localStorage.getItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`) : null;
    const project = raw ? JSON.parse(raw) : null;
    const source = project?.nodes?.find((node: { data?: { kind?: string } }) => node.data?.kind === "text");
    const capture = project?.nodes?.find((node: { data?: { directorCapture?: unknown } }) => node.data?.directorCapture);
    return project?.edges?.some((edge: { source?: string; target?: string }) => edge.source === source?.id && edge.target === capture?.id) ?? false;
  })).toBe(true);
});
