import { readFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// 使用可见 PNG 覆盖带缩略图卡片的浏览器解码和非黑帧渲染。
const visibleCardThumbnail = readFileSync(new URL("../src/assets/card-library-logo.png", import.meta.url));

// 通过像素检查防止图片元素存在但实际呈现为黑卡。
async function imageNonBlackRatio(image: Locator) {
  return image.evaluate((element) => {
    if (!(element instanceof HTMLImageElement) || !element.complete || !element.naturalWidth || !element.naturalHeight) return 0;
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(element, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlackPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0 && (pixels[index] > 8 || pixels[index + 1] > 8 || pixels[index + 2] > 8)) nonBlackPixels += 1;
    }
    return nonBlackPixels / (canvas.width * canvas.height);
  });
}

const session = {
  user: {
    id: "77777777-7777-4777-8777-777777777777",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: "2026-07-22T00:00:00.000Z",
  },
  expiresAt: "2099-08-22T00:00:00.000Z",
};

let cardListRequests = 0;
let cardGroupRequests = 0;
let cardTagRequests = 0;
let cardListUrls: string[] = [];

test.beforeEach(async ({ page }) => {
  cardListRequests = 0;
  cardGroupRequests = 0;
  cardTagRequests = 0;
  cardListUrls = [];
  await page.addInitScript(() => localStorage.clear());
  await mockAuthenticatedBackgroundApis(page);
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await page.route("**/api/v1/wallet", (route) => route.fulfill({
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
  }));
  await page.route("**/api/v1/generation-jobs?*", (route) => route.fulfill({ json: { ok: true, data: [] } }));
  await page.route("**/api/v1/model-catalog?*", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "resource-test",
        capabilityVersion: "resource-test",
        pricingVersion: "resource-test",
        fetchedAt: "2026-07-22T00:00:00.000Z",
        expiresAt: "2099-08-22T00:00:00.000Z",
        quoteAvailable: false,
        models: [],
      },
    },
  }));
  await page.route("**/api/v1/card-library/groups", (route) => {
    cardGroupRequests += 1;
    return route.fulfill({ json: { ok: true, data: { groups: ["镜头", "角色"] } } });
  });
  await page.route("**/api/v1/card-library/tags", (route) => {
    cardTagRequests += 1;
    return route.fulfill({ json: { ok: true, data: { tags: ["#长焦", "#分镜", "#缩略图"] } } });
  });
  await page.route("**/api/v1/card-library/card-thumbnails/card-shot-preview.png", (route) => route.fulfill({
    body: visibleCardThumbnail,
    contentType: "image/png",
  }));
  await page.route("**/api/v1/card-library/media-sign?*", (route) => {
    const ref = new URL(route.request().url()).searchParams.get("ref") || "";
    return route.fulfill({ json: { ok: true, data: { url: `https://media.example.test/full/${encodeURIComponent(ref)}.png`, expiresIn: 3600, cdn: true } } });
  });
  await page.route("https://media.example.test/full/**", (route) => route.fulfill({
    body: visibleCardThumbnail,
    contentType: "image/png",
  }));
  await page.route("**/api/v1/card-library/media-proxy?*", (route) => route.fulfill({
    body: visibleCardThumbnail,
    contentType: "image/png",
  }));
  await page.route("**/api/v1/card-library/cards**", (route) => {
    cardListRequests += 1;
    cardListUrls.push(route.request().url());
    const url = new URL(route.request().url());
    const group = url.searchParams.get("group");
    const tag = url.searchParams.get("tag");
    if (tag === "#长焦") {
      const cards = [{
        id: "card-shot-group",
        title: "仓库镜头卡",
        prompt: "长焦压缩空间，人物从雾中进入画面。",
        imageRef: "",
        imageRefs: [],
        thumbUrl: "",
        hasImage: false,
        tags: ["#长焦"],
        group: "镜头",
        genJobId: null,
        isMidjourney: false,
        updatedAt: 2,
      }];
      return route.fulfill({ json: { ok: true, data: { cards, total: cards.length, page: 1, limit: 18 } } });
    }
    const cards = group === "角色" ? [] : group === "镜头" ? [{
      id: "card-shot-group",
      title: "仓库镜头卡",
      prompt: "长焦压缩空间，人物从雾中进入画面。",
      imageRef: "",
      imageRefs: [],
      thumbUrl: "",
      hasImage: false,
      tags: ["#长焦"],
      group: "镜头",
      genJobId: null,
      isMidjourney: false,
      updatedAt: 2,
    }, {
      id: "card-shot-preview",
      title: "可见缩略图卡片",
      prompt: "确认卡片库缩略图可见、可解码且不显示黑卡。",
      imageRef: "storage://card-images/user/card-shot-preview.png",
      imageRefs: [],
      thumbUrl: "/api/v1/card-library/card-thumbnails/card-shot-preview.png",
      hasImage: true,
      tags: ["#缩略图"],
      group: "镜头",
      genJobId: null,
      isMidjourney: false,
      updatedAt: 3,
    }, {
      id: "card-multi-image",
      title: "多图卡片",
      prompt: "收藏时应把封面和补充图都存进资产库。",
      imageRef: "storage://card-images/user/card-multi.png",
      imageRefs: ["storage://card-images/user/card-multi-2.png"],
      thumbUrl: "",
      hasImage: true,
      tags: ["#长焦"],
      group: "镜头",
      genJobId: null,
      isMidjourney: false,
      updatedAt: 4,
    }] : [{
      id: "card-rain-shot",
      title: "雨夜镜头",
      prompt: "低机位跟拍，湿润石板路反射零散霓虹。",
      imageRef: "",
      imageRefs: [],
      thumbUrl: "",
      hasImage: false,
      tags: ["#分镜"],
      group: null,
      genJobId: null,
      isMidjourney: false,
      updatedAt: 1,
    }];
    return route.fulfill({
      json: {
        ok: true,
        data: {
          cards,
          total: cards.length,
          page: 1,
          limit: 18,
        },
      },
    });
  });
});

