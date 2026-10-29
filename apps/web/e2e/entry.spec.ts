import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { skipOnboardingTour } from "./onboarding.fixture";

/**
 * 首屏 = 工作台式主页（`.wc-home`）：左侧栏 + 首页概览（生成框 / 快速开始 / 最近项目 /
 * 创作历史 / 灵感模板）。旧营销落地页保留在 `/?view=landing`，末尾单独覆盖。
 *
 * 匿名访客落到 `/` 会先看到登录优先页（账号服务未配置时同样如此），所以每个用例
 * 要么走「游客访问」（sessionStorage 标记），要么 mock 一个已登录会话。
 */

const IMAGE_FIXTURE = readFileSync(
  fileURLToPath(new URL("./docs-canvas-portrait.jpg", import.meta.url)),
);
const VIDEO_FIXTURE = readFileSync(fileURLToPath(new URL("./video-frame.mp4", import.meta.url)));

// 首屏第一次打开会自动弹新手教程，它的高亮卡片会盖住主页控件；
// 教程本身由 e2e/onboarding.spec.ts 覆盖，这里先把它标记成已看过。
test.beforeEach(async ({ page }) => {
  await skipOnboardingTour(page);
});

async function enterAsGuest(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem("weftcanvas:entry-guest:v1", "1");
  });
}

async function mockSignedIn(page: Page, displayName = "创作者") {
  await page.route(/\/api\/v1\/auth\/session(?:\?.*)?$/, (route) =>
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
    route.fulfill({ json: { ok: true, data: [] } }),
  );
}

const option = (name: string, label: string, options: string[], value: string) => ({
  name,
  label,
  type: "string",
  required: false,
  options,
  default: value,
  mutuallyExclusiveWith: [],
});

/** 真实目录里常见的「长模型名 + 三个下拉参数」，用来压生成框底栏在窄屏下的版式。 */
const RICH_IMAGE_PARAMETERS = [
  option("size", "画面比例", ["auto", "1:1", "16:9", "9:16"], "auto"),
  option("quality", "质量", ["low", "medium", "high"], "medium"),
  option("background", "背景", ["auto", "transparent", "opaque"], "transparent"),
];

function catalogModel(modality: "image" | "video", { rich = false } = {}) {
  const base = simpleCatalogModel(modality);
  if (!rich || modality !== "image") return base;
  return {
    ...base,
    label: "Gpt Image 2.5 1k2k4k",
    parameters: [base.parameters[0]!, ...RICH_IMAGE_PARAMETERS],
  };
}

