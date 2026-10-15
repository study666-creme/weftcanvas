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

const promptShell = (page: Page) => page.locator(".wc-node-prompt-shell");

/** 她中心 x 与输入框右端停靠位的偏差。 */
async function cornerOffset(page: Page) {
  const shellBox = await promptShell(page).boundingBox();
  const box = await companion(page).boundingBox();
  if (!shellBox || !box) return Number.POSITIVE_INFINITY;
  return Math.abs(box.x + box.width / 2 - (shellBox.x + shellBox.width - shellBox.width * 0.06));
}

/**
 * 用户 2026-10-15：「大肥鱼不准挂节点上，平时就在天上就行了，输入框点开的时候
 * 是挂在输入框上不是挂节点上的」「挂输入框右上角就行」。
 */
test("selecting a node never perches her on it — the open input box does", async ({ page }) => {
  await seedStarterCanvas(page);
  await page.goto("/canvas");
  const image = nodeById(page, "starter-image");
  await expect(image).toBeVisible();
  await expect(companion(page)).toBeVisible();
  // 初始在默认位（天上、顶部居中），不在任何节点或面板上。
  await expect(companion(page)).not.toHaveClass(/is-on-node/);
  await expect(companion(page)).not.toHaveClass(/is-docked/);

  // 选中节点 → 输入框打开 → 她趴到输入框右上角，而不是爬到这个节点上。
  await image.click();
  await expect(promptShell(page)).toBeVisible();
  await expect(companion(page)).not.toHaveClass(/is-on-node/);
  await expect(companion(page)).toHaveClass(/is-docked/);
  await expect.poll(() => cornerOffset(page), { timeout: 3_000 }).toBeLessThan(60);

  // 她的身体骑在输入框上缘（下半身被面板盖住），不是浮在面板中间。
  const shellBox = (await promptShell(page).boundingBox())!;
  const box = (await companion(page).boundingBox())!;
  expect(box.y).toBeLessThan(shellBox.y + shellBox.height * 0.5);
});

/**
 * 用户 2026-10-15：「图一打开节点输入框后 agent 位置不对，我意思是自动挂在图二的
 * 位置（输入框右上角），以前第一版就是这样」。
 *
 * 输入框翻到节点上方时，面板贴顶会把她需要的身位挤没，旧代码于是把她挂到面板**下沿**
 * ——那正好压在节点和它的功能栏上。现在翻到上方时会多留 LEDGE_PERCH_ROOM 的上边距，
 * 她永远在面板上沿探头。
 */
test("the flipped input box keeps room on its top edge for her", async ({ page }, testInfo) => {
  await seedStarterCanvas(page);
  await page.goto("/canvas");
  const image = nodeById(page, "starter-image");
  await expect(image).toBeVisible();
  await expect(companion(page)).toBeVisible();

  // 视口压矮到放不下输入框：它会翻到节点上方，并被顶边夹住（用户截图的场景）。
  await page.setViewportSize({ width: 1440, height: 560 });

  await image.click();
  const shell = promptShell(page);
  await expect(shell).toBeVisible();
  await expect(shell).toHaveAttribute("data-placement", "above");
  await expect(companion(page)).toHaveClass(/is-docked/);

  // 她会按 1Hz 跟一次面板（面板被视口变化挪过位置），所以轮询到"顶边跑到面板
  // 顶边之上"为止，而不是拍一张就比。
  await expect
    .poll(
      async () => {
        const shellBox = await shell.boundingBox();
        const box = await companion(page).boundingBox();
        if (!shellBox || !box) return Number.NEGATIVE_INFINITY;
        return Math.round(shellBox.y - box.y);
      },
      { timeout: 5_000 },
    )
    .toBeGreaterThan(6);

  const shellBox = (await shell.boundingBox())!;
  const box = (await companion(page).boundingBox())!;
  // 面板顶边之上留着她的探身位（视口边距 16 + 身位 62）。
  expect(shellBox.y).toBeGreaterThanOrEqual(78);
  // 上半身在面板顶边之上、下半身收在面板后面——不是掉到面板下沿去。
  expect(box.y).toBeLessThan(shellBox.y);
  expect(box.y + box.height).toBeGreaterThan(shellBox.y);
  expect(box.y + box.height).toBeLessThan(shellBox.y + shellBox.height * 0.6);
  await page.screenshot({ path: testInfo.outputPath("companion-on-flipped-composer.png") });
});

test("closing the input box sends her back to the sky", async ({ page }) => {
  await seedStarterCanvas(page);
  await page.goto("/canvas");
  const image = nodeById(page, "starter-image");
  await expect(image).toBeVisible();

  await image.click();
  await expect(companion(page)).toHaveClass(/is-docked/);

  // 点空白处取消选中 → 输入框关闭 → 她回默认位（天上、顶部居中）。
  await page.mouse.click(40, 760);
  await expect(promptShell(page)).toHaveCount(0);
  await expect(companion(page)).not.toHaveClass(/is-docked/, { timeout: 3_000 });
  const viewport = page.viewportSize()!;
  await expect
    .poll(
      async () => {
        const box = await companion(page).boundingBox();
        return box
          ? Math.abs(box.x + box.width / 2 - viewport.width / 2)
          : Number.POSITIVE_INFINITY;
      },
      { timeout: 3_000 },
    )
    .toBeLessThan(80);
});
