import { expect, test, type Page } from "@playwright/test";

import { HOSTED_WALLET_NOTICE } from "../src/lib/hosted-wallet-notice";

/**
 * 托管站内测期不开充值：账户面板里的商品列表、结账、自定义金额、待支付订单这几条
 * 被一条告知替代（用户 2026-10-15，见 lib/hosted-wallet-notice）。公开/自托管构建
 * 那份模块是 null，这些用例照旧全跑——结账链路的覆盖落在公开树 CI 上。
 */
const RECHARGE_DISABLED = HOSTED_WALLET_NOTICE !== null;
const RECHARGE_SKIP_REASON = "内测期充值面板关闭（见 lib/hosted-wallet-notice）";

const NOW = "2026-07-20T08:00:00.000Z";
const EXPIRES_AT = "2099-07-21T08:00:00.000Z";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_STORAGE_KEY = "weftcanvas:wallet-order:v1";

const capabilities = {
  available: true,
  registration: "external" as const,
  registrationUrl: "https://accounts.example.com/register",
  passwordResetUrl: "https://accounts.example.com/forgot-password",
};

const session = {
  user: {
    id: USER_ID,
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: NOW,
  },
  expiresAt: EXPIRES_AT,
};

const products = [
  { kind: "credits" as const, id: "credits-80", amount: 9.9, credits: 80 },
  { kind: "credits" as const, id: "credits-500", amount: 49, credits: 500 },
  { kind: "membership" as const, id: "member-pro", amount: 39, tier: "pro", days: 30 },
  { kind: "collaboration_seat" as const, id: "canvas-collaboration-seat-1", amount: 15, seats: 1 },
];

const customCreditTopUp = {
  productId: "points-custom",
  minAmount: 5,
  maxAmount: 5000,
  creditsPerYuan: 100,
};

function walletSummary(credits: number) {
  return {
    credits,
    creditsPermanent: Math.max(0, credits - 8.5),
    dailyCredits: 8.5,
    creditGrantMode: "bundle" as const,
    dailyCreditsNote: "每日 00:00 刷新",
    membership: {
      tier: "pro",
      until: "2026-08-19T08:00:00.000Z",
      active: true,
      genDiscount: "九折",
    },
    lifetimeCreditsSpent: 42,
  };
}

function membershipTaskCenter(dailyClaimed = false) {
  return {
    items: [
      {
        key: "canvas_create_node",
        title: "首次创建画布节点",
        description: "在画布中创建任意节点",
        rewardDays: 1,
        rewardCredits: 0,
        rewardTier: "basic" as const,
        claimed: false,
        ready: true,
        progress: "已完成",
        kind: "claim" as const,
      },
    ],
    lifetimeCreditsSpent: 42,
    nextSpendMilestone: 1_000,
    hub: {
      phoneVerified: true,
      signStreak: 3,
      checkedInToday: dailyClaimed,
      daysToStreakBonus: 4,
      dailyBonus: {
        key: "daily_bonus_2026-07-26",
        claimed: dailyClaimed,
        ready: !dailyClaimed,
      },
      memberDaily: null,
    },
    phoneVerified: true,
  };
}

function ledgerItem(
  overrides: Partial<{
    id: string;
    delta: number;
    balanceAfter: number;
    reason: string;
    reasonLabel: string;
    refId: string | null;
  }> = {},
) {
  return {
    id: "ledger-initial",
    delta: -2,
    balanceAfter: 128.5,
    reason: "generation",
    reasonLabel: "生成消费",
    refId: "JOB1001",
    meta: null,
    createdAt: NOW,
    ...overrides,
  };
}