function simpleCatalogModel(modality: "image" | "video") {
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

async function mockCatalogApis(page: Page, { rich = false } = {}) {
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  await page.route("**/api/v1/model-catalog**", (route) => {
    const requested = new URL(route.request().url()).searchParams.get("modality");
    const models =
      requested === "image"
        ? [catalogModel("image", { rich })]
        : requested === "video"
          ? [catalogModel("video")]
          : requested === "text" || requested === "audio"
            ? []
            : [catalogModel("image", { rich }), catalogModel("video")];
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

/**
 * 主页的真实数据形态：本地项目库摘要 + 项目快照里由生成任务产出的媒体节点。
 * 媒体走同源受保护地址，这里用仓库里的样张回填，封面与作品缩略图都能真的画出来。
 */
async function seedHomeLibrary(page: Page) {
  await page.route("**/api/v1/media/*/content**", (route) => {
    const isVideo = route.request().url().includes("seed-vid");
    return route.fulfill({
      contentType: isVideo ? "video/mp4" : "image/jpeg",
      body: isVideo ? VIDEO_FIXTURE : IMAGE_FIXTURE,
    });
  });
  // 启动时项目库会按 schema 校验每个项目并重写索引，所以种子必须是完整合法的项目快照。
  await page.addInitScript(() => {
    const indexKey = "weftcanvas:projects:v1";
    if (localStorage.getItem(indexKey)) return;
    const now = Date.now();
    const at = (minutesAgo: number) => now - minutesAgo * 60_000;
    const node = (
      id: string,
      kind: "text" | "image" | "video",
      body: string,
      minutesAgo: number,
      index: number,
    ) => {
      const generated = kind !== "text";
      return {
        id: `node-${id}`,
        type: "weftcanvas",
        position: { x: 40 + index * 360, y: 40 },
        width: 320,
        height: 220,
        selected: false,
        data: {
          kind,
          body,
          accent: "jade",
          status: "idle",
          progress: null,
          media: generated
            ? {
                id,
                name: `${id}.${kind === "image" ? "jpg" : "mp4"}`,
                mimeType: kind === "image" ? "image/jpeg" : "video/mp4",
                size: 48_000,
                source: "server",
                serverId: id,
                width: 1200,
                height: 1600,
                durationMs: kind === "video" ? 5_000 : null,
              }
            : null,
          directorCapture: null,
          config: null,
          generation: {
            modelId: generated ? `e2e-${kind}-model` : null,
            parameters: {},
            maxOutputTokens: null,
            referenceMode: "auto",
            referenceNodeIds: [],
            jobId: generated ? `job-${id}` : null,
            jobVersion: generated ? 1 : null,
            jobCreatedAt: generated ? new Date(at(minutesAgo)).toISOString() : null,
            jobStatus: generated ? "completed" : null,
            error: null,
          },
          createdAt: at(minutesAgo),
          updatedAt: at(minutesAgo),
        },
      };
    };
    const project = (
      id: string,
      name: string,
      minutesAgo: number,
      nodes: ReturnType<typeof node>[],
    ) => ({
      schemaVersion: 1,
      id,
      name,
      nodes,
      edges: [],
      groups: [],
      viewport: { x: 80, y: 80, zoom: 0.8 },
      createdAt: at(minutesAgo + 60),
      updatedAt: at(minutesAgo),
    });
    const projects = [
      project("seed-poster", "雨夜霓虹海报", 12, [
        node("seed-img-1", "image", "雨夜霓虹街道，电影感反光，35mm", 12, 0),
        node("seed-img-2", "image", "霓虹招牌特写，潮湿地面倒影", 30, 1),
        node("seed-img-3", "image", "撑伞的人走过斑马线，俯拍", 90, 2),
        node("seed-note-1", "text", "海报文案草稿", 95, 3),
      ]),
      project(
        "seed-storyboard",
        "品牌短片分镜（第二版，包含很长的项目名称用于检查截断）",
        60 * 26,
        [
          node("seed-vid-1", "video", "云海延时，光线流动", 60 * 26, 0),
          node("seed-img-4", "image", "产品在晨光中旋转，极简背景", 60 * 27, 1),
        ],
      ),
      project("seed-empty", "空白画布", 60 * 24 * 9, []),
    ];
    for (const item of projects) {
      localStorage.setItem(
        `weftcanvas:project-data:v1:${encodeURIComponent(item.id)}`,
        JSON.stringify(item),
      );
    }
    localStorage.setItem(
      indexKey,
      JSON.stringify({
        version: 1,
        projects: projects.map((item) => ({
          id: item.id,
          name: item.name,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          nodeCount: item.nodes.length,
        })),
      }),
    );
    localStorage.setItem("weftcanvas:active-project:v1", "seed-poster");
  });
}

async function setSidebarCollapsed(page: Page, collapsed: boolean) {
  await page.addInitScript(
    (value) => {
      localStorage.setItem("weftcanvas:home:sidebar-collapsed:v1", value);
    },
    collapsed ? "1" : "0",
  );
}

/** 主区与顶栏都不许出现横向溢出，主区里任何可见元素也不许越出主区左右边界。 */
async function readHomeLayout(page: Page) {
  return page.evaluate(() => {
    const home = document.querySelector<HTMLElement>(".wc-home");
    const main = document.querySelector<HTMLElement>(".wc-home-main");
    const topbar = document.querySelector<HTMLElement>(".wc-home-topbar");
    const sidebar = document.querySelector<HTMLElement>(".wc-home-sidebar");
    if (!home || !main || !topbar || !sidebar) throw new Error("Home dashboard is not mounted");
    const bounds = main.getBoundingClientRect();
    const escaping = [...main.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return rect.right > bounds.right + 1 || rect.left < bounds.left - 1;
      })
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    const clippedTopbarActions = [
      ...topbar.querySelectorAll<HTMLElement>(".wc-home-topbar-actions > *"),
    ]
      .filter((element) => getComputedStyle(element).display !== "none")
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent?.trim() ?? element.className);
    // 生成框底栏：模型名与每个参数取值都要完整显示，不能被压成一个字或省略号。
    const squeezedComposerValues = [
      ...document.querySelectorAll<HTMLElement>(
        ".wc-home-composer-foot :is(.wc-cat-select-value, .wc-canvas-select-label)",
      ),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const trigger = element.closest("button")?.getBoundingClientRect() ?? rect;
        return (
          rect.width < 8 ||
          element.scrollWidth > Math.ceil(rect.width) + 1 ||
          rect.right > trigger.right + 1
        );
      })
      .map((element) => element.textContent?.trim() ?? "");
    const sidebarRect = sidebar.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      homeOverflow: home.scrollWidth - home.clientWidth,
      mainOverflow: main.scrollWidth - main.clientWidth,
      topbarOverflow: topbar.scrollWidth - topbar.clientWidth,
      escaping,
      clippedTopbarActions,
      squeezedComposerValues,
      sidebar: {
        left: Math.round(sidebarRect.left),
        width: Math.round(sidebarRect.width),
        visible: sidebarRect.right > 0,
      },
    };
  });
}

