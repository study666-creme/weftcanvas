import type { Page } from "@playwright/test";

const emptyCloudProjects = {
  projects: [],
  sharedProjects: [],
  usage: {
    projectCount: 0,
    projectStorageBytes: 0,
    mediaStorageBytes: 0,
    entitlements: {
      tier: "free",
      cloudProjectLimit: 3,
      projectStorageBytes: 10 * 1024 * 1024,
      mediaStorageBytes: 300 * 1024 * 1024,
      revisionRetentionCount: 3,
      multiDeviceSync: true,
    },
  },
};

const emptyMembershipTasks = {
  items: [],
  lifetimeCreditsSpent: 0,
  nextSpendMilestone: null,
  hub: {
    phoneVerified: false,
    signStreak: 0,
    checkedInToday: false,
    daysToStreakBonus: 7,
    dailyBonus: {
      key: "daily_bonus_2099-01-01",
      claimed: false,
      ready: false,
    },
    memberDaily: null,
  },
  phoneVerified: false,
};

// Authenticated pages eagerly refresh these account-scoped endpoints. Keep
// production smoke tests isolated from the real account and task services.
export async function mockAuthenticatedBackgroundApis(page: Page) {
  await page.route(/\/api\/v1\/cloud-projects(?:\?.*)?$/, (route) => route.fulfill({
    json: { ok: true, data: emptyCloudProjects },
  }));
  await page.route(/\/api\/v1\/membership\/tasks(?:\?.*)?$/, (route) => route.fulfill({
    json: { ok: true, data: emptyMembershipTasks },
  }));
  await page.route(/\/api\/v1\/membership\/tasks\/canvas-create-node(?:\?.*)?$/, (route) => route.fulfill({
    json: { ok: true, data: { message: "Node task recorded by the fixture", granted: false } },
  }));
}