async function preparePage(page: Page, persistedOrder: Record<string, unknown> | null = null) {
  await page.addInitScript(
    ({ order, storageKey }) => {
      if (!sessionStorage.getItem("weftcanvas-account-wallet-e2e-seeded")) {
        localStorage.clear();
        if (order) localStorage.setItem(storageKey, JSON.stringify(order));
        sessionStorage.setItem("weftcanvas-account-wallet-e2e-seeded", "1");
      }

      const popup = {
        closed: false,
        opener: null,
        location: { replace: () => undefined },
        close: () => undefined,
      };
      Object.defineProperty(window, "open", {
        configurable: true,
        value: () => popup as unknown as Window,
      });
    },
    { order: persistedOrder, storageKey: ORDER_STORAGE_KEY },
  );

  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          version: "wallet-e2e-catalog",
          capabilityVersion: "wallet-e2e-capability",
          pricingVersion: "wallet-e2e-pricing",
          fetchedAt: NOW,
          expiresAt: EXPIRES_AT,
          quoteAvailable: false,
          models: [],
        },
      },
    }),
  );
  await page.route("**/api/v1/generation-jobs?*", (route) =>
    route.fulfill({
      json: { ok: true, data: [] },
    }),
  );
  await page.route("**/api/v1/membership/tasks", (route) =>
    route.fulfill({
      json: { ok: true, data: membershipTaskCenter() },
    }),
  );
  await page.route("**/api/v1/cloud-projects**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          projects: [],
          sharedProjects: [],
          usage: {
            projectCount: 0,
            projectStorageBytes: 0,
            mediaStorageBytes: 0,
            entitlements: {
              tier: "pro",
              cloudProjectLimit: 500,
              projectStorageBytes: 1024 * 1024 * 1024,
              mediaStorageBytes: 30 * 1024 * 1024 * 1024,
              revisionRetentionCount: 50,
              multiDeviceSync: true,
            },
          },
        },
      },
    }),
  );
  await page.route("**/api/v1/cloud-project-invitations", (route) =>
    route.fulfill({
      json: { ok: true, data: { invitations: [] } },
    }),
  );
}

async function openAccount(page: Page, name: string | RegExp = "登录画布账号") {
  await page.getByRole("button", { name }).click();
  const dialog = page.getByRole("dialog", { name: "纬线账号" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openWallet(page: Page, name: string | RegExp = "登录画布账号") {
  const dialog = await openAccount(page, name);
  const walletTab = dialog.getByRole("tab", { name: "积分充值" });
  await walletTab.click();
  await expect(walletTab).toHaveAttribute("aria-selected", "true");
  return dialog;
}

async function mockAuthenticatedWallet(
  page: Page,
  options: {
    summary?: () => ReturnType<typeof walletSummary>;
    ledger?: () => ReturnType<typeof ledgerItem>[];
    walletCalls?: { summary: number; products: number; ledger: number };
    customTopUp?: boolean;
    tasks?: () => ReturnType<typeof membershipTaskCenter>;
  } = {},
) {
  const calls = options.walletCalls ?? { summary: 0, products: 0, ledger: 0 };
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: session, capabilities },
    }),
  );
  await page.route("**/api/v1/wallet", (route) => {
    calls.summary += 1;
    return route.fulfill({ json: { ok: true, data: options.summary?.() ?? walletSummary(128.5) } });
  });
  await page.route("**/api/v1/wallet/products", (route) => {
    calls.products += 1;
    return route.fulfill({
      json: {
        ok: true,
        data: products,
        ...(options.customTopUp ? { customCreditTopUp } : {}),
      },
    });
  });
  await page.route("**/api/v1/wallet/ledger?*", (route) => {
    calls.ledger += 1;
    return route.fulfill({
      json: { ok: true, data: { items: options.ledger?.() ?? [ledgerItem()] } },
    });
  });
  await page.route("**/api/v1/membership/tasks", (route) =>
    route.fulfill({
      json: { ok: true, data: options.tasks?.() ?? membershipTaskCenter() },
    }),
  );
  await page.route("**/api/v1/cloud-projects**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          projects: [],
          sharedProjects: [],
          usage: {
            projectCount: 0,
            projectStorageBytes: 0,
            mediaStorageBytes: 0,
            entitlements: {
              tier: "pro",
              cloudProjectLimit: 500,
              projectStorageBytes: 1024 * 1024 * 1024,
              mediaStorageBytes: 30 * 1024 * 1024 * 1024,
              revisionRetentionCount: 50,
              multiDeviceSync: true,
            },
          },
        },
      },
    }),
  );
  await page.route("**/api/v1/cloud-project-invitations", (route) =>
    route.fulfill({
      json: { ok: true, data: { invitations: [] } },
    }),
  );
  return calls;
}