test("anonymous card library keeps login visible and opens the account dialog", async ({ page }, testInfo) => {
  await page.unroute("**/api/v1/auth/session");
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      ok: true,
      data: null,
      capabilities: {
        available: true,
        registration: "native",
        registrationUrl: null,
        passwordResetUrl: null,
      },
    },
  }));
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/canvas");
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();

  const drawer = page.getByRole("dialog", { name: "资源库" });
  const login = drawer.getByRole("button", { name: "登录", exact: true });
  await expect(login).toBeVisible();
  await expect(drawer.getByText("登录后查看卡片库")).toBeVisible();

  const [drawerBox, loginBox] = await Promise.all([drawer.boundingBox(), login.boundingBox()]);
  expect(drawerBox).not.toBeNull();
  expect(loginBox).not.toBeNull();
  expect(loginBox!.x).toBeGreaterThanOrEqual(drawerBox!.x);
  expect(loginBox!.y).toBeGreaterThanOrEqual(drawerBox!.y);
  expect(loginBox!.x + loginBox!.width).toBeLessThanOrEqual(drawerBox!.x + drawerBox!.width);
  expect(loginBox!.y + loginBox!.height).toBeLessThanOrEqual(drawerBox!.y + drawerBox!.height);
  expect(await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))).toEqual({ x: 0, y: 0 });
  await page.screenshot({ path: testInfo.outputPath("card-library-login-dark.png") });

  await page.getByLabel("切换主题").click();
  await expect(page.locator(".kc-app")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: testInfo.outputPath("card-library-login-light.png") });

  await login.click();
  const accountDialog = page.getByRole("dialog", { name: "卡藏账号" });
  await expect(accountDialog).toBeVisible();
  await expect(accountDialog.getByRole("tab", { name: "登录" })).toHaveAttribute("aria-selected", "true");
  await accountDialog.getByRole("button", { name: "关闭" }).click();
  await expect(accountDialog).toBeHidden();
  await expect(drawer).toBeVisible();
});

