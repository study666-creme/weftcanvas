import { expect, test, type Page } from "@playwright/test";

import { seedStarterCanvas } from "./starter-canvas.fixture";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
});

function companion(page: Page) {
  return page.locator(".wc-agent-companion");
}

function nodeById(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

/** 伙伴中心 x 与「节点右缘内侧停靠位」的偏差。 */
async function perchOffset(page: Page, nodeId: string) {
  const nodeBox = await nodeById(page, nodeId).boundingBox();
  const box = await companion(page).boundingBox();
  if (!nodeBox || !box) return Number.POSITIVE_INFINITY;
  return Math.abs(box.x + box.width / 2 - (nodeBox.x + nodeBox.width - box.width * 0.18));
}

test("clicking a node perches the companion on its corner and switching glides her over", async ({
  page,
}) => {
  await seedStarterCanvas(page);
  await page.goto("/canvas");
  const image = nodeById(page, "starter-image");
  const text = nodeById(page, "starter-text");
  await expect(image).toBeVisible();
  await expect(companion(page)).toBeVisible();
  // 初始在默认位（顶部居中），不在任何节点上。
  await expect(companion(page)).not.toHaveClass(/is-on-node/);

  // 点图片节点 → 她坐到该节点右上缘。
  await image.click();
  await expect(companion(page)).toHaveClass(/is-on-node/);
  await expect.poll(() => perchOffset(page, "starter-image"), { timeout: 3_000 }).toBeLessThan(8);
  const nodeBox = await image.boundingBox();
  const box = await companion(page).boundingBox();
  // 顶边骑在节点上缘附近（露出约一半身高在上方）。
  expect(box.y).toBeLessThan(nodeBox.y + 12);
  expect(box.y).toBeGreaterThan(nodeBox.y - box.height);

  // 点文本节点 → 滑动过去：先看到 is-moving，再确认她真的换到了新节点。
  await text.click();
  await expect(companion(page)).toHaveClass(/is-moving/);
  await expect.poll(() => perchOffset(page, "starter-text"), { timeout: 3_000 }).toBeLessThan(8);
  await expect.poll(() => perchOffset(page, "starter-image")).toBeGreaterThan(40);
  // 滑动结束后 is-moving 撤下（跟随不再带过渡）。
  await expect(companion(page)).not.toHaveClass(/is-moving/, { timeout: 3_000 });
});

test("panning keeps her welded to the node while the glide class is off", async ({ page }) => {
  await seedStarterCanvas(page);
  await page.goto("/canvas");
  const image = nodeById(page, "starter-image");
  await expect(image).toBeVisible();
  await image.click();
  await expect(companion(page)).toHaveClass(/is-on-node/);
  await expect.poll(() => perchOffset(page, "starter-image"), { timeout: 3_000 }).toBeLessThan(8);

  // 平移画布：她跟着节点走，而不是留在原地。
  await page.mouse.move(720, 500);
  await page.mouse.down();
  await page.mouse.move(560, 420, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => perchOffset(page, "starter-image"), { timeout: 3_000 }).toBeLessThan(8);
  // 跟随期间不带滑动类（逐帧跟手，不糊）。
  await expect(companion(page)).not.toHaveClass(/is-moving/);
});