test("账号默认展示共享会员权益及当前限免能力", async ({ page }) => {
  await preparePage(page);
  await mockAuthenticatedWallet(page);

  await page.goto("/canvas");
  const dialog = await openAccount(page, "账号：创作者");
  await expect(dialog.getByRole("tab", { name: "会员权益" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByText("会员状态与卡片库实时共享")).toBeVisible();

  const preview = dialog.getByRole("region", { name: "当前开放权益" });
  await expect(preview).toContainText("自定义 API");
  await expect(preview).toContainText("标准会员权益 · 当前限免");
  await expect(preview).toContainText("多人协作（最多 5 人）");
  await expect(preview).toContainText("专业会员权益 · 当前限免");

  const standardPlan = dialog.locator(".wc-membership-plan").filter({ hasText: "标准会员" });
  await expect(standardPlan).toContainText("自定义 API");
  await expect(standardPlan).toContainText("当前限免");
  const proPlan = dialog.locator(".wc-membership-plan").filter({ hasText: "专业会员" });
  await expect(proPlan).toContainText("多人协作（最多 5 人）");
  await expect(proPlan).toContainText("当前限免");
});

test("任务快捷入口显示可领取数并在领取每日五积分后刷新状态", async ({ page }) => {
  await preparePage(page);
  let dailyClaimed = false;
  let credits = 128.5;
  let taskReads = 0;
  let claimBody: unknown = null;
  const walletCalls = { summary: 0, products: 0, ledger: 0 };
  await mockAuthenticatedWallet(page, {
    walletCalls,
    summary: () => walletSummary(credits),
    tasks: () => {
      taskReads += 1;
      return membershipTaskCenter(dailyClaimed);
    },
  });
  await page.route("**/api/v1/membership/tasks/daily_bonus_2026-07-26/claim", (route) => {
    claimBody = route.request().postDataJSON();
    dailyClaimed = true;
    credits += 5;
    return route.fulfill({
      json: { ok: true, data: { message: "已领取 5 积分" } },
    });
  });

  await page.goto("/canvas");
  const taskTrigger = page.getByRole("button", { name: "任务中心，有 2 项奖励可领取" });
  await expect(taskTrigger).toBeVisible();
  await expect(taskTrigger.locator(".wc-membership-task-count")).toHaveText("2");
  await taskTrigger.click();

  const dialog = page.getByRole("dialog", { name: "纬线账号" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "任务中心" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const dailyCard = dialog
    .locator(".wc-membership-daily article")
    .filter({ hasText: "每日免费积分" });
  await expect(dailyCard).toContainText("今日领取 5 积分");
  await dailyCard.getByRole("button", { name: "领取", exact: true }).click();

  await expect(dailyCard.getByRole("button", { name: "今日已领" })).toBeDisabled();
  await expect(page.locator(".wc-toast--success")).toContainText("已领取 5 积分");
  await expect(page.getByRole("button", { name: "任务中心，有 1 项奖励可领取" })).toBeVisible();
  await expect(page.getByRole("button", { name: "当前积分 133.5，点击刷新" })).toBeVisible();
  expect(claimBody).toEqual({});
  expect(taskReads).toBeGreaterThanOrEqual(2);
  expect(walletCalls.summary).toBeGreaterThanOrEqual(2);
  expect(walletCalls.ledger).toBeGreaterThanOrEqual(1);
});

test("画布内注册支持确认密码和待验证邮箱状态", async ({ page }) => {
  await preparePage(page);
  const inAppCapabilities = {
    available: true,
    registration: "native" as const,
    registrationUrl: null,
    passwordResetUrl: "https://accounts.example.com/forgot-password",
  };
  let submitted: unknown = null;
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: null, capabilities: inAppCapabilities },
    }),
  );
  await page.route("**/api/v1/auth/register", async (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      json: {
        ok: true,
        status: "verification_required",
        data: { email: "new-creator@example.com" },
        capabilities: inAppCapabilities,
      },
    });
  });

  await page.goto("/canvas");
  const dialog = await openAccount(page);
  await dialog.getByRole("tab", { name: "注册" }).click();
  await dialog.getByLabel("邮箱").fill("new-creator@example.com");
  await dialog.getByLabel("密码", { exact: true }).fill("private-password");
  await dialog.getByLabel("确认密码").fill("private-password");
  await dialog.getByRole("button", { name: "创建账号" }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("查收验证邮件");
  await expect(dialog.getByRole("tab", { name: "登录" })).toHaveAttribute("aria-selected", "true");
  expect(submitted).toEqual({ email: "new-creator@example.com", password: "private-password" });
});