test("card library filters by the repository's real groups", async ({ page }, testInfo) => {
  await page.goto("/canvas");
  await expect.poll(() => cardGroupRequests).toBe(1);
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  const groups = drawer.getByLabel("卡片分组");

  await expect(groups.getByRole("button", { name: "全部分组" })).toBeVisible();
  await expect(groups.getByRole("button", { name: "未分类" })).toBeVisible();
  await groups.getByRole("button", { name: "镜头" }).click();
  await expect(drawer.getByText("仓库镜头卡")).toBeVisible();
  expect(new URL(cardListUrls[cardListUrls.length - 1]!).searchParams.get("group")).toBe("镜头");
  await page.screenshot({ path: testInfo.outputPath("card-library-groups-dark.png") });
  await page.getByLabel("切换主题").click();
  await expect(page.locator(".kc-app")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: testInfo.outputPath("card-library-groups-light.png") });

  await groups.getByRole("button", { name: "未分类" }).click();
  await expect(drawer.getByText("雨夜镜头")).toBeVisible();
  expect(new URL(cardListUrls[cardListUrls.length - 1]!).searchParams.get("group")).toBe("uncategorized");

  const requestsBeforeAll = cardListRequests;
  await groups.getByRole("button", { name: "全部分组" }).click();
  await expect(drawer.getByText("雨夜镜头")).toBeVisible();
  expect(cardListRequests).toBe(requestsBeforeAll);
});

test("card library filters by the repository's real tags", async ({ page }) => {
  await page.goto("/canvas");
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });

  await expect(drawer.getByLabel("筛选标签")).toBeVisible();
  await drawer.getByLabel("筛选标签").click();
  await page.getByRole("listbox", { name: "筛选标签" }).getByRole("option", { name: "#长焦" }).click();
  await expect(drawer.getByText("仓库镜头卡")).toBeVisible();
  expect(new URL(cardListUrls[cardListUrls.length - 1]!).searchParams.get("tag")).toBe("#长焦");
});

test("saving a multi-image card stores the whole gallery in the asset library", async ({ page }) => {
  await page.goto("/canvas");
  const imageNodes = page.locator('.kc-node-wrap[data-node-kind="image"]');
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  await drawer.getByLabel("卡片分组").getByRole("button", { name: "镜头" }).click();

  const card = drawer.locator(".kc-card-library-item").filter({ hasText: "多图卡片" });
  await card.getByLabel("收藏卡片 多图卡片").click();
  await expect(card.getByLabel("多图卡片 已在资产库")).toBeVisible();

  await drawer.getByRole("tab", { name: "资产库" }).click();
  const asset = drawer.getByLabel("多图卡片 资产");
  await expect(asset).toBeVisible();
  await expect(asset.locator(".kc-asset-gallery-badge")).toHaveText("+1");

  const before = await imageNodes.count();
  await asset.getByLabel("将 多图卡片 加入画布").click();
  await expect.poll(() => imageNodes.count()).toBe(before + 2);
});

test("card library decodes visible remote thumbnails without a black card", async ({ page }, testInfo) => {
  await page.goto("/canvas");
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  await drawer.getByLabel("卡片分组").getByRole("button", { name: "镜头" }).click();

  const card = drawer.locator(".kc-card-library-item").filter({ hasText: "可见缩略图卡片" });
  const thumbnail = card.locator(".kc-card-library-preview img");
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => imageNonBlackRatio(thumbnail)).toBeGreaterThan(0.02);
  await page.screenshot({ path: testInfo.outputPath("card-library-visible-thumbnail.png") });
});

