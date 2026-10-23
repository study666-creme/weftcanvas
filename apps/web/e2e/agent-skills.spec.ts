import { expect, test, type Page } from "@playwright/test";

/**
 * Agent 技能面：抽屉里的技能面板（清单 / 启用上限 / 导入）、执行权限档与对话导出。
 * API 不在 e2e 环境运行，agent 相关接口的每一条路径都在这里如实应答
 * （与 agent.spec.ts 同一套 mock 口径）。
 */
const conversation = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "project-placeholder",
  title: "新对话",
  createdAt: "2026-10-16T12:00:00.000Z",
  updatedAt: "2026-10-16T12:00:00.000Z",
};

const openingMessages = [
  {
    schemaVersion: 1,
    id: "44444444-4444-4444-8444-444444444444",
    conversationId: conversation.id,
    role: "user",
    content: "帮我看看这组节点。",
    createdAt: "2026-10-16T12:00:00.000Z",
  },
  {
    schemaVersion: 1,
    id: "55555555-5555-4555-8555-555555555555",
    conversationId: conversation.id,
    role: "assistant",
    content: "当前叙事已经有清楚的起点，可以先补一张环境镜头承接文本里的关键动作。",
    createdAt: "2026-10-16T12:00:01.000Z",
  },
] as const;

const agentModels = {
  defaultModelId: "gpt-5-mini",
  models: [
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-5-creative-preview-2026-07", label: "GPT-5 Creative Preview 2026-07" },
  ],
} as const;

const skillSummaries = [
  {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    name: "分镜拆解",
    description: "把一段文本拆成节拍与镜头，逐个落到画布节点。",
    size: 256,
    hash: "hash-a",
    createdAt: "2026-10-16T09:00:00.000Z",
    updatedAt: "2026-10-16T09:00:00.000Z",
  },
  {
    id: "aaaaaaaa-2222-4222-8222-222222222222",
    name: "提示词润色",
    description: "按画面主题收紧提示词，删掉互相冲突的修饰词。",
    size: 224,
    hash: "hash-b",
    createdAt: "2026-10-16T09:30:00.000Z",
    updatedAt: "2026-10-16T09:30:00.000Z",
  },
] as const;

const session = {
  user: {
    id: "99999999-9999-4999-8999-999999999999",
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: "2026-07-16T12:00:00.000Z",
  },
  expiresAt: "2026-08-16T12:00:00.000Z",
} as const;

async function mockAuthenticatedBackgroundRequests(page: Page) {
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
  await page.route("**/api/v1/membership/tasks/canvas-create-node", (route) =>
    route.fulfill({
      json: { ok: true, data: { message: "node task recorded", granted: false } },
    }),
  );
}