test("外部账号登录失败会保留表单，成功后加载动态余额、商品和流水", async ({ page }) => {
  test.skip(RECHARGE_DISABLED, RECHARGE_SKIP_REASON);
  await preparePage(page);
  let activeSession: typeof session | null = null;
  let loginCalls = 0;
  const loginBodies: unknown[] = [];

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: activeSession, capabilities },
    }),
  );
  await page.route("**/api/v1/auth/login", async (route) => {
    loginCalls += 1;
    const body = route.request().postDataJSON();
    loginBodies.push(body);
    if (loginCalls === 1) {
      return route.fulfill({
        status: 401,
        json: { ok: false, error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确" } },
      });
    }
    activeSession = session;
    return route.fulfill({ json: { ok: true, data: session, capabilities } });
  });
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({
      json: { ok: true, data: walletSummary(128.5) },
    }),
  );
  await page.route("**/api/v1/wallet/products", (route) =>
    route.fulfill({
      json: { ok: true, data: products },
    }),
  );
  await page.route("**/api/v1/wallet/ledger?*", (route) =>
    route.fulfill({
      json: { ok: true, data: { items: [ledgerItem()] } },
    }),
  );

  await page.goto("/canvas");
  const dialog = await openAccount(page);
  await expect(dialog.getByRole("tab")).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: /注册账号/ })).toHaveAttribute(
    "href",
    capabilities.registrationUrl,
  );
  await expect(dialog.getByRole("link", { name: /找回密码/ })).toHaveAttribute(
    "href",
    capabilities.passwordResetUrl,
  );

  await dialog.getByLabel("邮箱").fill("creator@example.com");
  await dialog.getByLabel("密码").fill("wrong-password");
  await dialog.getByRole("button", { name: "进入画布", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(/邮箱或密码不正确/);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("邮箱")).toHaveValue("creator@example.com");

  await dialog.getByLabel("密码").fill("correct-password");
  await dialog.getByRole("button", { name: "进入画布", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(loginBodies).toEqual([
    { email: "creator@example.com", password: "wrong-password" },
    { email: "creator@example.com", password: "correct-password" },
  ]);

  await expect(page.getByRole("button", { name: "当前积分 128.5，点击刷新" })).toBeVisible();
  const walletDialog = await openWallet(page, "账号：创作者");
  await expect(walletDialog.getByRole("region", { name: "积分余额" })).toContainText("128.5");
  await expect(walletDialog.getByRole("region", { name: "积分余额" })).toContainText("每日积分");
  const productList = walletDialog.getByRole("listbox", { name: "充值商品" });
  await expect(productList.getByRole("option")).toHaveCount(4);
  await expect(productList).toContainText("80 积分");
  await expect(productList).toContainText("500 积分");
  await expect(productList).toContainText("专业会员");
  await expect(productList).toContainText("1 个额外协作者席位");
  await expect(walletDialog.getByRole("listitem")).toContainText("生成消费");
});

test("快速重复结账只创建一个订单，pending 转 paid 后刷新余额与流水", async ({ page }) => {
  test.skip(RECHARGE_DISABLED, RECHARGE_SKIP_REASON);
  await preparePage(page);
  let paid = false;
  let checkoutCalls = 0;
  let orderReads = 0;
  let checkoutBody: unknown = null;
  let releaseCheckout!: () => void;
  const checkoutGate = new Promise<void>((resolve) => {
    releaseCheckout = resolve;
  });
  const walletCalls = { summary: 0, products: 0, ledger: 0 };

  await mockAuthenticatedWallet(page, {
    walletCalls,
    summary: () => walletSummary(paid ? 628.5 : 128.5),
    ledger: () =>
      paid
        ? [
            ledgerItem({
              id: "ledger-payment",
              delta: 500,
              balanceAfter: 628.5,
              reason: "payment",
              reasonLabel: "支付到账",
              refId: "PAYE2E1001",
            }),
          ]
        : [ledgerItem()],
  });
  await page.route("**/api/v1/wallet/checkout", async (route) => {
    checkoutCalls += 1;
    checkoutBody = route.request().postDataJSON();
    await checkoutGate;
    return route.fulfill({
      json: {
        ok: true,
        data: { orderNo: "PAYE2E1001", checkoutUrl: "https://pay.example.com/PAYE2E1001" },
      },
    });
  });
  await page.route("**/api/v1/wallet/orders/PAYE2E1001", (route) => {
    orderReads += 1;
    paid = orderReads >= 2;
    return route.fulfill({
      json: {
        ok: true,
        data: {
          orderNo: "PAYE2E1001",
          status: paid ? "paid" : "pending",
          productKind: "credits",
          productId: "credits-500",
          amount: 49,
          paidAt: paid ? NOW : null,
          createdAt: NOW,
        },
      },
    });
  });

  await page.goto("/canvas");
  const dialog = await openWallet(page, "账号：创作者");
  const productList = dialog.getByRole("listbox", { name: "充值商品" });
  await productList.getByRole("option", { name: /500 积分/ }).click();
  const paymentMethods = dialog.getByRole("group", { name: "支付方式" });
  const wechatPay = paymentMethods.getByRole("button", { name: "微信支付" });
  const alipay = paymentMethods.getByRole("button", { name: "支付宝" });
  await expect(wechatPay).toHaveAttribute("aria-pressed", "true");
  await alipay.click();
  await expect(alipay).toHaveAttribute("aria-pressed", "true");
  await wechatPay.click();
  await expect(wechatPay).toHaveAttribute("aria-pressed", "true");
  const checkoutButton = dialog.getByRole("button", { name: "立即支付 ¥49" });

  await checkoutButton.click();
  await expect.poll(() => checkoutCalls).toBe(1);
  await expect(checkoutButton).toBeDisabled();
  await checkoutButton.click({ force: true });
  await page.waitForTimeout(100);
  expect(checkoutCalls).toBe(1);
  releaseCheckout();

  await expect(dialog).toContainText("PAYE2E1001");
  await expect(dialog).toContainText("等待支付");
  expect(checkoutBody).toEqual({ productId: "credits-500", paymentMethod: "wxpay" });
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY))
    .not.toBeNull();

  await dialog.getByRole("button", { name: "刷新状态" }).click();
  await expect(dialog).toContainText("支付成功");
  await expect(dialog.getByRole("region", { name: "积分余额" })).toContainText("628.5");
  await expect(dialog.getByRole("listitem")).toContainText("支付到账");
  await expect(page.getByText("支付成功，积分与权益已更新")).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY))
    .toBeNull();
  expect(walletCalls.summary).toBeGreaterThanOrEqual(2);
  expect(walletCalls.ledger).toBeGreaterThanOrEqual(2);
});