async function expectCleanLayout(page: Page) {
  const layout = await readHomeLayout(page);
  expect(layout.documentOverflow).toBe(0);
  expect(layout.homeOverflow).toBe(0);
  expect(layout.mainOverflow).toBe(0);
  expect(layout.topbarOverflow).toBe(0);
  expect(layout.escaping).toEqual([]);
  expect(layout.clippedTopbarActions).toEqual([]);
  expect(layout.squeezedComposerValues).toEqual([]);
  return layout;
}

test("the home dashboard opens the single canvas loader without a departure curtain", async ({
  page,
}) => {
  await enterAsGuest(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const home = page.locator(".wc-home");
  await expect(home).toBeVisible();
  await expect(home).toHaveAttribute("aria-label", "纬线主页");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/好|夜深了/);
  const brandLogo = home.locator(".wc-home-brand-mark img");
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
  await expect(page.getByRole("navigation", { name: "生成入口" })).toBeVisible();
  // 游客不假装已登录：账号服务可用时显示「登录」，未配置时标成「本地模式」。
  await expect(home.getByRole("button", { name: "登录画布账号" })).toContainText(/登录|本地模式/);
  await expect(page.locator(".wc-workspace, .react-flow")).toHaveCount(0);

  await home.locator(".wc-home-open-canvas").click();
  await expect(page).toHaveURL(/\/canvas$/);
  await expect(home).toHaveCount(0);
  await expect(page.locator(".wc-canvas-entry-loader")).toBeVisible();
  await expect(page.locator(".wc-canvas-entry-loader-mark img")).toBeVisible();
  await expect(page.locator(".wc-workspace")).toBeAttached();
  await expect(page.locator(".wc-app")).toHaveClass(/wc-app--entry-inside/);
});