test("抽屉里启用技能、切换执行权限并导出对话", async ({ page }, testInfo) => {
  let projectId = "";
  let importedSkill: Record<string, unknown> | null = null;
  await page.addInitScript(() => {
    // addInitScript 在每次导航（含 reload）都会执行：只在第一次清空 localStorage，
    // 否则刷新后权限/技能选择会被一并抹掉。
    if (sessionStorage.getItem("wc-agent-skills-test-initialized")) return;
    localStorage.clear();
    sessionStorage.setItem("wc-agent-skills-test-initialized", "true");
  });
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: session } }),
  );
  await mockAuthenticatedBackgroundRequests(page);
  await page.route("**/api/v1/agent/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: agentModels } });
    }
    if (method === "GET" && url.pathname === "/api/v1/agent/skills") {
      const skills = importedSkill ? [importedSkill, ...skillSummaries] : [...skillSummaries];
      return route.fulfill({ json: { ok: true, data: skills } });
    }
    if (method === "POST" && url.pathname === "/api/v1/agent/skills") {
      const body = route.request().postDataJSON() as { content?: string };
      importedSkill = {
        id: "aaaaaaaa-3333-4333-8333-333333333333",
        name: "镜头节奏",
        description: "先列节拍再补镜头。",
        size: body.content?.length ?? 0,
        hash: "hash-c",
        createdAt: "2026-10-16T10:00:00.000Z",
        updatedAt: "2026-10-16T10:00:00.000Z",
      };
      return route.fulfill({ status: 201, json: { ok: true, data: importedSkill } });
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/v1/agent/skills/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/v1/agent/skills/", ""));
      importedSkill = importedSkill && importedSkill.id === id ? null : importedSkill;
      return route.fulfill({ json: { ok: true, data: { id, deleted: true } } });
    }
    if (method === "GET" && url.pathname === "/api/v1/agent/conversations") {
      projectId = url.searchParams.get("projectId") ?? "";
      return route.fulfill({ json: { ok: true, data: [{ ...conversation, projectId }] } });
    }
    if (method === "GET" && url.pathname === `/api/v1/agent/conversations/${conversation.id}`) {
      return route.fulfill({
        json: {
          ok: true,
          data: {
            conversation: { ...conversation, projectId },
            messages: openingMessages,
            latestRun: null,
          },
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { ok: false, error: { code: "NOT_FOUND", message: "not found" } },
    });
  });

  await page.goto("/canvas");
  await page.getByLabel("打开画布 Agent").click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  await expect(drawer).toBeVisible();

  // 技能 / 权限收在「对话设置」弹层里：先展开设置面板
  await drawer.getByRole("button", { name: "对话设置" }).click();
  await expect(drawer.getByRole("dialog", { name: "对话设置" })).toBeVisible();

  // 技能触发键 → 面板列出两个技能
  const trigger = drawer.getByRole("button", { name: "Agent 技能" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Agent 技能" });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("分镜拆解");
  await expect(menu).toContainText("提示词润色");
  await expect(menu.getByRole("checkbox")).toHaveCount(2);

  // 启用一个 → 触发键出现计数，本地清单留下该 id
  await menu.getByRole("checkbox").first().check();
  await expect(trigger).toContainText("技能 1");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("weftcanvas:agent-skills:v1")))
    .toContain("aaaaaaaa-1111-4111-8111-111111111111");
  await page.screenshot({ path: testInfo.outputPath("agent-skills-dark.png") });

  // 导入对话框：粘贴 → 解析预览 → 导入后清单刷新
  await menu.getByRole("button", { name: "导入技能" }).click();
  const dialog = page.getByRole("dialog", { name: "导入技能" });
  await expect(dialog).toBeVisible();
  const importButton = dialog.getByRole("button", { name: "导入" });
  await expect(importButton).toBeDisabled();
  await dialog.getByLabel("技能内容").fill("# 镜头节奏\n\n先列节拍再补镜头。");
  await expect(dialog.locator(".wc-agent-skills-preview")).toContainText("镜头节奏");
  await expect(dialog.locator(".wc-agent-skills-preview")).toContainText("先列节拍再补镜头。");
  await importButton.click();
  await expect(dialog).toBeHidden();
  await expect(menu).toContainText("镜头节奏");

  // Escape 只收起技能面板，抽屉保持打开
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(drawer).toBeVisible();

  // 执行权限档：三档可选，切到自动执行后写进 localStorage
  const permissionSelect = drawer.getByLabel("执行权限", { exact: true });
  await expect(permissionSelect.locator(".wc-canvas-select-label")).toHaveText("请求审批");
  await permissionSelect.click();
  const permissionList = page.getByRole("listbox", { name: "执行权限" });
  await expect(permissionList.getByRole("option")).toHaveCount(3);
  await expect(permissionList.getByRole("option", { name: "只读" })).toBeVisible();
  await expect(permissionList.getByRole("option", { name: "请求审批" })).toBeVisible();
  await expect(permissionList.getByRole("option", { name: "自动执行" })).toBeVisible();
  await permissionList.getByRole("option", { name: "自动执行" }).click();
  await expect(permissionSelect.locator(".wc-canvas-select-label")).toHaveText("自动执行");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("weftcanvas:agent-permission:v1")))
    .toBe("auto");

  // 头部导出按钮：下载文件名符合 agent-conversation-<id>-<timestamp>.json
  const downloadPromise = page.waitForEvent("download");
  await drawer.getByLabel("导出当前对话").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^agent-conversation-[0-9a-f-]+-\d{4}-\d{2}-\d{2}T[\d.-]+Z\.json$/,
  );

  // 消息工具条上的「创建节点」：与阅读浮层走同一条建节点路径
  const readNodeCount = () =>
    page.evaluate(() => {
      const projectId = localStorage.getItem("weftcanvas:active-project:v1");
      const raw = projectId
        ? localStorage.getItem(`weftcanvas:project-data:v1:${encodeURIComponent(projectId)}`)
        : null;
      return raw ? ((JSON.parse(raw) as { nodes?: unknown[] }).nodes?.length ?? 0) : 0;
    });
  const nodesBefore = await readNodeCount();
  await drawer.getByRole("button", { name: "创建节点", exact: false }).last().click();
  await expect(page.getByText("已创建文本节点")).toBeVisible();
  await expect.poll(readNodeCount).toBe(nodesBefore + 1);

  // 刷新后：权限档与技能启用都保留
  await page.reload();
  await page.getByLabel("打开画布 Agent").click();
  const reloadedDrawer = page.getByRole("dialog", { name: "画布 Agent" });
  await reloadedDrawer.getByRole("button", { name: "对话设置" }).click();
  await expect(
    reloadedDrawer.getByLabel("执行权限", { exact: true }).locator(".wc-canvas-select-label"),
  ).toHaveText("自动执行");
  await expect(reloadedDrawer.getByRole("button", { name: "Agent 技能" })).toContainText("技能 1");

  // 石墨（light）配色下面板仍然可读：文字与底色必须拉开
  await reloadedDrawer.locator(".wc-agent-header-button").last().click();
  await expect(reloadedDrawer).toBeHidden();
  await page.getByLabel("切换主题").click();
  await expect(page.locator(".wc-app")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("打开画布 Agent").click();
  const lightDrawer = page.getByRole("dialog", { name: "画布 Agent" });
  await expect(lightDrawer).toBeVisible();
  await lightDrawer.getByRole("button", { name: "对话设置" }).click();
  await lightDrawer.getByRole("button", { name: "Agent 技能" }).click();
  const lightMenu = page.getByRole("menu", { name: "Agent 技能" });
  await expect(lightMenu).toBeVisible();
  const lightColors = await lightMenu.evaluate((element) => {
    const menuStyle = getComputedStyle(element);
    const row = element.querySelector<HTMLElement>(".wc-agent-skills-row-copy strong");
    const hint = element.querySelector<HTMLElement>(".wc-agent-skills-hint");
    return {
      menuBackground: menuStyle.backgroundColor,
      menuText: menuStyle.color,
      rowText: row ? getComputedStyle(row).color : "",
      hintText: hint ? getComputedStyle(hint).color : "",
    };
  });
  expect(lightColors.menuText).not.toBe(lightColors.menuBackground);
  expect(lightColors.rowText).not.toBe(lightColors.menuBackground);
  expect(lightColors.hintText).not.toBe(lightColors.menuBackground);
  await page.screenshot({ path: testInfo.outputPath("agent-skills-light.png") });

  // 窄屏：新增的权限档 + 技能键不把抽屉撑出横向滚动，也都还在抽屉内
  await page.keyboard.press("Escape");
  await expect(lightMenu).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const box = await lightDrawer.boundingBox();
      return box ? Math.round(box.x + box.width) : -1;
    })
    .toBeLessThanOrEqual(383);
  await expect(lightDrawer.getByLabel("执行权限", { exact: true })).toBeVisible();
  const narrowTriggerBox = await lightDrawer
    .getByRole("button", { name: "Agent 技能" })
    .boundingBox();
  const narrowDrawerBox = await lightDrawer.boundingBox();
  expect(narrowTriggerBox).not.toBeNull();
  expect(narrowDrawerBox).not.toBeNull();
  expect(narrowTriggerBox!.x + narrowTriggerBox!.width).toBeLessThanOrEqual(
    narrowDrawerBox!.x + narrowDrawerBox!.width,
  );
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.width);
});