test("协作席位商品选择与支付到账使用独立权益提示", async ({ page }) => {
  test.skip(RECHARGE_DISABLED, RECHARGE_SKIP_REASON);
  await preparePage(page);
  let paid = false;
  let orderReads = 0;
  let checkoutBody: unknown = null;
  const walletCalls = { summary: 0, products: 0, ledger: 0 };
  await mockAuthenticatedWallet(page, { walletCalls });
  await page.route("**/api/v1/wallet/checkout", (route) => {
    checkoutBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        data: { orderNo: "PAYSEATE2E1", checkoutUrl: "https://pay.example.com/PAYSEATE2E1" },
      },
    });
  });
  await page.route("**/api/v1/wallet/orders/PAYSEATE2E1", (route) => {
    orderReads += 1;
    paid = orderReads >= 2;
    return route.fulfill({
      json: {
        ok: true,
        data: {
          orderNo: "PAYSEATE2E1",
          status: paid ? "paid" : "pending",
          productKind: "collaboration_seat",
          productId: "canvas-collaboration-seat-1",
          amount: 15,
          paidAt: paid ? NOW : null,
          createdAt: NOW,
        },
      },
    });
  });

  await page.goto("/canvas");
  const dialog = await openWallet(page, "账号：创作者");
  const seatProduct = dialog.getByRole("option", { name: /1 个额外协作者席位/ });
  await seatProduct.click();
  await expect(seatProduct).toHaveAttribute("aria-selected", "true");
  await expect(seatProduct).toContainText("支付确认后计入账号，可跨项目复用");

  await dialog.getByRole("button", { name: "立即支付 ¥15" }).click();
  await expect.poll(() => orderReads).toBeGreaterThanOrEqual(1);
  expect(checkoutBody).toEqual({
    productId: "canvas-collaboration-seat-1",
    paymentMethod: "wxpay",
  });
  await expect(dialog).toContainText("等待支付");

  await dialog.getByRole("button", { name: "刷新状态" }).click();
  await expect(dialog).toContainText("支付成功");
  await expect(dialog).toContainText("席位权益已到账");
  await expect(page.getByText("支付成功，协作席位已写入账号权益")).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY))
    .toBeNull();
  expect(walletCalls.summary).toBeGreaterThanOrEqual(2);
  expect(walletCalls.ledger).toBeGreaterThanOrEqual(2);
});