test("card library keeps a saved image card visible through asset insertion into canvas", async ({ page }, testInfo) => {
  await page.goto("/canvas");
  const canvasImages = page.locator('.kc-node-wrap[data-node-kind="image"] img');
  const originalCanvasImageCount = await canvasImages.count();
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  await drawer.getByLabel("卡片分组").getByRole("button", { name: "镜头" }).click();

  const card = drawer.locator(".kc-card-library-item").filter({ hasText: "可见缩略图卡片" });
  await card.getByLabel("收藏卡片 可见缩略图卡片").click();
  await expect(card.getByLabel("可见缩略图卡片 已在资产库")).toBeVisible();

  await drawer.getByRole("tab", { name: "资产库" }).click();
  const asset = drawer.getByLabel("可见缩略图卡片 资产");
  const assetImage = asset.locator(".kc-asset-preview img");
  await expect(assetImage).toBeVisible();
  await expect.poll(() => imageNonBlackRatio(assetImage)).toBeGreaterThan(0.02);

  await asset.getByLabel("将 可见缩略图卡片 加入画布").click();
  await expect(drawer).toBeHidden();
  await expect.poll(() => canvasImages.count()).toBeGreaterThan(originalCanvasImageCount);
  const canvasImage = canvasImages.last();
  await expect(canvasImage).toBeVisible();
  await expect.poll(() => imageNonBlackRatio(canvasImage)).toBeGreaterThan(0.02);
  await page.screenshot({ path: testInfo.outputPath("card-library-image-to-canvas.png") });
});

test("card library prefetches once and reuses the account-scoped cache", async ({ page }) => {
  await page.goto("/canvas");
  await expect.poll(() => cardListRequests).toBe(1);

  const resourceToggle = page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库");
  const logo = resourceToggle.locator(".kc-resource-toggle-logo");
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS("width", "26px");
  expect(await logo.evaluate((image: HTMLImageElement) => ({ complete: image.complete, width: image.naturalWidth }))).toEqual({ complete: true, width: 128 });

  await resourceToggle.click();
  await expect(page.getByRole("dialog", { name: "资源库" }).getByText("雨夜镜头")).toBeVisible();
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("收起资源库").click();
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  await expect(page.getByRole("dialog", { name: "资源库" }).getByText("雨夜镜头")).toBeVisible();
  expect(cardListRequests).toBe(1);

  await page.getByLabel("刷新卡片库").click();
  await expect.poll(() => cardListRequests).toBe(2);
});

test("cards are collected and categorized before they can create canvas nodes", async ({ page }, testInfo) => {
  await page.goto("/canvas");
  const textNodes = page.locator('.kc-node-wrap[data-node-kind="text"]');
  await expect(textNodes.first()).toBeVisible();
  const originalTextNodes = await textNodes.count();
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("雨夜镜头")).toBeVisible();

  await drawer.getByLabel("收藏卡片 雨夜镜头").click();
  await expect(drawer.getByLabel("雨夜镜头 已在资产库")).toBeVisible();
  expect(await textNodes.count()).toBe(originalTextNodes);

  await drawer.getByRole("tab", { name: "资产库" }).click();
  await expect(drawer.getByText("雨夜镜头")).toBeVisible();
  await drawer.getByLabel("新建文件夹").fill("分镜参考");
  await drawer.getByLabel("添加文件夹").click();
  await drawer.getByLabel("雨夜镜头 的分类").click();
  await page.getByRole("listbox", { name: "雨夜镜头 的分类" }).getByRole("option", { name: "分镜参考", exact: true }).click();
  await expect(drawer.getByRole("button", { name: /分镜参考/ }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("resource-library-dark.png") });

  await page.getByLabel("切换主题").click();
  await expect(page.locator(".kc-app")).toHaveAttribute("data-theme", "light");
  const colors = await drawer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { foreground: style.color, background: style.backgroundColor };
  });
  expect(colors.foreground).not.toBe(colors.background);
  await page.screenshot({ path: testInfo.outputPath("resource-library-light.png") });

  await drawer.getByLabel("将 雨夜镜头 加入画布").click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.kc-node-wrap[data-node-kind="text"]')).toHaveCount(originalTextNodes + 1);
  await expect(page.locator('.kc-node-wrap[data-node-kind="text"]').last()).toContainText("低机位跟拍");
});

