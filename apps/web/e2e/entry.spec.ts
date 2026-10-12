import { expect, test, type Page } from "@playwright/test";

function catalogModel(modality: "image" | "video") {
  return {
    id: `e2e-${modality}-model`,
    label: modality === "image" ? "画面生成模型" : "镜头生成模型",
    description: "",
    modality,
    operation: "generate",
    order: 0,
    input: { textRequired: true, images: { min: 0, max: 0, multiple: false } },
    output: { type: modality, minCount: 1, maxCount: 1 },
    pricing: {
      mode: "fixed",
      unit: modality === "image" ? "image" : "second",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 2_000_000,
      baseYuanMicros: 20_000,
      tiers: [],
    },
    parameters: [
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
      {
        name: "size",
        label: "尺寸",
        type: "string",
        required: false,
        options: ["1:1", "16:9"],
        mutuallyExclusiveWith: [],
      },
    ],
  };
}

async function mockCatalogApis(page: Page) {
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  await page.route("**/api/v1/model-catalog**", (route) => {
    const requested = new URL(route.request().url()).searchParams.get("modality");
    const models =
      requested === "image"
        ? [catalogModel("image")]
        : requested === "video"
          ? [catalogModel("video")]
          : requested === "text" || requested === "audio"
            ? []
            : [catalogModel("image"), catalogModel("video")];
    return route.fulfill({
      json: {
        ok: true,
        data: {
          version: `entry-${requested ?? "all"}-catalog`,
          capabilityVersion: "entry-capability",
          pricingVersion: "entry-pricing",
          fetchedAt: new Date().toISOString(),
          expiresAt,
          quoteAvailable: true,
          models,
        },
      },
    });
  });
  await page.route("**/api/v1/generation-jobs?*", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => {
    const gate = document.querySelector<HTMLElement>(".wc-entry-gate");
    if (!gate) throw new Error("Entry gate is not mounted");

    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      gateClientWidth: gate.clientWidth,
      gateScrollWidth: gate.scrollWidth,
    };
  });

  expect(dimensions.documentScrollWidth).toBe(dimensions.documentClientWidth);
  expect(dimensions.gateScrollWidth).toBe(dimensions.gateClientWidth);
}

test("the entry gate opens the single canvas loader without a departure curtain", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const gate = page.locator(".wc-entry-gate");
  const enter = page.locator(".wc-entry-button");
  await expect(gate).toBeVisible();
  await expect(gate).toHaveAttribute("aria-label", "纬线画布入口");
  await expect(enter).toBeVisible();
  await expect(page.getByRole("heading", { name: "纬线画布", exact: true })).toBeVisible();
  const brandLogo = gate.locator(".wc-entry-brand-mark img");
  await expect(brandLogo).toBeVisible();
  await expect
    .poll(() =>
      brandLogo.evaluate((image: HTMLImageElement) => ({
        complete: image.complete,
        width: image.naturalWidth,
      })),
    )
    .toEqual({ complete: true, width: 256 });
  await expect(page.getByRole("navigation", { name: "主页分区" })).toBeVisible();
  await expect(page.locator(".wc-workspace, .react-flow")).toHaveCount(0);

  await enter.click();
  await expect(page).toHaveURL(/\/canvas$/);
  await expect(gate).toHaveCount(0);
  await expect(page.locator(".wc-canvas-entry-loader")).toBeVisible();
  await expect(page.locator(".wc-canvas-entry-loader-mark img")).toBeVisible();
  await expect(page.locator(".wc-workspace")).toBeAttached();
  await expect(page.locator(".wc-app")).toHaveClass(/wc-app--entry-inside/);
});