test("the home composer hands prompt, model and parameters to the workbench", async ({ page }) => {
  await enterAsGuest(page);
  await mockCatalogApis(page);
  await page.goto("/");

  const composer = page.locator(".wc-home-composer");
  await expect(composer).toBeVisible();
  const tabs = composer.getByRole("tablist", { name: "生成类型" });
  await expect(tabs.getByRole("tab", { name: "图片生成" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(tabs.getByRole("tab", { name: "视频生成" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  await expect(composer.getByRole("button", { name: "模型" })).toContainText("画面生成模型");

  await composer.getByRole("button", { name: "尺寸" }).click();
  await page.getByRole("option", { name: "16:9" }).click();
  await expect(composer.getByRole("button", { name: "尺寸" })).toContainText("16:9");
  await composer.getByLabel("生成提示词").fill("雨夜城市，霓虹倒影");
  await composer.getByRole("button", { name: "生成图片" }).click();
  await expect(page).toHaveURL(/\/generate\/image\?prompt=/);
  const handoff = new URL(page.url());
  expect(handoff.searchParams.get("prompt")).toBe("雨夜城市，霓虹倒影");
  expect(handoff.searchParams.get("model")).toBe("e2e-image-model");
  expect(handoff.searchParams.get("p_size")).toBe('"16:9"');
  // 真实路径：主页已拉过目录（落在本机缓存），工作台首帧就有模型，参数原样进草稿。
  await expect(
    page.getByRole("group", { name: "尺寸" }).getByRole("radio", { name: "16:9" }),
  ).toBeChecked();

  await page.goto("/");
  await page
    .locator(".wc-home-composer")
    .getByRole("tablist", { name: "生成类型" })
    .getByRole("tab", { name: "视频生成" })
    .click();
  await expect(page.locator(".wc-home-composer")).toHaveAttribute("data-mode", "video");
  await expect(
    page.locator(".wc-home-composer").getByRole("button", { name: "模型" }),
  ).toContainText("镜头生成模型");
  await page.getByLabel("生成提示词").fill("云海延时");
  await page.getByLabel("生成提示词").press("Enter");
  await expect(page).toHaveURL(/\/generate\/video\?prompt=/);
  expect(new URL(page.url()).searchParams.get("model")).toBe("e2e-video-model");
});

test("Enter that confirms an IME candidate does not submit the home composer", async ({ page }) => {
  await enterAsGuest(page);
  await mockCatalogApis(page);
  await page.goto("/");

  const prompt = page.locator(".wc-home-composer").getByLabel("生成提示词");
  await prompt.fill("雨夜");
  // 输入法选字时浏览器派发 isComposing=true 的 Enter；这一下只确认候选词，不能提交。
  await prompt.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
  });
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect(prompt).toHaveValue("雨夜");
});

test("the prompt composer pre-fills the studio draft", async ({ page }) => {
  await mockCatalogApis(page);
  await page.goto("/generate/image?prompt=%E9%9B%A8%E5%A4%9C%E5%9F%8E%E5%B8%82");
  await expect(page.locator("[data-direct-prompt]")).toHaveValue("雨夜城市");
});

test("model and parameter selections carry into the studio draft", async ({ page }) => {
  await mockCatalogApis(page);
  await page.goto("/generate/image?model=e2e-image-model&p_size=" + encodeURIComponent('"16:9"'));
  await expect(page.getByRole("button", { name: "模型" })).toContainText("画面生成模型");
  await expect(
    page.getByRole("group", { name: "尺寸" }).getByRole("radio", { name: "16:9" }),
  ).toBeChecked();
});

test("an inspiration chip fills the home composer instead of leaving the page", async ({
  page,
}) => {
  await enterAsGuest(page);
  await mockCatalogApis(page);
  await page.goto("/");

  const first = page.locator(".wc-home-inspirations > button").first();
  const idea = (await first.textContent())?.trim() ?? "";
  expect(idea.length).toBeGreaterThan(0);
  await first.click();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  const prompt = page.locator(".wc-home-composer").getByLabel("生成提示词");
  await expect(prompt).toHaveValue(idea);
  await expect(prompt).toBeFocused();
});

test("the home project launcher opens the selected local project", async ({ page }) => {
  await enterAsGuest(page);
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
  await expect(launcher.getByRole("button", { name: "打开项目 入口项目 B" })).toBeVisible();
  await launcher.getByRole("button", { name: "打开项目 入口项目 A" }).click();

  await expect(page).toHaveURL(/\/canvas$/);
  await expect(page.locator(".wc-home")).toHaveCount(0, { timeout: 2_000 });
  await expect(projectName).toHaveValue("入口项目 A");
});

test("sidebar sections live in the URL and survive back navigation", async ({ page }) => {
  await enterAsGuest(page);
  await seedHomeLibrary(page);
  await page.goto("/");

  const sections = page.getByRole("navigation", { name: "主页分区" });
  await expect(sections.getByRole("button", { name: /首页/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await sections.getByRole("button", { name: /我的项目/ }).click();
  await expect(page).toHaveURL(/\?tab=projects$/);
  await expect(page.locator(".wc-home-main")).toHaveAttribute("data-tab", "projects");
  await expect(page.getByRole("button", { name: "打开项目 空白画布" })).toBeVisible();

  await sections.getByRole("button", { name: /创作历史/ }).click();
  await expect(page).toHaveURL(/\?tab=history$/);
  await page.goBack();
  await expect(page.locator(".wc-home-main")).toHaveAttribute("data-tab", "projects");
  await page.reload();
  await expect(page.locator(".wc-home-main")).toHaveAttribute("data-tab", "projects");
});

test("the sidebar keeps skills and drops the scrolling recent-opened list", async ({ page }) => {
  await enterAsGuest(page);
  await seedHomeLibrary(page);
  await page.goto("/");

  const sidebar = page.getByRole("complementary", { name: "主页侧栏" });
  // 「最近打开」整组移除：功能栏在常见高度下不需要滚动。
  await expect(sidebar.getByText("最近打开")).toHaveCount(0);
  await expect(sidebar.locator(".wc-home-recent")).toHaveCount(0);

  await sidebar.getByRole("button", { name: "技能", exact: true }).click();
  await expect(page).toHaveURL(/\?tab=skills$/);
  await expect(page.locator(".wc-home-main")).toHaveAttribute("data-tab", "skills");
  await expect(page.getByRole("heading", { name: "技能", level: 1 })).toBeVisible();
});

test("the command palette opens with the keyboard and jumps to a project", async ({ page }) => {
  await enterAsGuest(page);
  await seedHomeLibrary(page);
  await page.goto("/");
  await expect(page.locator(".wc-home")).toBeVisible();

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "搜索与快捷操作" });
  await expect(palette).toBeVisible();
  const search = palette.getByRole("combobox", { name: "搜索" });
  await search.fill("海报");
  // 项目、带这个项目名的作品都会命中；项目这一条的提示是节点数。
  const projectOption = palette.getByRole("option", { name: "雨夜霓虹海报 4 个节点" });
  await expect(projectOption).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  await page.keyboard.press("Control+K");
  await search.fill("霓虹海报");
  await projectOption.click();
  await expect(page).toHaveURL(/\/canvas$/);
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue("雨夜霓虹海报");
});

test("the account dialog opens above the home dashboard", async ({ page }) => {
  await enterAsGuest(page);
  await page.goto("/");
  const home = page.locator(".wc-home");
  await home.getByRole("button", { name: "登录画布账号" }).click();

  const dialog = page.getByRole("dialog", { name: "登录纬线" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("登录你的创作空间");
  // 指针反馈（一次性扩散环）在登录层上照常工作。
  const pulse = page.getByTestId("pointer-pulse");
  await dialog.getByRole("textbox", { name: "密码" }).hover();
  await expect(pulse).toHaveClass(/is-enter/, { timeout: 1_000 });
  const layers = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("[data-testid='pointer-pulse']");
    const style = element ? getComputedStyle(element) : null;
    return {
      home: Number.parseInt(getComputedStyle(document.querySelector(".wc-home")!).zIndex, 10),
      account: Number.parseInt(
        getComputedStyle(document.querySelector(".wc-auth-screen")!).zIndex,
        10,
      ),
      position: style?.position ?? null,
      pulseZ: style ? Number.parseInt(style.zIndex, 10) : Number.NaN,
      pointerEvents: style?.pointerEvents ?? null,
    };
  });
  expect(layers.account).toBeGreaterThan(layers.home);
  // 反馈层压在弹层之上，同时不参与命中，所以不会挡住对话框。
  expect(layers.position).toBe("fixed");
  expect(layers.pulseZ).toBeGreaterThan(layers.account);
  expect(layers.pointerEvents).toBe("none");

  await dialog.getByRole("button", { name: "稍后再登录" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(home).toBeVisible();
});

test("the topbar keeps every action complete on one line with a long account name", async ({
  page,
}, testInfo) => {
  const displayName = "流言蜚语工作室账号";
  await mockSignedIn(page, displayName);
  await page.setViewportSize({ width: 1_180, height: 800 });
  await page.goto("/");

  const topbar = page.locator(".wc-home-topbar");
  await expect(topbar.locator(".wc-home-account")).toContainText(displayName);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(displayName);

  const actions = await topbar.evaluate((element) => {
    // 头像字与名字的基线差 1–2px，按"垂直中心相距超过半行"才算换行。
    const rowsFor = (action: Element) => {
      const centers: number[] = [];
      const walker = document.createTreeWalker(action, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (node.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) centers.push(rect.top + rect.height / 2);
          }
        }
        node = walker.nextNode();
      }
      centers.sort((a, b) => a - b);
      return centers.filter((center, index) => index === 0 || center - centers[index - 1]! > 8)
        .length;
    };
    return [...element.querySelectorAll<HTMLElement>(".wc-home-topbar-actions > *")]
      .filter((action) => getComputedStyle(action).display !== "none")
      .map((action) => ({
        label: action.textContent?.trim() ?? "",
        rows: rowsFor(action),
        clipped: action.scrollWidth > action.clientWidth + 1,
      }));
  });
  expect(actions.map((action) => action.label)).toEqual([
    "",
    `${displayName.slice(0, 1)}${displayName}`,
    "打开画布",
  ]);
  expect(actions.filter((action) => action.label).every((action) => action.rows === 1)).toBe(true);
  expect(actions.every((action) => !action.clipped)).toBe(true);
  await expectCleanLayout(page);
  await page.screenshot({ path: testInfo.outputPath("home-topbar-long-name.png") });
});

for (const { label, viewport, collapsed } of [
  { label: "wide desktop", viewport: { width: 1_440, height: 900 }, collapsed: false },
  {
    label: "wide desktop, collapsed sidebar",
    viewport: { width: 1_440, height: 900 },
    collapsed: true,
  },
  { label: "small laptop", viewport: { width: 1_024, height: 768 }, collapsed: false },
  {
    label: "small laptop, collapsed sidebar",
    viewport: { width: 1_024, height: 768 },
    collapsed: true,
  },
  { label: "tablet", viewport: { width: 768, height: 1_024 }, collapsed: false },
  { label: "phone", viewport: { width: 390, height: 844 }, collapsed: false },
]) {
  test(`the home dashboard has no horizontal overflow on ${label}`, async ({ page }, testInfo) => {
    await enterAsGuest(page);
    await mockCatalogApis(page, { rich: true });
    await seedHomeLibrary(page);
    await setSidebarCollapsed(page, collapsed);
    await page.setViewportSize(viewport);
    await page.goto("/");

    const home = page.locator(".wc-home");
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("data-sidebar", collapsed ? "collapsed" : "expanded");
    await expect(page.getByRole("button", { name: "模型" })).toContainText("Gpt Image 2.5 1k2k4k");
    await expect(page.getByRole("button", { name: "背景", exact: true })).toContainText(
      "transparent",
    );
    // 封面与作品缩略图真的画出来了（不是空状态）。缩略图进视口才读取，先滚到创作历史。
    await expect(page.getByRole("button", { name: "打开项目 雨夜霓虹海报" })).toBeVisible();
    await page.locator(".wc-home-work").first().scrollIntoViewIfNeeded();
    await expect(page.locator(".wc-home-work img").first()).toBeVisible();
    await page.locator(".wc-home-main").evaluate((main) => main.scrollTo({ top: 0 }));

    const layout = await expectCleanLayout(page);
    const drawer = viewport.width <= 960;
    if (drawer) {
      // 窄屏侧栏收进抽屉：默认在屏幕外，顶栏出现菜单按钮。
      expect(layout.sidebar.visible).toBe(false);
      await expect(page.getByRole("button", { name: "打开侧栏" })).toBeVisible();
    } else {
      expect(layout.sidebar.left).toBe(0);
      expect(layout.sidebar.width).toBe(collapsed ? 64 : 248);
      await expect(page.getByRole("button", { name: "打开侧栏" })).toBeHidden();
    }
    await page.screenshot({
      path: testInfo.outputPath(`home-${testInfo.title.split(" on ")[1]}-top.png`),
    });

    await page
      .locator(".wc-home-main")
      .evaluate((main) => main.scrollTo({ top: main.scrollHeight }));
    await expectCleanLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`home-${testInfo.title.split(" on ")[1]}-bottom.png`),
    });
  });
}

test("the collapsed sidebar keeps every destination reachable and remembers the choice", async ({
  page,
}) => {
  await enterAsGuest(page);
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");

  const sidebar = page.getByRole("complementary", { name: "主页侧栏" });
  await sidebar.getByRole("button", { name: "收起侧栏" }).click();
  await expect(page.locator(".wc-home")).toHaveAttribute("data-sidebar", "collapsed");
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(64);

  // 文字收起后，每个入口仍然有可读的名字（title 兜底）且完整落在侧栏里。
  const entries = sidebar.locator(".wc-home-nav > a, .wc-home-nav > button");
  for (const name of [
    "首页",
    "我的项目",
    "创作历史",
    "资产库",
    "灵感模板",
    "技能",
    "图片生成",
    "视频生成",
    "音频生成",
    "创作画布",
  ]) {
    await expect(
      sidebar.getByRole(name.endsWith("生成") || name === "创作画布" ? "link" : "button", {
        name,
        exact: true,
      }),
    ).toBeVisible();
  }
  const escaping = await entries.evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < 0 || rect.right > 64);
      })
      .map((element) => element.textContent),
  );
  expect(escaping).toEqual([]);

  await page.reload();
  await expect(page.locator(".wc-home")).toHaveAttribute("data-sidebar", "collapsed");
  await sidebar.getByRole("button", { name: "展开侧栏" }).click();
  await expect(page.locator(".wc-home")).toHaveAttribute("data-sidebar", "expanded");
});