test("已退款席位订单不会被显示为支付成功或阻止重新购买", async ({ page }) => {
  test.skip(RECHARGE_DISABLED, RECHARGE_SKIP_REASON);
  const persistedOrder = {
    version: 1,
    userId: USER_ID,
    orderNo: "PAYSEATREFUND1",
    checkoutUrl: "https://pay.example.com/PAYSEATREFUND1",
    productId: "canvas-collaboration-seat-1",
    paymentMethod: "wxpay",
    createdAt: Date.now(),
  };
  await preparePage(page, persistedOrder);
  await mockAuthenticatedWallet(page);
  await page.route("**/api/v1/wallet/orders/PAYSEATREFUND1", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          orderNo: "PAYSEATREFUND1",
          status: "refunded",
          productKind: "collaboration_seat",
          productId: "canvas-collaboration-seat-1",
          amount: 15,
          paidAt: NOW,
          createdAt: NOW,
        },
      },
    }),
  );

  await page.goto("/canvas");
  const dialog = await openWallet(page, "账号：创作者");
  await expect(dialog).toContainText("已退款");
  await expect(dialog).toContainText("席位权益已撤销，可以重新购买");
  await expect(dialog).not.toContainText("席位权益已到账");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY))
    .toBeNull();
  await expect(dialog.getByRole("button", { name: "立即支付 ¥9.9" })).toBeEnabled();
});

test("自定义充值校验服务端金额规则，失败重试保留原金额", async ({ page }) => {
  test.skip(RECHARGE_DISABLED, RECHARGE_SKIP_REASON);
  await preparePage(page);
  await mockAuthenticatedWallet(page, { customTopUp: true });
  const checkoutBodies: unknown[] = [];

  await page.route("**/api/v1/wallet/checkout", (route) => {
    checkoutBodies.push(route.request().postDataJSON());
    const suffix = checkoutBodies.length;
    return route.fulfill({
      json: {
        ok: true,
        data: {
          orderNo: `PAYCUSTOM${suffix}`,
          checkoutUrl: `https://pay.example.com/PAYCUSTOM${suffix}`,
        },
      },
    });
  });
  await page.route("**/api/v1/wallet/orders/PAYCUSTOM*", (route) => {
    const orderNo = new URL(route.request().url()).pathname.split("/").at(-1) ?? "PAYCUSTOM1";
    return route.fulfill({
      json: {
        ok: true,
        data: {
          orderNo,
          status: "failed",
          productKind: "credits",
          productId: "points-custom",
          amount: 5.25,
          paidAt: null,
          createdAt: NOW,
        },
      },
    });
  });

  await page.goto("/canvas");
  const dialog = await openWallet(page, "账号：创作者");
  await dialog.getByRole("option", { name: /自定义充值/ }).click();
  const amountInput = dialog.getByLabel("自定义金额");
  await expect(amountInput).toHaveValue("5");

  await amountInput.fill("4.99");
  await expect(dialog.getByText("最低充值 ¥5")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "请填写有效金额" })).toBeDisabled();

  await amountInput.fill("5.25");
  await expect(dialog.getByText("525 积分")).toBeVisible();
  await dialog.getByRole("button", { name: "立即支付 ¥5.25" }).click();
  await expect.poll(() => checkoutBodies.length).toBe(1);
  await expect(dialog).toContainText("支付失败");

  const firstStored = await page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY);
  expect(JSON.parse(firstStored ?? "null")).toMatchObject({
    orderNo: "PAYCUSTOM1",
    productId: "points-custom",
    paymentMethod: "wxpay",
    customAmount: 5.25,
  });

  await dialog.getByRole("button", { name: "重新下单" }).click();
  await expect.poll(() => checkoutBodies.length).toBe(2);
  expect(checkoutBodies).toEqual([
    { productId: "points-custom", paymentMethod: "wxpay", customAmount: 5.25 },
    { productId: "points-custom", paymentMethod: "wxpay", customAmount: 5.25 },
  ]);

  await expect
    .poll(async () =>
      page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw).orderNo : null;
      }, ORDER_STORAGE_KEY),
    )
    .toBe("PAYCUSTOM2");
  const retriedStored = await page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY);
  expect(JSON.parse(retriedStored ?? "null")).toMatchObject({
    orderNo: "PAYCUSTOM2",
    customAmount: 5.25,
  });
});

