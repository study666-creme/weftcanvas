import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = "2026-07-25T12:00:00.000Z";
const EXPIRES_AT = "2026-08-25T12:00:00.000Z";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const session = {
  user: {
    id: USER_ID,
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: NOW,
  },
  expiresAt: EXPIRES_AT,
};

const entitlements = {
  tier: "pro",
  cloudProjectLimit: 500,
  projectStorageBytes: 1024 * 1024 * 1024,
  mediaStorageBytes: 300 * 1024 * 1024 + 30 * 1024 * 1024 * 1024,
  revisionRetentionCount: 50,
  multiDeviceSync: true,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("weftcanvas-cloud-quota-e2e-seeded")) return;
    localStorage.clear();
    sessionStorage.setItem("weftcanvas-cloud-quota-e2e-seeded", "1");
  });
  await mockAuthenticatedShell(page);
});

test("quota exhaustion keeps edits local and requires an explicit retry", async ({
  page,
}, testInfo) => {
  let createCalls = 0;
  await page.route("**/api/v1/cloud-projects**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path !== "/api/v1/cloud-projects") return route.fallback();
    if (request.method() === "GET") {
      return route.fulfill({
        json: {
          ok: true,
          data: {
            projects: [],
            usage: {
              projectCount: 3,
              projectStorageBytes: 10 * 1024 * 1024,
              mediaStorageBytes: 300 * 1024 * 1024,
              entitlements: {
                ...entitlements,
                tier: "free",
                cloudProjectLimit: 3,
                projectStorageBytes: 10 * 1024 * 1024,
                mediaStorageBytes: 300 * 1024 * 1024,
                revisionRetentionCount: 3,
              },
            },
          },
        },
      });
    }
    if (request.method() === "POST") {
      createCalls += 1;
      return route.fulfill({
        status: 403,
        json: {
          ok: false,
          error: {
            code: "CLOUD_PROJECT_LIMIT_REACHED",
            message: "The account cloud project limit has been reached",
          },
        },
      });
    }
    return route.fallback();
  });

  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  let sidebar = await openProjectLibrary(page);
  await expect(sidebar).toContainText("项目 3/3");
  await sidebar.getByRole("button", { name: "保存到云端" }).click();

  const localOnly = sidebar.getByRole("button", {
    name: /云空间已满，当前内容仍保存在本地，点击重试/,
  });
  await expect(localOnly).toBeVisible();
  expect(createCalls).toBe(1);

  await sidebar.getByLabel("关闭项目栏").click();
  const projectName = page.getByLabel("项目名称");
  await projectName.fill("超额后仍可本地编辑");
  await projectName.blur();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.waitForTimeout(3_500);
  expect(createCalls).toBe(1);

  await page.reload();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  sidebar = await openProjectLibrary(page);
  await expect(
    sidebar.getByRole("button", { name: /云空间已满，当前内容仍保存在本地，点击重试/ }),
  ).toBeVisible();
  await sidebar.getByLabel("关闭项目栏").click();
  const reloadedProjectName = page.getByLabel("项目名称");
  await reloadedProjectName.fill("刷新后继续本地编辑");
  await reloadedProjectName.blur();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.waitForTimeout(3_500);
  expect(createCalls).toBe(1);

  sidebar = await openProjectLibrary(page);
  await expect(sidebar.getByText("刷新后继续本地编辑", { exact: true })).toBeVisible();
  await expect(localOnly).toBeVisible();
  await page.waitForTimeout(240);
  await page.screenshot({ path: testInfo.outputPath("cloud-local-only-dark.png") });

  await localOnly.click();
  await expect.poll(() => createCalls).toBe(2);
  await expect(localOnly).toBeVisible();

  await sidebar.getByLabel("关闭项目栏").click();
  await page.getByLabel("切换主题").click();
  sidebar = await openProjectLibrary(page);
  await expect(sidebar.getByRole("button", { name: /云空间已满/ })).toBeVisible();
  await page.waitForTimeout(240);
  await page.screenshot({ path: testInfo.outputPath("cloud-local-only-light.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  const [sidebarBox, buttonBox] = await Promise.all([
    sidebar.boundingBox(),
    sidebar.getByRole("button", { name: /云空间已满/ }).boundingBox(),
  ]);
  expect(sidebarBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x);
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width);
});