test("the narrow-screen drawer opens from the topbar and closes with the scrim or Escape", async ({
  page,
}, testInfo) => {
  await enterAsGuest(page);
  await seedHomeLibrary(page);
  await page.setViewportSize({ width: 768, height: 1_024 });
  await page.goto("/");

  const home = page.locator(".wc-home");
  const sidebar = page.getByRole("complementary", { name: "主页侧栏" });
  const sidebarLeft = () =>
    sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().left));
  // 新手教程的「去工作台」锚点在窄屏改挂首页快速开始卡，不指向屏幕外的抽屉。
  await expect(sidebar.locator('[data-wc-tour="goto-workbench"]')).toHaveCount(0);
  await expect(page.locator('.wc-home-quick [data-wc-tour="goto-workbench"]')).toHaveCount(3);

  await page.getByRole("button", { name: "打开侧栏" }).click();
  await expect(home).toHaveAttribute("data-drawer", "open");
  await expect.poll(sidebarLeft).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("home-tablet-drawer.png") });

  await page.getByRole("button", { name: "关闭侧栏" }).click({ position: { x: 700, y: 400 } });
  await expect(home).not.toHaveAttribute("data-drawer", "open");
  await expect.poll(sidebarLeft).toBeLessThan(0);

  await page.getByRole("button", { name: "打开侧栏" }).click();
  await expect(home).toHaveAttribute("data-drawer", "open");
  await page.keyboard.press("Escape");
  await expect(home).not.toHaveAttribute("data-drawer", "open");

  // 抽屉里选分区会自动收起抽屉。
  await page.getByRole("button", { name: "打开侧栏" }).click();
  await sidebar.getByRole("button", { name: /我的项目/ }).click();
  await expect(page).toHaveURL(/\?tab=projects$/);
  await expect(home).not.toHaveAttribute("data-drawer", "open");
});