test("刷新页面会恢复本人待处理订单，退出后清空钱包和订单", async ({ page }) => {
  test.skip(RECHARGE_DISABLED, RECHARGE_SKIP_REASON);
  const persistedOrder = {
    version: 1,
    userId: USER_ID,
    orderNo: "PAYRESTORE1",
    checkoutUrl: "https://pay.example.com/PAYRESTORE1",
    productId: "credits-80",
    paymentMethod: "alipay",
    createdAt: Date.now(),
  };
  await preparePage(page, persistedOrder);
  let orderReads = 0;
  let logoutCalls = 0;
  await mockAuthenticatedWallet(page);
  await page.route("**/api/v1/wallet/orders/PAYRESTORE1", (route) => {
    orderReads += 1;
    return route.fulfill({
      json: {
        ok: true,
        data: {
          orderNo: "PAYRESTORE1",
          status: "pending",
          productKind: "credits",
          productId: "credits-80",
          amount: 9.9,
          paidAt: null,
          createdAt: NOW,
        },
      },
    });
  });
  await page.route("**/api/v1/auth/logout", (route) => {
    logoutCalls += 1;
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/canvas");
  await expect.poll(() => orderReads).toBeGreaterThan(0);
  await page.reload();
  await expect.poll(() => orderReads).toBeGreaterThan(1);
  const dialog = await openWallet(page, "账号：创作者");
  await expect(dialog).toContainText("待处理订单");
  await expect(dialog).toContainText("PAYRESTORE1");
  await expect(dialog).toContainText("等待支付");

  const restored = await page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY);
  expect(JSON.parse(restored ?? "null")).toMatchObject({
    orderNo: "PAYRESTORE1",
    userId: USER_ID,
    productId: "credits-80",
  });

  await dialog.getByRole("button", { name: "退出", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "登录画布账号" })).toBeVisible();
  await expect(page.getByRole("button", { name: /当前积分/ })).toHaveCount(0);
  expect(logoutCalls).toBe(1);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY))
    .toBeNull();

  const loginDialog = await openAccount(page);
  await expect(loginDialog).not.toContainText("PAYRESTORE1");
  await expect(loginDialog).not.toContainText("128.5");
});

test("待处理订单停止自动轮询后可以明确停止跟踪并重新下单", async ({ page }) => {
  test.skip(RECHARGE_DISABLED, RECHARGE_SKIP_REASON);
  const persistedOrder = {
    version: 1,
    userId: USER_ID,
    orderNo: "PAYSTALE1",
    checkoutUrl: "https://pay.example.com/PAYSTALE1",
    productId: "credits-80",
    paymentMethod: "alipay",
    createdAt: Date.now() - 6 * 60_000,
  };
  await preparePage(page, persistedOrder);
  await mockAuthenticatedWallet(page);

  await page.goto("/canvas");
  const dialog = await openWallet(page, "账号：创作者");
  await expect(dialog).toContainText("仍待确认，可手动刷新");
  await expect(dialog.getByRole("button", { name: "请先处理待支付订单" })).toBeDisabled();

  await dialog.getByRole("button", { name: "停止跟踪" }).click();
  const confirmation = page.locator(".wc-confirm-backdrop");
  await expect(confirmation).toBeVisible();
  await confirmation.locator("button.is-confirm").click();

  await expect(dialog).not.toContainText("PAYSTALE1");
  await expect(dialog.getByRole("button", { name: "立即支付 ¥9.9" })).toBeEnabled();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), ORDER_STORAGE_KEY))
    .toBeNull();
});