test("asset folders support right-click creation, classification, deletion, and full-width rows", async ({ page }, testInfo) => {
  await page.goto("/canvas");
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  await drawer.getByLabel("收藏卡片 雨夜镜头").click();
  await drawer.getByRole("tab", { name: "资产库" }).click();

  const categories = drawer.getByLabel("资产分类");
  await categories.click({ button: "right", position: { x: 72, y: 140 } });
  const libraryMenu = page.getByRole("menu", { name: "资产库操作" });
  await expect(libraryMenu).toBeVisible();
  await libraryMenu.getByRole("menuitem", { name: "新建文件夹" }).click();
  await expect(drawer.getByLabel("新建文件夹")).toBeFocused();
  await drawer.getByLabel("新建文件夹").fill("分镜参考");
  await drawer.getByLabel("添加文件夹").click();

  const defaultFolder = categories.getByRole("button", { name: /未分类/ });
  const customFolder = categories.getByRole("button", { name: /分镜参考/ });
  await expect(customFolder).toBeVisible();
  const [defaultBox, customBox] = await Promise.all([defaultFolder.boundingBox(), customFolder.boundingBox()]);
  expect(defaultBox).not.toBeNull();
  expect(customBox).not.toBeNull();
  expect(Math.abs(defaultBox!.x - customBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((defaultBox!.x + defaultBox!.width) - (customBox!.x + customBox!.width))).toBeLessThanOrEqual(1);

  await customFolder.click({ button: "right" });
  await page.getByRole("menu", { name: "分镜参考 文件夹操作" }).getByRole("menuitem", { name: "重命名" }).click();
  await expect(drawer.getByLabel("重命名文件夹")).toHaveValue("分镜参考");
  await drawer.getByLabel("重命名文件夹").fill("镜头参考");
  await drawer.getByLabel("保存文件夹名称").click();
  const renamedFolder = categories.getByRole("button", { name: /镜头参考/ });
  await expect(renamedFolder).toBeVisible();

  const kindFilter = drawer.getByRole("group", { name: "资产类型" });
  await expect(kindFilter.getByRole("button", { name: "卡片", exact: true })).toHaveCount(0);
  await expect(drawer.getByLabel("雨夜镜头 资产")).toBeVisible();

  await drawer.getByLabel("雨夜镜头 资产").click({ button: "right" });
  const assetMenu = page.getByRole("menu", { name: "雨夜镜头 资产操作" });
  await expect(assetMenu).toBeVisible();
  const assetMenuBox = await assetMenu.boundingBox();
  const viewport = page.viewportSize();
  expect(assetMenuBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(assetMenuBox!.x).toBeGreaterThanOrEqual(12);
  expect(assetMenuBox!.x + assetMenuBox!.width).toBeLessThanOrEqual(viewport!.width - 12);
  expect(assetMenuBox!.y + assetMenuBox!.height).toBeLessThanOrEqual(viewport!.height - 12);
  await page.screenshot({ path: testInfo.outputPath("asset-context-menu-dark.png") });
  await page.keyboard.press("Escape");
  await page.getByLabel("切换主题").click();
  await expect(page.locator(".kc-app")).toHaveAttribute("data-theme", "light");
  await drawer.getByLabel("雨夜镜头 资产").click({ button: "right" });
  const lightAssetMenu = page.getByRole("menu", { name: "雨夜镜头 资产操作" });
  await expect(lightAssetMenu).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("asset-context-menu-light.png") });
  await lightAssetMenu.getByRole("menuitemradio", { name: "镜头参考" }).click();
  await expect(categories.getByRole("button", { name: /镜头参考 1/ })).toBeVisible();

  await renamedFolder.click({ button: "right" });
  const folderMenu = page.getByRole("menu", { name: "镜头参考 文件夹操作" });
  await expect(folderMenu.getByText("文件夹内资产将移至未分类")).toBeVisible();
  await folderMenu.getByRole("menuitem", { name: "删除文件夹" }).click();
  await expect(categories.getByRole("button", { name: /镜头参考/ })).toHaveCount(0);
  await defaultFolder.click();
  await expect(drawer.getByLabel("雨夜镜头 资产")).toBeVisible();
});

