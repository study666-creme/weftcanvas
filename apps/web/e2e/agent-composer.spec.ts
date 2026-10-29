import { expect, test, type Page } from "@playwright/test";

import { seedStarterCanvas } from "./starter-canvas.fixture";

// Agent 抽屉 composer 的回归守卫：长文本必须留在文本域框内（超出封顶滚动），
// 不得把文本域顶出 composer、也不得叠到底栏上。field-sizing: content 的轨道
// 尺寸缺陷曾让行内高度与 grid 行高脱节，这里按几何断言守住。
const conversation = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "project-placeholder",
  title: "新对话",
  createdAt: "2026-07-16T12:00:00.000Z",
  updatedAt: "2026-07-16T12:00:00.000Z",
};

const agentModels = {
  defaultModelId: "gpt-5-mini",
  models: [{ id: "gpt-5-mini", label: "GPT-5 Mini" }],
} as const;

async function mockBackground(page: Page) {
  await page.route("**/api/v1/generation-jobs?*", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
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
  await page.route("**/api/v1/membership/tasks", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          items: [],
          lifetimeCreditsSpent: 0,
          nextSpendMilestone: null,
          hub: {
            phoneVerified: false,
            signStreak: 0,
            checkedInToday: false,
            daysToStreakBonus: 0,
            dailyBonus: { key: "daily_bonus_test", claimed: false, ready: false },
            memberDaily: null,
          },
          phoneVerified: false,
        },
      },
    }),
  );
  await page.route("**/api/v1/cloud-projects", (route) =>
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
              tier: "free",
              cloudProjectLimit: 0,
              projectStorageBytes: 0,
              mediaStorageBytes: 0,
              revisionRetentionCount: 0,
              multiDeviceSync: false,
            },
          },
        },
      },
    }),
  );
}

async function openAgentDrawer(page: Page) {
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          user: {
            id: "99999999-9999-4999-8999-999999999999",
            email: "creator@example.com",
            displayName: "创作者",
            createdAt: "2026-07-16T12:00:00.000Z",
          },
          expiresAt: "2026-08-16T12:00:00.000Z",
        },
      },
    }),
  );
  await mockBackground(page);
  await page.route("**/api/v1/agent/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: agentModels } });
    }
    if (method === "GET" && url.pathname === "/api/v1/agent/conversations") {
      return route.fulfill({ json: { ok: true, data: [{ ...conversation }] } });
    }
    if (method === "GET" && url.pathname === `/api/v1/agent/conversations/${conversation.id}`) {
      return route.fulfill({
        json: { ok: true, data: { conversation, messages: [], latestRun: null } },
      });
    }
    return route.fulfill({
      status: 404,
      json: { ok: false, error: { code: "NOT_FOUND", message: "not found" } },
    });
  });

  await seedStarterCanvas(page);
  await page.goto("/canvas");
  const companion = page.getByLabel("打开画布 Agent");
  await expect(companion).toBeVisible();
  await companion.click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  await expect(drawer).toBeVisible();
  const textarea = drawer.getByRole("textbox", { name: "发送给 Agent" });
  await expect(textarea).toBeVisible();
  return { drawer, textarea };
}

async function readComposerMetrics(page: Page) {
  return page.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>(".wc-agent-composer textarea");
    const composer = document.querySelector<HTMLElement>(".wc-agent-composer");
    const footer = document.querySelector<HTMLElement>(".wc-agent-composer-footer");
    if (!field || !composer || !footer) return null;
    const fieldBox = field.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    return {
      clientHeight: field.clientHeight,
      scrollHeight: field.scrollHeight,
      fieldTop: fieldBox.top,
      fieldBottom: fieldBox.bottom,
      composerTop: composerBox.top,
      composerBottom: composerBox.bottom,
      footerTop: footerBox.top,
    };
  });
}

test("composer keeps long text inside the field and above the footer", async ({ page }) => {
  const { textarea } = await openAgentDrawer(page);
  const longText =
    "你作为一个提示词的一个设计专家，帮我设计一些专门用于让 AI 成为专注自己任务的角色执行者。" +
    "比如说我现在第一个任务，就是想让你帮我想一个提示词，让 AI 去帮我执行。" +
    "去帮我想角色，创建角色，想角色创意设定这些东西。" +
    "一个角色，他在故事里面最重要的是什么呢？它首先得有自己的作用才行，" +
    "它在故事里面一定要起到一些作用的东西，然后就是它的形象要有设计感，不能太普通平庸，这样子。" +
    "他身上的东西有来历，之后又有故事可以继续发展，有剧情。" +
    "他身上的东西要有来历，之后又有故事可以继续发展，有剧情，人物弧光要完整，" +
    "角色的动机要能推动情节，配角也要有自己的诉求，这样整个故事才立得住。" +
    "最后再帮我检查一遍这套提示词在别的模型上是否也能稳定生效，谢谢。";
  await textarea.fill(longText);
  await textarea.blur();

  const metrics = await readComposerMetrics(page);
  expect(metrics).not.toBeNull();
  // 文本域整体都在 composer 框内，底栏不叠在文本上；内容超过封顶时按滚动收敛。
  expect(metrics!.fieldTop).toBeGreaterThanOrEqual(metrics!.composerTop - 0.5);
  expect(metrics!.footerTop).toBeGreaterThanOrEqual(metrics!.fieldBottom - 0.5);
  expect(metrics!.clientHeight).toBeLessThanOrEqual(168.5);
  expect(metrics!.scrollHeight).toBeGreaterThan(metrics!.clientHeight);
});

test("composer collapses to the resting height when cleared", async ({ page }) => {
  const { textarea } = await openAgentDrawer(page);
  await textarea.fill("一句话");
  await textarea.fill("");

  const metrics = await readComposerMetrics(page);
  expect(metrics).not.toBeNull();
  // 清空后回到静息高度（rows=3 的回退档），不残留长文本撑出来的高度。
  expect(metrics!.clientHeight).toBeLessThanOrEqual(80);
  expect(metrics!.scrollHeight).toBeLessThanOrEqual(metrics!.clientHeight + 1);
});