test("collaboration shows the free five-person account limit without a paid seat entry", async ({
  page,
}, testInfo) => {
  let projectId = "";
  let productReads = 0;
  await page.route("**/api/v1/wallet/products", (route) => {
    productReads += 1;
    return route.fulfill({
      json: {
        ok: true,
        data: [
          {
            kind: "collaboration_seat",
            id: "canvas-collaboration-seat-1",
            amount: 15,
            seats: 1,
          },
        ],
        customCreditTopUp: null,
      },
    });
  });
  await page.route("**/api/v1/wallet/ledger**", (route) =>
    route.fulfill({
      json: { ok: true, data: { items: [] } },
    }),
  );
  await page.route("**/api/v1/cloud-projects**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/cloud-projects" && request.method() === "GET") {
      return route.fulfill({
        json: {
          ok: true,
          data: {
            projects: projectId ? [projectSummary(projectId)] : [],
            usage: {
              projectCount: projectId ? 1 : 0,
              projectStorageBytes: projectId ? 512 : 0,
              mediaStorageBytes: 0,
              entitlements,
            },
          },
        },
      });
    }
    if (projectId && path === `/api/v1/cloud-projects/${projectId}/members`) {
      return route.fulfill({
        json: {
          ok: true,
          data: {
            members: [
              { projectId, principalId: USER_ID, role: "owner", createdAt: NOW },
              {
                projectId,
                principalId: "22222222-2222-4222-8222-222222222222",
                role: "member",
                createdAt: NOW,
              },
            ],
            invitations: [],
            seatUsage: { limit: 4, used: 4 },
          },
        },
      });
    }
    if (
      projectId &&
      path === `/api/v1/cloud-projects/${projectId}/members/invitations` &&
      request.method() === "POST"
    ) {
      return route.fulfill({
        status: 403,
        json: {
          ok: false,
          error: {
            code: "COLLABORATION_SEAT_LIMIT_REACHED",
            message: "seat limit reached",
          },
        },
      });
    }
    return route.fallback();
  });
  await page.route("**/api/v1/cloud-project-invitations", (route) =>
    route.fulfill({
      json: { ok: true, data: { invitations: [] } },
    }),
  );

  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  projectId = await page.evaluate(() => localStorage.getItem("weftcanvas:active-project:v1") ?? "");
  expect(projectId).not.toBe("");
  await page.evaluate(
    ({ ownerId, id }) => {
      const key = `weftcanvas:cloud-link:v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(id)}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          ownerId,
          projectId: id,
          revision: 1,
          lastSyncedFingerprint: "a".repeat(64),
        }),
      );
    },
    { ownerId: USER_ID, id: projectId },
  );
  await page.reload();

  await page.getByLabel("项目协作").click();
  const dialog = page.getByRole("dialog", { name: "项目协作" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("协作最多 5 人")).toBeVisible();
  await expect(dialog.getByText("含所有者和最多 4 名协作者，当前限免，可跨项目复用")).toBeVisible();
  await expect(dialog.getByText("账号席位已占用 4/4")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "购买额外席位" })).toHaveCount(0);
  expect(productReads).toBe(0);

  await dialog.getByLabel("移除 22222222-2222-4222-8222-222222222222").click();
  const confirmation = page.getByRole("dialog", { name: "移除协作成员" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("该成员将立即失去此项目的访问与协作权限");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toBeHidden();

  await dialog.getByLabel("协作者账号 ID").fill("22222222-2222-4222-8222-222222222222");
  await dialog.getByRole("button", { name: "邀请", exact: true }).click();
  const error = dialog.getByRole("alert");
  await expect(error).toContainText("5 人上限");
  await expect(error).toContainText("取消待处理邀请");
  await page.screenshot({ path: testInfo.outputPath("collaboration-seat-policy-dark.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  const [mobileDialogBox, viewport] = await Promise.all([
    dialog.boundingBox(),
    page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ]);
  expect(mobileDialogBox).not.toBeNull();
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  await page.screenshot({ path: testInfo.outputPath("collaboration-seat-policy-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(productReads).toBe(0);
});

async function openProjectLibrary(page: Page) {
  await page.getByLabel("项目菜单").click();
  const sidebar = page.locator(".wc-project-sidebar");
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function mockAuthenticatedShell(page: Page) {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: session },
    }),
  );
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          credits: 100,
          creditsPermanent: 100,
          dailyCredits: 0,
          creditGrantMode: null,
          dailyCreditsNote: null,
          membership: {
            tier: "pro",
            until: EXPIRES_AT,
            active: true,
            queuedTier: null,
            queuedUntil: null,
            genDiscount: null,
          },
          lifetimeCreditsSpent: 0,
        },
      },
    }),
  );
  await page.route("**/api/v1/model-catalog**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          version: "quota-e2e-catalog",
          capabilityVersion: "quota-e2e-capability",
          pricingVersion: "quota-e2e-pricing",
          fetchedAt: NOW,
          expiresAt: EXPIRES_AT,
          quoteAvailable: false,
          models: [],
        },
      },
    }),
  );
  await page.route("**/api/v1/generation-jobs**", emptyList);
  await page.route("**/api/v1/membership/tasks", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          items: [],
          lifetimeCreditsSpent: 0,
          nextSpendMilestone: 1_000,
          hub: {
            phoneVerified: true,
            signStreak: 0,
            checkedInToday: true,
            daysToStreakBonus: 7,
            dailyBonus: { key: "daily_bonus_2099-07-21", claimed: true, ready: false },
            memberDaily: null,
          },
          phoneVerified: true,
        },
      },
    }),
  );
}

function emptyList(route: Route) {
  return route.fulfill({ json: { ok: true, data: [] } });
}

function projectSummary(id: string) {
  return {
    schemaVersion: 1,
    id,
    title: "纬线画布 1",
    revision: 1,
    documentBytes: 512,
    localMediaCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