test("uploaded assets remain in the asset library and can be reused", async ({ page }) => {
  await page.goto("/canvas");
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  await drawer.getByRole("tab", { name: "资产库" }).click();

  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#283532";
    context.fillRect(0, 0, 160, 90);
    context.fillStyle = "#a2b9ae";
    context.fillRect(24, 18, 112, 54);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await drawer.locator('input[type="file"]').setInputFiles({ name: "visual-asset.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(drawer.getByText("visual-asset.png")).toBeVisible();

  const originalImageNodes = await page.locator('.kc-node-wrap[data-node-kind="image"]').count();
  await drawer.getByLabel("将 visual-asset.png 加入画布").click();
  await expect(page.locator('.kc-node-wrap[data-node-kind="image"]')).toHaveCount(originalImageNodes + 1);
  await expect(page.locator('.kc-node-wrap[data-node-kind="image"]').last().locator("img")).toBeVisible();
});

test("resource drawer and Agent companion remain balanced on compact desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/canvas");
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();

  const drawer = await page.getByRole("dialog", { name: "资源库" }).boundingBox();
  const dock = await page.getByRole("navigation", { name: "编辑工具" }).boundingBox();
  const companion = await page.getByLabel("打开画布 Agent").boundingBox();
  const project = await page.locator(".kc-project-console").boundingBox();
  const actions = await page.locator(".kc-topbar-actions").boundingBox();
  expect(drawer).not.toBeNull();
  expect(dock).not.toBeNull();
  expect(companion).not.toBeNull();
  expect(project).not.toBeNull();
  expect(actions).not.toBeNull();
  expect(drawer!.x).toBeGreaterThanOrEqual(12);
  expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(1012);
  expect(drawer!.y + drawer!.height).toBeLessThan(dock!.y);
  expect(project!.x + project!.width + 12).toBeLessThan(companion!.x);
  expect(companion!.x + companion!.width + 12).toBeLessThan(actions!.x);
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
});

test("card library click opens the preview and inserts only from the preview button", async ({ page }) => {
  await page.goto("/canvas");
  const imageNodes = page.locator('.kc-node-wrap[data-node-kind="image"]');
  const before = await imageNodes.count();
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  await drawer.getByLabel("卡片分组").getByRole("button", { name: "镜头" }).click();

  const card = drawer.locator(".kc-card-library-item").filter({ hasText: "可见缩略图卡片" });
  await card.click();

  const preview = page.getByRole("dialog", { name: /卡片预览/ });
  await expect(preview).toBeVisible();
  await expect(preview.locator(".kc-card-preview-title")).toHaveText("可见缩略图卡片");
  await expect(preview.locator(".kc-card-preview-canvas img")).toBeVisible();
  await expect(preview.getByText("#缩略图")).toBeVisible();
  await expect(preview.getByText("确认卡片库缩略图可见、可解码且不显示黑卡。")).toBeVisible();
  await expect.poll(() => imageNodes.count()).toBe(before);

  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(drawer).toBeVisible();

  // 重新打开预览，从右侧按钮加入画布：插入成功后抽屉与预览一起收起。
  await card.click();
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "加入画布" }).click();
  await expect.poll(() => imageNodes.count()).toBe(before + 1);
  await expect(drawer).toBeHidden();
  await expect(preview).toBeHidden();
});

test("multi-image card preview navigates the gallery", async ({ page }) => {
  await page.goto("/canvas");
  await page.getByRole("navigation", { name: "编辑工具" }).getByLabel("打开资源库").click();
  const drawer = page.getByRole("dialog", { name: "资源库" });
  await drawer.getByLabel("卡片分组").getByRole("button", { name: "镜头" }).click();

  const card = drawer.locator(".kc-card-library-item").filter({ hasText: "多图卡片" });
  await card.click();

  const preview = page.getByRole("dialog", { name: /卡片预览/ });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("共 2 张图")).toBeVisible();
  await expect(preview.getByText("1 / 2")).toBeVisible();
  await preview.getByRole("button", { name: "下一张图" }).click();
  await expect(preview.getByText("2 / 2")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(preview.getByText("1 / 2")).toBeVisible();
  await preview.getByRole("button", { name: "查看第 2 张图" }).click();
  await expect(preview.getByText("2 / 2")).toBeVisible();
});
