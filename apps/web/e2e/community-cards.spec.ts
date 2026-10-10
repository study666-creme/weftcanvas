import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

// 社区卡片弹层（画布左栏创建栏）：点击卡片 = 大图预览；只有预览层右侧
// 的「加入画布」按钮（或行内「画布」键）会真正插入节点。
const communityImage = readFileSync(new URL("../src/assets/card-library-logo.png", import.meta.url));

const communityPosts = [
  {
    id: "community-post-rain",
    sourceCardId: null,
    authorName: "创作者小卡",
    title: "雨夜社区卡",
    prompt: "低机位跟拍雨夜街道，霓虹反射在湿石板路上。",
    image: "https://media.example.test/community/post-rain.png",
    imageUrl: "https://media.example.test/community/post-rain.png",
    likes: 12,
    createdAt: 1_757_000_000_000,
  },
  {
    id: "community-post-fog",
    sourceCardId: null,
    authorName: "雾中镜头",
    title: "浓雾社区卡",
    prompt: "浓雾中的仓库长廊，人物剪影缓缓靠近。",
    image: "https://media.example.test/community/post-fog.png",
    imageUrl: "",
    likes: 0,
    createdAt: 1_756_900_000_000,
  },
];

const session = {
  user: {
    id: "77777777-7777-4777-8777-777777777777",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: "2026-07-22T00:00:00.000Z",
  },
  expiresAt: "2099-08-22T00:00:00.000Z",
};

test.beforeEach(async ({ page }) => {
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
        version: "community-test",
        capabilityVersion: "community-test",
        pricingVersion: "community-test",
        fetchedAt: "2026-09-12T00:00:00.000Z",
        expiresAt: "2099-09-12T00:00:00.000Z",
        quoteAvailable: false,
        models: [],
      },
    },
  }));
  // 已登录会话会在空闲时预热卡片库，静默兜底空列表。
  await page.route("**/api/v1/card-library/cards**", (route) => route.fulfill({
    json: { ok: true, data: { cards: [], total: 0, page: 1, limit: 18 } },
  }));
  await page.route("**/api/v1/card-library/groups", (route) => route.fulfill({ json: { ok: true, data: { groups: [] } } }));
  await page.route("**/api/v1/card-library/tags", (route) => route.fulfill({ json: { ok: true, data: { tags: [] } } }));
  await page.route("**/api/v1/community/feed?*", (route) => route.fulfill({
    json: { ok: true, data: { posts: communityPosts, limit: 30, offset: 0, nextOffset: -1, hasMore: false } },
  }));
  await page.route("https://media.example.test/community/**", (route) => route.fulfill({
    body: communityImage,
    contentType: "image/png",
  }));
  // https 直连不带 CORS 头时，插入链路回退到同源代理代拉。
  await page.route("**/api/v1/card-library/media-proxy?*", (route) => route.fulfill({
    body: communityImage,
    contentType: "image/png",
  }));
});

test("community card click opens the large preview without inserting", async ({ page }) => {
  await page.goto("/canvas");
  const imageNodes = page.locator('.kc-node-wrap[data-node-kind="image"]');
  const before = await imageNodes.count();

  await page.locator(".kc-create-rail-community").hover();
  const popover = page.getByRole("menu", { name: "社区卡片" });
  const card = popover.locator(".kc-community-item").filter({ hasText: "雨夜社区卡" });
  await expect(card).toBeVisible();
  await card.click();

  const preview = page.getByRole("dialog", { name: /卡片预览/ });
  await expect(preview).toBeVisible();
  await expect(preview.locator(".kc-card-preview-title")).toHaveText("雨夜社区卡");
  await expect(preview.locator(".kc-card-preview-canvas img")).toBeVisible();
  await expect(preview.getByText("创作者小卡")).toBeVisible();
  await expect(preview.getByText("低机位跟拍雨夜街道，霓虹反射在湿石板路上。")).toBeVisible();
  await expect(preview.getByRole("button", { name: "加入画布" })).toBeVisible();
  await expect.poll(() => imageNodes.count()).toBe(before);

  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect.poll(() => imageNodes.count()).toBe(before);
});

test("community preview inserts into the canvas only via the add button", async ({ page }) => {
  await page.goto("/canvas");
  const imageNodes = page.locator('.kc-node-wrap[data-node-kind="image"]');
  const before = await imageNodes.count();

  await page.locator(".kc-create-rail-community").hover();
  const popover = page.getByRole("menu", { name: "社区卡片" });
  const card = popover.locator(".kc-community-item").filter({ hasText: "雨夜社区卡" });
  await expect(card).toBeVisible();

  // 行内「画布」键仍然直接插入，不打开放大层。
  await card.getByLabel("加入画布 雨夜社区卡").click();
  await expect.poll(() => imageNodes.count()).toBe(before + 1);
  await expect(page.getByRole("dialog", { name: /卡片预览/ })).toBeHidden();

  // 点击卡片本体打开预览，再由预览层右侧按钮插入。
  await card.click();
  const preview = page.getByRole("dialog", { name: /卡片预览/ });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "加入画布" }).click();
  await expect.poll(() => imageNodes.count()).toBe(before + 2);
  await expect(preview).toBeHidden();
});