test("direct canvas links bypass the home dashboard", async ({ page }) => {
  await page.goto("/canvas");
  await expect(page.locator(".wc-home")).toHaveCount(0);
  await expect(page.locator(".wc-workspace")).toBeVisible();
});

test("reduced motion keeps the direct loader entry functional", async ({ page }) => {
  await enterAsGuest(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const home = page.locator(".wc-home");
  await expect(home).toBeVisible();
  await home.locator(".wc-home-open-canvas").click();
  await expect(home).toHaveCount(0);
  await expect(page.locator(".wc-canvas-entry-loader")).toBeVisible();
  await expect(page.locator(".wc-app")).toHaveClass(/wc-app--entry-inside/);
});

test("the custom cursor is live on the home dashboard without blocking clicks", async ({
  page,
}) => {
  await mockSignedIn(page);
  await page.goto("/");
  await expect(page.locator(".wc-home")).toBeVisible();

  // 首动前保留原生光标（自绘光标画出来才接管）。
  const root = page.locator("html");
  await expect(root).not.toHaveClass(/has-wc-cursor/);
  const cursor = page.getByTestId("app-cursor");
  await expect(cursor).toBeAttached();

  await page.mouse.move(320, 320);
  await expect(cursor).toHaveClass(/is-visible/);
  await expect(root).toHaveClass(/has-wc-cursor/);
  await page.mouse.move(640, 400);
  await expect(cursor.locator(".wc-app-cursor-pointer")).toHaveAttribute("style", /translate3d/);

  // 悬停按钮切 link 态；自绘光标 pointer-events:none，点击照常穿透。
  const openCanvas = page.locator(".wc-home-open-canvas");
  await openCanvas.hover();
  await expect(cursor).toHaveClass(/is-link/);
  await openCanvas.click();
  await expect(page).toHaveURL(/\/canvas$/);
});

test.describe("legacy landing page (?view=landing)", () => {
  // 落地页预览对匿名访客会自动弹登录层（账号服务可用时）；mock 已登录会话保持自足。
  test.beforeEach(async ({ page }) => {
    await mockSignedIn(page);
  });

  test("the landing composer still hands off to the workbench", async ({ page }) => {
    await mockCatalogApis(page);
    await page.goto("/?view=landing");

    const gate = page.locator(".wc-entry-gate");
    await expect(gate).toBeVisible();
    await expect(page.locator(".wc-home")).toHaveCount(0);
    const composer = gate.locator(".wc-entry-composer");
    await expect(composer.getByRole("button", { name: "模型" })).toContainText("画面生成模型");

    await composer.getByLabel("生成提示词").fill("雨夜城市，霓虹倒影");
    await composer.getByRole("button", { name: "生成图片" }).click();
    await expect(page).toHaveURL(/\/generate\/image\?prompt=/);
    const handoff = new URL(page.url());
    expect(handoff.searchParams.get("model")).toBe("e2e-image-model");
    expect(handoff.searchParams.get("autosubmit")).toBe("1");

    await page.goto("/?view=landing");
    await page.locator(".wc-entry-inspirations > button").first().click();
    await expect(page).toHaveURL(/\/generate\/image\?prompt=/);
  });

  test("the landing page has no horizontal overflow on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?view=landing");
    const gate = page.locator(".wc-entry-gate");
    await expect(gate).toBeVisible();
    const dimensions = await gate.evaluate((element) => ({
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.documentScrollWidth).toBe(dimensions.documentClientWidth);
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  });
});