test("the prompt composer routes to image and video generation", async ({ page }) => {
  await mockCatalogApis(page);
  await page.goto("/");

  const composer = page.locator(".wc-entry-composer");
  await expect(composer).toBeVisible();
  const prompt = page.getByLabel("生成提示词");
  const tabs = page.getByRole("tablist", { name: "生成类型" });
  await expect(tabs.getByRole("tab", { name: "图片生成" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(tabs.getByRole("tab", { name: "视频生成" })).toHaveAttribute(
    "aria-selected",
    "false",
  );

  await prompt.fill("雨夜城市，霓虹倒影");
  await page.getByRole("button", { name: "生成图片" }).click();
  await expect(page).toHaveURL(/\/generate\/image\?prompt=/);

  await page.goto("/");
  await page
    .getByRole("tablist", { name: "生成类型" })
    .getByRole("tab", { name: "视频生成" })
    .click();
  await page.getByLabel("生成提示词").fill("云海延时");
  await page.getByLabel("生成提示词").press("Enter");
  await expect(page).toHaveURL(/\/generate\/video\?prompt=/);
});

test("the prompt composer pre-fills the studio draft", async ({ page }) => {
  await mockCatalogApis(page);
  await page.goto("/generate/image?prompt=%E9%9B%A8%E5%A4%9C%E5%9F%8E%E5%B8%82");
  await expect(page.locator("[data-direct-prompt]")).toHaveValue("雨夜城市");
});

test("model and parameter selections carry into the studio draft", async ({ page }) => {
  await mockCatalogApis(page);
  await page.goto("/generate/image?model=e2e-image-model&p_size=" + encodeURIComponent('"16:9"'));
  await expect(page.locator("[data-generation-model-select]")).toHaveValue("e2e-image-model");
  await expect(page.getByLabel("尺寸")).toContainText("16:9");
});

test("an inspiration chip navigates with its prompt", async ({ page }) => {
  await mockCatalogApis(page);
  await page.goto("/");
  const first = page.locator(".wc-entry-inspirations > button").first();
  const idea = (await first.textContent())?.trim() ?? "";
  expect(idea.length).toBeGreaterThan(0);
  await first.click();
  await expect(page).toHaveURL(/\/generate\/image\?prompt=/);
  await expect(page.locator("[data-direct-prompt]")).toHaveValue(idea);
});

test("the entry project launcher opens the selected local project", async ({ page }) => {
  await page.goto("/canvas");
  const projectName = page.getByLabel("项目名称");
  await projectName.fill("入口项目 A");
  await projectName.blur();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await page.getByLabel("项目菜单").click();
  await page.getByLabel("新建项目").click();
  await projectName.fill("入口项目 B");
  await projectName.blur();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await page.goto("/");
  const launcher = page.getByLabel("选择要进入的项目");
  await expect(launcher.getByRole("button", { name: "打开项目 入口项目 A" })).toBeVisible();
  await launcher.getByRole("button", { name: "打开项目 入口项目 A" }).click();

  await expect(page).toHaveURL(/\/canvas$/);
  await expect(page.locator(".wc-entry-gate")).toHaveCount(0, { timeout: 2_000 });
  await expect(projectName).toHaveValue("入口项目 A");
});

test("the account dialog opens above the entry launcher", async ({ page }) => {
  await page.goto("/");
  const gate = page.locator(".wc-entry-gate");
  await gate.getByRole("button", { name: "登录画布账号" }).click();

  const dialog = page.getByRole("dialog", { name: "纬线账号" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("一个账号，连接你的画布与资产。");
  // 自绘光标已删除：原生光标必须仍然可见，指针反馈只做一次性扩散环。
  const pulse = page.getByTestId("pointer-pulse");
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).not.toBe("none");
  await dialog.getByLabel("邮箱").hover();
  await expect(pulse).toHaveClass(/is-enter/, { timeout: 1_000 });
  const layers = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("[data-testid='pointer-pulse']");
    const style = element ? getComputedStyle(element) : null;
    return {
      gate: Number.parseInt(getComputedStyle(document.querySelector(".wc-entry-gate")!).zIndex, 10),
      account: Number.parseInt(
        getComputedStyle(document.querySelector(".wc-account-backdrop")!).zIndex,
        10,
      ),
      position: style?.position ?? null,
      pulseZ: style ? Number.parseInt(style.zIndex, 10) : Number.NaN,
      pointerEvents: style?.pointerEvents ?? null,
    };
  });
  expect(layers.account).toBeGreaterThan(layers.gate);
  // 反馈层压在弹层之上，同时不参与命中，所以不会挡住对话框。
  expect(layers.position).toBe("fixed");
  expect(layers.pulseZ).toBeGreaterThan(layers.account);
  expect(layers.pointerEvents).toBe("none");
  await dialog.getByLabel("关闭").hover();
  await expect(pulse).toHaveClass(/is-enter/, { timeout: 1_000 });
});

test("the entry hero stages layered motion without blocking interaction", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/");

  const stage = page.locator(".wc-entry-hero-media-stage");
  const media = stage.locator(".wc-entry-hero-media");
  const heroTitle = page.locator(".wc-entry-hero-copy h1");
  const composer = page.locator(".wc-entry-composer");

  await expect(stage).toBeVisible();
  await expect(media).toHaveCount(1);
  await expect(composer).toBeVisible();

  // 性能预算：底图不再挂常驻 drift（关键帧留着但没有赋值点），hero 只保留
  // 星星漂移与光晕漂移两层常驻动画。这里断言"没有动画"而不是断言旧动画名。
  await expect(media).toHaveCSS("animation-name", "none");
  await expect(heroTitle).toHaveCSS("animation-name", "wc-entry-copy-rise");
  await expect(composer).toHaveCSS("animation-name", "wc-entry-copy-rise");
});

for (const { label, viewport } of [
  { label: "desktop", viewport: { width: 1_440, height: 900 } },
  { label: "mobile", viewport: { width: 390, height: 844 } },
]) {
  test(`the entry hero has no horizontal overflow on ${label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator(".wc-entry-gate")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

test("the compact desktop navigation keeps every action complete on one line", async ({
  page,
}, testInfo) => {
  const displayName = "流言蜚语工作室账号";
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          user: {
            id: "77777777-7777-4777-8777-777777777777",
            email: "studio@example.com",
            displayName,
            createdAt: "2026-07-22T00:00:00.000Z",
          },
          expiresAt: "2099-08-22T00:00:00.000Z",
        },
      },
    }),
  );
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          credits: 0,
          creditsPermanent: 0,
          dailyCredits: 0,
          creditGrantMode: "bundle",
          dailyCreditsNote: "",
          membership: { tier: "free", until: null, active: false, genDiscount: null },
          lifetimeCreditsSpent: 0,
        },
      },
    }),
  );
  await page.route("**/api/v1/generation-jobs?*", (route) =>
    route.fulfill({
      json: { ok: true, data: [] },
    }),
  );
  await page.setViewportSize({ width: 1_180, height: 800 });
  await page.goto("/");

  const header = page.locator(".wc-entry-nav");
  const account = header.locator(".wc-entry-account-action");
  await expect(account).toContainText(displayName);

  const layout = await header.evaluate((element) => {
    const rowsFor = (action: Element) => {
      const rows = new Set<number>();
      const walker = document.createTreeWalker(action, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (node.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) rows.add(Math.round(rect.top));
          }
        }
        node = walker.nextNode();
      }
      return rows.size;
    };
    const bounds = (selector: string) => {
      const rect = element.querySelector(selector)!.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    const actions = [...element.querySelectorAll<HTMLElement>(".wc-entry-nav-actions > *")]
      .filter((action) => getComputedStyle(action).display !== "none")
      .map((action) => ({
        label: action.textContent?.trim() ?? "",
        rows: rowsFor(action),
        whiteSpace: getComputedStyle(action).whiteSpace,
        clipped: action.scrollWidth > action.clientWidth + 1,
      }));

    return {
      actions,
      brand: bounds(".wc-entry-brand"),
      controls: bounds(".wc-entry-nav-actions"),
      overflow: element.scrollWidth - element.clientWidth,
    };
  });

  expect(layout.actions.map((action) => action.label)).toEqual([displayName, "打开画布"]);
  expect(
    layout.actions.every(
      (action) => action.rows === 1 && action.whiteSpace === "nowrap" && !action.clipped,
    ),
  ).toBe(true);
  expect(layout.controls.left - layout.brand.right).toBeGreaterThanOrEqual(12);
  expect(layout.overflow).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("entry-nav-single-line-desktop.png"),
    fullPage: false,
  });
});

test("the entry hero is a single viewport without a scrollable marketing page", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const gate = page.locator(".wc-entry-gate");
  await expect(gate).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("entry-home-desktop.png") });
  await expect(gate.locator(".wc-entry-composer")).toBeVisible();
  await expect(gate.locator(".wc-entry-project-dock")).toBeVisible();
});

test("the entry page remains balanced without horizontal overflow on a phone viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "纬线画布", exact: true })).toBeVisible();
  await expect(page.locator(".wc-entry-button")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开画布", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "生成类型" })).toBeVisible();
  const dimensions = await page.locator(".wc-entry-gate").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  await page.screenshot({ path: testInfo.outputPath("entry-home-mobile.png") });
});

test("direct canvas links bypass the entry gate", async ({ page }) => {
  await page.goto("/canvas");
  await expect(page.locator(".wc-entry-gate")).toHaveCount(0);
  await expect(page.locator(".wc-workspace")).toBeVisible();
});

test("reduced motion keeps the direct loader entry functional", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const media = page.locator(".wc-entry-hero-media");
  const heroTitle = page.locator(".wc-entry-hero-copy h1");
  const composer = page.locator(".wc-entry-composer");

  await expect(media).toHaveCount(1);
  await expect(media).toHaveCSS("animation-name", "none");
  await expect(heroTitle).toHaveCSS("animation-name", "none");
  await expect(composer).toHaveCSS("animation-name", "none");

  const gate = page.locator(".wc-entry-gate");
  await page.locator(".wc-entry-button").click();
  await expect(gate).toHaveCount(0);
  await expect(page.locator(".wc-canvas-entry-loader")).toBeVisible();
  await expect(page.locator(".wc-app")).toHaveClass(/wc-app--entry-inside/);
});