test("激活码失败会展示服务错误，成功后立即更新余额与流水", async ({ page }) => {
  await preparePage(page);
  let redeemed = false;
  const redeemBodies: unknown[] = [];
  await mockAuthenticatedWallet(page, {
    summary: () => walletSummary(redeemed ? 225 : 25),
    ledger: () =>
      redeemed
        ? [
            ledgerItem({
              id: "ledger-redeem",
              delta: 200,
              balanceAfter: 225,
              reason: "activation_code",
              reasonLabel: "激活码到账",
              refId: "GIFT2026",
            }),
          ]
        : [],
  });
  await page.route("**/api/v1/wallet/redeem", async (route) => {
    const body = route.request().postDataJSON();
    redeemBodies.push(body);
    if (body.code === "INVALID-CODE") {
      return route.fulfill({
        status: 400,
        json: {
          ok: false,
          error: { code: "INVALID_ACTIVATION_CODE", message: "激活码无效或已被使用" },
        },
      });
    }
    redeemed = true;
    return route.fulfill({
      json: {
        ok: true,
        data: { message: "已到账 200 积分", summary: walletSummary(225) },
      },
    });
  });

  await page.goto("/canvas");
  const dialog = await openWallet(page, "账号：创作者");
  const codeInput = dialog.getByRole("textbox", { name: "激活码" });
  await codeInput.fill("invalid-code");
  await dialog.getByRole("button", { name: "兑换", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("激活码无效或已被使用");
  await expect(codeInput).toHaveValue("INVALID-CODE");

  await codeInput.fill("gift2026");
  await dialog.getByRole("button", { name: "兑换", exact: true }).click();
  await expect(page.getByText("已到账 200 积分")).toBeVisible();
  await expect(codeInput).toHaveValue("");
  await expect(dialog.getByRole("region", { name: "积分余额" })).toContainText("225");
  await expect(dialog.getByRole("listitem")).toContainText("激活码到账");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(redeemBodies).toEqual([
    { code: "INVALID-CODE", creditGrantMode: "bundle" },
    { code: "GIFT2026", creditGrantMode: "bundle" },
  ]);
});

test("钱包会话失效时重新打开登录，而不是继续显示旧积分", async ({ page }) => {
  await preparePage(page);
  let walletReads = 0;
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: session, capabilities },
    }),
  );
  await page.route("**/api/v1/wallet", (route) => {
    walletReads += 1;
    if (walletReads === 1) return route.fulfill({ json: { ok: true, data: walletSummary(128.5) } });
    return route.fulfill({
      status: 401,
      json: { ok: false, error: { code: "UNAUTHENTICATED", message: "登录已过期，请重新登录" } },
    });
  });
  await page.route("**/api/v1/wallet/products", (route) =>
    route.fulfill({ json: { ok: true, data: products } }),
  );
  await page.route("**/api/v1/wallet/ledger?*", (route) =>
    route.fulfill({ json: { ok: true, data: { items: [] } } }),
  );

  await page.goto("/canvas");
  const balanceButton = page.getByRole("button", { name: /当前积分 128\.5/ });
  await expect(balanceButton).toBeVisible();
  await balanceButton.click();

  const dialog = page.getByRole("dialog", { name: "纬线账号" });
  await expect(dialog.getByLabel("邮箱")).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("登录已过期");
  await expect(page.getByRole("button", { name: /当前积分/ })).toHaveCount(0);
});

/**
 * 内测期的替代面板：商品、自定义金额、支付方式与收银台整段换成一句告知，但余额与
 * 流水照旧可见（用户 2026-10-15：「把画布内充值面板隐藏，替换成"该项目仅供内部人员
 * 测试，如需使用请联系 bz4jx3jp2li1"」）。
 */
test("内测期充值面板换成内部测试告知", async ({ page }) => {
  test.skip(!RECHARGE_DISABLED, "公开/自托管构建照旧显示充值面板");
  await preparePage(page);
  await mockAuthenticatedWallet(page);
  await page.goto("/canvas");
  const dialog = await openWallet(page, "账号：创作者");

  await expect(dialog.getByRole("note")).toContainText("该项目仅供内部人员测试");
  await expect(dialog.getByRole("note")).toContainText("bz4jx3jp2li1");
  // 商品、结账、自定义金额一个都不留。
  await expect(dialog.getByRole("listbox", { name: "充值商品" })).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: /自定义充值/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /立即支付/ })).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "支付方式" })).toHaveCount(0);
  // 余额与流水仍在：关掉的是购买，不是账户面板。
  await expect(dialog.getByText("充值与权益")).toBeVisible();
});
