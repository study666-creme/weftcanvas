import { expect, test, type Page } from "@playwright/test";

import { addCanvasNode, mockAuthenticatedSession } from "./canvas-ui.fixture";
import { seedStarterCanvas } from "./starter-canvas.fixture";

const conversation = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "project-placeholder",
  title: "新对话",
  createdAt: "2026-07-16T12:00:00.000Z",
  updatedAt: "2026-07-16T12:00:00.000Z",
};

const openingMessages = [
  {
    schemaVersion: 1,
    id: "44444444-4444-4444-8444-444444444444",
    conversationId: conversation.id,
    role: "user",
    content: "帮我看看这组节点。",
    createdAt: "2026-07-16T12:00:00.000Z",
  },
  {
    schemaVersion: 1,
    id: "55555555-5555-4555-8555-555555555555",
    conversationId: conversation.id,
    role: "assistant",
    content: "当前叙事已经有清楚的起点，但图片节点还没有承接文本里的关键动作。可以先补一张环境镜头，再把人物动作拆成相邻节点，这样节奏会更顺。",
    createdAt: "2026-07-16T12:00:01.000Z",
  },
] as const;

const agentModels = {
  defaultModelId: "gpt-5-mini",
  models: [
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-5-creative-preview-2026-07", label: "GPT-5 Creative Preview 2026-07" },
  ],
} as const;

async function mockAuthenticatedBackgroundRequests(page: Page) {
  await page.route("**/api/v1/generation-jobs?*", (route) => route.fulfill({
    json: { ok: true, data: [] },
  }));
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
  await page.route("**/api/v1/membership/tasks", (route) => route.fulfill({
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
  }));
  await page.route("**/api/v1/membership/tasks/canvas-create-node", (route) => route.fulfill({
    json: {
      ok: true,
      data: { message: "node task recorded", granted: false },
    },
  }));
  await page.route("**/api/v1/cloud-projects", (route) => route.fulfill({
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
  }));
}

test("top Agent companion reacts and opens a bounded non-modal side workspace", async ({ page }, testInfo) => {
  test.slow();
  let projectId = "";
  let submitted: Record<string, unknown> | null = null;
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
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
  }));
  await mockAuthenticatedBackgroundRequests(page);
  await page.route("**/api/v1/agent/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: agentModels } });
    }
    if (method === "GET" && url.pathname === "/api/v1/agent/conversations") {
      projectId = url.searchParams.get("projectId") ?? "";
      return route.fulfill({ json: { ok: true, data: [{ ...conversation, projectId }] } });
    }
    if (method === "GET" && url.pathname === `/api/v1/agent/conversations/${conversation.id}`) {
      return route.fulfill({ json: { ok: true, data: { conversation: { ...conversation, projectId }, messages: openingMessages, latestRun: null } } });
    }
    if (method === "POST" && url.pathname.endsWith("/messages")) {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 202,
        json: {
          ok: true,
          data: {
            conversation: { ...conversation, projectId, title: "检查这一场", updatedAt: "2026-07-16T12:00:01.000Z" },
            messages: [{
              schemaVersion: 1,
              id: "22222222-2222-4222-8222-222222222222",
              conversationId: conversation.id,
              role: "user",
              content: "检查这一场",
              createdAt: "2026-07-16T12:00:01.000Z",
            }],
            latestRun: {
              schemaVersion: 1,
              id: "33333333-3333-4333-8333-333333333333",
              conversationId: conversation.id,
              userMessageId: "22222222-2222-4222-8222-222222222222",
              assistantMessageId: null,
              status: "failed",
              error: { code: "AGENT_UNAVAILABLE", message: "Agent 服务暂未配置", retryable: true },
              createdAt: "2026-07-16T12:00:01.000Z",
              startedAt: null,
              completedAt: "2026-07-16T12:00:02.000Z",
            },
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "not found" } } });
  });

  // The app stopped auto-creating the classic three-node starter canvas, so the
  // companion's context assertions (4 nodes / 2 edges) seed it explicitly.
  await seedStarterCanvas(page);
  await page.goto("/canvas");
  const dock = page.getByRole("navigation", { name: "编辑工具" });
  const companion = page.getByLabel("打开画布 Agent");
  await expect(companion).toBeVisible();
  const companionBox = await companion.boundingBox();
  expect(companionBox).not.toBeNull();
  expect(Math.abs((companionBox!.x + companionBox!.width / 2) - 720)).toBeLessThan(1.5);

  await addCanvasNode(page, "添加文本节点");
  await expect(companion).toHaveAttribute("data-reaction", "celebrate");
  await page.locator(".react-flow__pane").click({ position: { x: 150, y: 780 } });

  await dock.getByLabel("打开资源库").click();
  await expect(page.getByRole("dialog", { name: "资源库" })).toBeVisible();

  const readFlowCenter = () => page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".kc-flow-shell")!;
    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport")!;
    const bounds = shell.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    return {
      x: (bounds.width / 2 - matrix.m41) / matrix.a,
      y: (bounds.height / 2 - matrix.m42) / matrix.d,
    };
  });
  const centerBeforeAgent = await readFlowCenter();
  const flowBeforeAgent = await page.locator(".kc-flow-shell").boundingBox();
  expect(flowBeforeAgent).not.toBeNull();
  await companion.click();
  await expect(page.getByRole("dialog", { name: "资源库" })).toBeHidden();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  await expect(drawer).toBeVisible();
  await expect(page.locator(".kc-topbar")).toHaveCount(0);
  const creativeModeSelect = drawer.getByLabel("创作协作模式", { exact: true });
  await expect(creativeModeSelect.locator(".kc-canvas-select-label")).toHaveText("自由协作");
  await creativeModeSelect.click();
  const creativeModeList = page.getByRole("listbox", { name: "创作协作模式" });
  await expect(creativeModeList.getByRole("option")).toHaveCount(2);
  await expect(creativeModeList.getByRole("option", { name: "先定基线" })).toHaveCount(0);
  await creativeModeList.getByRole("option", { name: "专业辅助" }).click();
  await expect(creativeModeSelect.locator(".kc-canvas-select-label")).toHaveText("专业辅助");
  const baselineQuestion = drawer.locator(".kc-agent-baseline-question");
  await expect(baselineQuestion).toBeVisible();
  await expect(baselineQuestion).toContainText("画面比例 · 1/3");
  await expect(baselineQuestion.getByRole("group", { name: "画面比例预设" }).getByRole("button")).toHaveCount(4);
  await expect(drawer.getByRole("textbox", { name: "发送给 Agent" })).toHaveAttribute("placeholder", "输入自定义比例");
  await baselineQuestion.getByRole("button", { name: "16:9", exact: true }).click();
  await expect(baselineQuestion).toContainText("画风 · 2/3");
  await baselineQuestion.getByRole("button", { name: "电影写实", exact: true }).click();
  await expect(baselineQuestion).toContainText("目标时长 · 3/3");
  await page.screenshot({ path: testInfo.outputPath("agent-creative-guidance-dark.png") });
  await baselineQuestion.getByRole("button", { name: "60 秒", exact: true }).click();
  await expect(baselineQuestion).toHaveCount(0);
  await expect(drawer.getByLabel("Agent 对话", { exact: true }).locator("..")).toHaveAttribute("data-value", conversation.id);
  const modelSelect = drawer.getByLabel("Agent 模型", { exact: true });
  const modelControl = modelSelect.locator("..");
  await expect(modelSelect).toBeVisible();
  await expect(modelControl).toHaveAttribute("data-value", "gpt-5-mini");
  await expect(modelSelect.locator(".kc-cat-select-value")).toHaveText("GPT-5 Mini");
  await modelSelect.click();
  await page.getByRole("listbox", { name: "Agent 模型" })
    .getByRole("option", { name: "GPT-5 Creative Preview 2026-07" })
    .click();
  await expect(modelControl).toHaveAttribute("data-value", "gpt-5-creative-preview-2026-07");
  await expect(modelSelect.locator(".kc-cat-select-value")).toHaveText("GPT-5 Creative Preview 2026-07");
  await modelSelect.click();
  const modelListbox = page.getByRole("listbox", { name: "Agent 模型" });
  await expect(modelListbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modelListbox).toBeHidden();
  await expect(drawer).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  const dockBox = await dock.boundingBox();
  const zoomBox = await page.locator(".kc-zoom-control").boundingBox();
  const agentMark = drawer.locator(".kc-agent-mark");
  const composer = drawer.locator(".kc-agent-composer");
  const composerBox = await composer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(zoomBox).not.toBeNull();
  // 贴边抽屉：右侧到底、上下到顶，不留悬浮边距。
  expect(drawerBox!.x + drawerBox!.width).toBeCloseTo(1_440, 0);
  expect(drawerBox!.x).toBeGreaterThan(900);
  expect(drawerBox!.y).toBeGreaterThanOrEqual(0);
  expect(drawerBox!.y).toBeLessThanOrEqual(1);
  expect(page.viewportSize()!.height - drawerBox!.y - drawerBox!.height).toBeGreaterThanOrEqual(0);
  expect(page.viewportSize()!.height - drawerBox!.y - drawerBox!.height).toBeLessThanOrEqual(1);
  expect(drawerBox!.x).toBeGreaterThan(dockBox!.x + dockBox!.width + 24);
  expect(drawerBox!.x).toBeGreaterThan(zoomBox!.x + zoomBox!.width + 24);
  expect(composerBox!.x).toBeGreaterThan(drawerBox!.x);
  expect(composerBox!.y + composerBox!.height).toBeLessThan(drawerBox!.y + drawerBox!.height);
  expect(composerBox!.height).toBeGreaterThanOrEqual(140);
  expect(composerBox!.height).toBeLessThanOrEqual(240);
  await expect(agentMark).toBeVisible();
  await expect(drawer.locator(".kc-agent-composer-context")).toHaveCount(0);
  const sendButtonBox = await drawer.getByRole("button", { name: "发送给 Agent" }).boundingBox();
  expect(sendButtonBox).not.toBeNull();
  expect(sendButtonBox!.width).toBeGreaterThanOrEqual(36);
  expect(sendButtonBox!.height).toBeGreaterThanOrEqual(36);
  const modelSelectStyles = await modelSelect.evaluate((element) => {
    const trigger = element as HTMLElement;
    const value = trigger.querySelector<HTMLElement>(".kc-cat-select-value")!;
    const triggerStyle = getComputedStyle(trigger);
    const triggerBox = trigger.getBoundingClientRect();
    const valueBox = value.getBoundingClientRect();
    return {
      triggerAlign: triggerStyle.alignItems,
      triggerHeight: Math.round(triggerBox.height),
      triggerWidth: Math.round(triggerBox.width),
      valueInside: valueBox.left >= triggerBox.left && valueBox.right <= triggerBox.right,
    };
  });
  expect(modelSelectStyles).toMatchObject({
    triggerAlign: "center",
    triggerHeight: 34,
    valueInside: true,
  });
  expect(modelSelectStyles.triggerWidth).toBeGreaterThan(160);
  await expect(drawer.getByLabel("Agent 回复")).toBeVisible();
  await expect.poll(async () => {
    const center = await readFlowCenter();
    return Math.max(Math.abs(center.x - centerBeforeAgent.x), Math.abs(center.y - centerBeforeAgent.y));
  }).toBeLessThan(1);
  const flowBox = await page.locator(".kc-flow-shell").boundingBox();
  expect(flowBox).not.toBeNull();
  expect(Math.abs(flowBox!.width - flowBeforeAgent!.width)).toBeLessThan(1);
  expect(Math.abs(flowBox!.height - flowBeforeAgent!.height)).toBeLessThan(1);

  const viewport = page.locator(".react-flow__viewport");
  const readViewport = () => viewport.evaluate((element) => getComputedStyle(element).transform);
  const beforeCanvasPan = await readViewport();
  await page.mouse.move(420, 700);
  await page.mouse.wheel(0, 180);
  await expect.poll(readViewport).not.toBe(beforeCanvasPan);
  await expect(drawer).toBeVisible();

  const messagesBox = await drawer.getByLabel("Agent 回复").boundingBox();
  expect(messagesBox).not.toBeNull();
  await page.evaluate(() => {
    (window as Window & { __kcAgentWheelPrevented?: boolean }).__kcAgentWheelPrevented = false;
    window.addEventListener("wheel", (event) => {
      window.setTimeout(() => {
        (window as Window & { __kcAgentWheelPrevented?: boolean }).__kcAgentWheelPrevented = event.defaultPrevented;
      });
    }, { capture: true, once: true });
  });
  await page.mouse.move(messagesBox!.x + messagesBox!.width / 2, messagesBox!.y + messagesBox!.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(() => page.evaluate(() => (window as Window & { __kcAgentWheelPrevented?: boolean }).__kcAgentWheelPrevented)).toBe(true);
  await page.mouse.move(80, 760);
  await page.screenshot({ path: testInfo.outputPath("agent-side-workspace-dark.png") });

  await page.setViewportSize({ width: 2_048, height: 1_080 });
  const wideDrawerBox = await drawer.boundingBox();
  expect(wideDrawerBox!.x + wideDrawerBox!.width).toBeCloseTo(2_048, 0);
  expect(wideDrawerBox!.width).toBeGreaterThanOrEqual(440);
  expect(wideDrawerBox!.width).toBeLessThanOrEqual(620);
  await page.mouse.move(90, 980);
  await page.screenshot({ path: testInfo.outputPath("agent-side-workspace-wide-dark.png") });
  await page.setViewportSize({ width: 1_440, height: 900 });

  await drawer.getByRole("textbox", { name: "发送给 Agent" }).fill("检查这一场");
  const readySend = drawer.getByRole("button", { name: "发送给 Agent" });
  await expect(readySend).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("agent-composer-ready-dark.png") });
  await readySend.click();
  await expect(drawer).toContainText("Agent 服务暂未配置");
  expect(submitted).not.toBeNull();
  expect(submitted!.modelId).toBe("gpt-5-creative-preview-2026-07");
  const context = submitted!.canvasContext as Record<string, unknown>;
  expect(context.projectId).toBe(projectId);
  expect(context.nodes).toHaveLength(4);
  expect(context.creativeGuidance).toMatchObject({
    mode: "professional",
    baseline: { aspectRatio: "16:9", visualStyle: "电影写实", targetDuration: "60 秒", locked: true },
  });
  expect(JSON.stringify(context)).not.toContain("serverId");
  expect(JSON.stringify(context)).not.toContain("data:");

  // Ambient edge energy is deliberately off (motion budget): the moving segment
  // only lights up on the edges attached to the selected node.
  const energy = page.locator(".react-flow__edge .kc-edge-energy");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(energy).toHaveCount(0);
  await page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])').locator(".kc-node-drag-strip").click();
  await expect(energy).toHaveCount(2);

  await drawer.locator(".kc-agent-header-button").last().click();
  await expect(drawer).toBeHidden();
  await expect(page.locator(".kc-topbar")).toBeVisible();
  await page.getByLabel("切换主题").click();
  await expect(page.locator(".kc-app")).toHaveAttribute("data-theme", "light");
  await companion.click();
  await expect(drawer).toBeVisible();
  await expect(page.locator(".kc-topbar")).toHaveCount(0);
  const colors = await drawer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(colors.color).not.toBe(colors.background);
  await expect(drawer.getByRole("button", { name: "发送给 Agent" })).toBeVisible();
  await page.setViewportSize({ width: 1_024, height: 700 });
  // The drawer slides in, so its box is only meaningful once the entrance
  // animation has settled; poll the geometry instead of sampling it once.
  await expect.poll(async () => {
    const box = await drawer.boundingBox();
    return box ? Math.round(box.x + box.width) : -1;
  }).toBe(1_024);
  const compactDrawerBox = await drawer.boundingBox();
  const compactComposerBox = await composer.boundingBox();
  const compactMarkBox = await agentMark.boundingBox();
  const compactDockBox = await dock.boundingBox();
  const compactZoomBox = await page.locator(".kc-zoom-control").boundingBox();
  expect(compactDrawerBox!.x).toBeGreaterThanOrEqual(580);
  expect(compactDrawerBox!.x + compactDrawerBox!.width).toBeCloseTo(1_024, 0);
  expect(compactDrawerBox!.width).toBeGreaterThanOrEqual(400);
  expect(compactDrawerBox!.width).toBeLessThanOrEqual(440);
  expect(compactComposerBox!.y + compactComposerBox!.height).toBeLessThan(compactDrawerBox!.y + compactDrawerBox!.height);
  expect(compactMarkBox!.x).toBeGreaterThanOrEqual(compactDrawerBox!.x);
  expect(compactMarkBox!.x + compactMarkBox!.width).toBeLessThanOrEqual(compactDrawerBox!.x + compactDrawerBox!.width);
  expect(rectanglesOverlap(compactDockBox!, compactZoomBox!)).toBe(false);
  await expect(drawer.getByRole("dialog", { name: "创作基线设置" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("agent-side-workspace-compact-light.png") });

  const textNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])').first();
  await textNode.locator(".kc-node-drag-strip").click();
  // Opening a node's prompt composer no longer dismisses the Agent panel; the
  // overlay now sits below it, so both stay on screen at compact width.
  const creationPanel = page.locator("[data-node-prompt-composer]");
  await expect(creationPanel).toBeVisible();
  await expect(drawer).toBeVisible();
  const creationPanelBox = await creationPanel.boundingBox();
  const compactCreateRailBox = await page.locator(".kc-create-rail").boundingBox();
  expect(creationPanelBox).not.toBeNull();
  expect(compactCreateRailBox).not.toBeNull();
  expect(creationPanelBox!.x).toBeGreaterThanOrEqual(compactCreateRailBox!.x + compactCreateRailBox!.width + 12);
  // 编辑浮层的层级现在低于 Agent 面板（面板不再被输入框盖住），因此这里只校验浮层留在视口内。
  expect(creationPanelBox!.x + creationPanelBox!.width).toBeLessThanOrEqual(1_024);
  expect(creationPanelBox!.y + creationPanelBox!.height).toBeLessThanOrEqual(compactDockBox!.y - 8);
  await page.screenshot({ path: testInfo.outputPath("agent-creator-compact-light.png") });
  await page.getByLabel("引用画布素材").click();
  await expect(page.getByRole("listbox", { name: "选择参考素材" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "选择参考素材" })).toBeHidden();
  // The node editor overlay sits above the canvas at compact widths, so it also
  // covers the create rail flyout. Clicking empty canvas clears the selection
  // and closes the editor before the rail is used.
  await page.locator(".react-flow__pane").click({ position: { x: 150, y: 620 } });
  await expect(creationPanel).toHaveCount(0);

  const readNodeIds = () => page.evaluate(() => {
    const projectId = localStorage.getItem("kachang-canvas:active-project:v1");
    const raw = projectId
      ? localStorage.getItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`)
      : null;
    const nodes = raw ? (JSON.parse(raw) as { nodes?: Array<{ id: string; data?: { kind?: string } }> }).nodes ?? [] : [];
    return { ids: nodes.map((node) => node.id), imageIds: nodes.filter((node) => node.data?.kind === "image").map((node) => node.id) };
  });
  const before = await readNodeIds();
  await addCanvasNode(page, "添加图片节点");
  // Creating a node recentres the viewport, so `onlyRenderVisibleElements` may
  // unmount an older node; assert creation from the persisted project instead of
  // from the rendered count, then locate the new node by its id.
  await expect.poll(async () => (await readNodeIds()).imageIds.length).toBe(before.imageIds.length + 1);
  const createdId = (await readNodeIds()).ids.find((id) => !before.ids.includes(id));
  expect(createdId).toBeTruthy();
  const insertedImage = page.locator(`.react-flow__node-kachang[data-id="${createdId}"]`);
  await expect(insertedImage).toBeVisible();
  const insertedBox = await insertedImage.boundingBox();
  const compactFlowBox = await page.locator(".kc-flow-shell").boundingBox();
  expect(insertedBox!.x).toBeGreaterThanOrEqual(compactFlowBox!.x);
  expect(insertedBox!.x + insertedBox!.width).toBeLessThanOrEqual(compactFlowBox!.x + compactFlowBox!.width);

  await expect(drawer).toBeVisible();
  await drawer.getByRole("textbox", { name: "发送给 Agent" }).focus();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.width);
  expect(dimensions.scrollHeight).toBe(dimensions.height);
});

function rectanglesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

test("Agent proposal stays readable beside the canvas and on mobile", async ({ page }, testInfo) => {
  const session = {
    user: {
      id: "99999999-9999-4999-8999-999999999999",
      email: "creator@example.com",
      displayName: "创作者",
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    expiresAt: "2026-08-16T12:00:00.000Z",
  };
  let projectId = "";

  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await mockAuthenticatedBackgroundRequests(page);
  await page.route("**/api/v1/agent/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: agentModels } });
    }
    if (url.pathname === "/api/v1/agent/conversations") {
      projectId = url.searchParams.get("projectId") ?? "";
      return route.fulfill({ json: { ok: true, data: [{ ...conversation, projectId, title: "镜头结构优化" }] } });
    }
    if (url.pathname === `/api/v1/agent/conversations/${conversation.id}`) {
      return route.fulfill({
        json: {
          ok: true,
          data: {
            conversation: { ...conversation, projectId, title: "镜头结构优化" },
            messages: openingMessages,
            latestRun: {
              schemaVersion: 1,
              id: "77777777-7777-4777-8777-777777777777",
              conversationId: conversation.id,
              userMessageId: openingMessages[0].id,
              assistantMessageId: openingMessages[1].id,
              modelId: "gpt-5-mini",
              status: "completed",
              actions: [{ type: "canvas_select_nodes", nodeIds: ["scene-opening"] }],
              executionMode: "proposal",
              proposal: {
                schemaVersion: 1,
                id: "66666666-6666-4666-8666-666666666666",
                title: "补齐环境镜头并收紧叙事节奏",
                reason: "当前图片节点还没有承接文本中的关键动作，先补环境镜头可以让后续人物动作更连贯。",
                successCriteria: ["环境镜头与开场文本相连", "人物动作拆分为相邻节点"],
              },
              proposalStatus: "pending",
              contextRevision: "proposal-visual-check",
              receipt: null,
              error: null,
              createdAt: "2026-07-16T12:00:02.000Z",
              startedAt: "2026-07-16T12:00:02.000Z",
              completedAt: "2026-07-16T12:00:03.000Z",
            },
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "not found" } } });
  });

  await page.goto("/canvas");
  await page.getByLabel("打开画布 Agent").click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  const proposal = drawer.getByRole("region", { name: "待确认的 Agent 提案" });
  await expect(proposal).toContainText("补齐环境镜头并收紧叙事节奏");
  await expect(proposal.getByRole("button", { name: "确认" })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "修改" })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "取消" })).toBeVisible();
  await proposal.scrollIntoViewIfNeeded();
  const drawerBox = await drawer.boundingBox();
  const proposalBox = await proposal.boundingBox();
  expect(proposalBox).not.toBeNull();
  expect(proposalBox!.x).toBeGreaterThan(drawerBox!.x);
  expect(proposalBox!.x + proposalBox!.width).toBeLessThan(drawerBox!.x + drawerBox!.width);
  await page.screenshot({ path: testInfo.outputPath("agent-proposal-desktop-dark.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await proposal.scrollIntoViewIfNeeded();
  const mobileDrawerBox = await drawer.boundingBox();
  const mobileProposalBox = await proposal.boundingBox();
  await expect(page.locator(".kc-topbar")).toHaveCount(0);
  expect(mobileDrawerBox).not.toBeNull();
  expect(mobileDrawerBox!.y).toBeGreaterThanOrEqual(7);
  expect(mobileDrawerBox!.y).toBeLessThanOrEqual(9);
  expect(844 - mobileDrawerBox!.y - mobileDrawerBox!.height).toBeGreaterThanOrEqual(7);
  expect(844 - mobileDrawerBox!.y - mobileDrawerBox!.height).toBeLessThanOrEqual(9);
  expect(mobileProposalBox!.x).toBeGreaterThan(mobileDrawerBox!.x);
  expect(mobileProposalBox!.x + mobileProposalBox!.width).toBeLessThan(mobileDrawerBox!.x + mobileDrawerBox!.width);
  await page.screenshot({ path: testInfo.outputPath("agent-proposal-mobile-dark.png") });
});

test("Agent companion stops ambient motion when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.clear());
  await mockAuthenticatedSession(page);
  await page.goto("/canvas");
  const animation = await page.locator(".kc-agent-companion-eyes").evaluate((element) => getComputedStyle(element).animationName);
  expect(animation).toBe("none");
});

test("未登录时不请求 Agent，登录成功后自动加载当前画布对话", async ({ page }, testInfo) => {
  const session = {
    user: {
      id: "99999999-9999-4999-8999-999999999999",
      email: "creator@example.com",
      displayName: "创作者",
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    expiresAt: "2026-08-16T12:00:00.000Z",
  };
  const capabilities = {
    available: true,
    registration: "native" as const,
    registrationUrl: null,
    passwordResetUrl: null,
  };
  let activeSession: typeof session | null = null;
  let agentRequests = 0;

  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: { ok: true, data: activeSession, capabilities },
  }));
  await page.route("**/api/v1/auth/login", (route) => {
    activeSession = session;
    return route.fulfill({ json: { ok: true, data: session, capabilities } });
  });
  await mockAuthenticatedBackgroundRequests(page);
  await page.route("**/api/v1/agent/**", (route) => {
    agentRequests += 1;
    if (new URL(route.request().url()).pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: agentModels } });
    }
    return route.fulfill({ json: { ok: true, data: [] } });
  });

  await page.goto("/canvas");
  await page.getByLabel("打开画布 Agent").click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  await expect(drawer.getByText("登录后继续对话")).toBeVisible();
  expect(agentRequests).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDrawerBox = await drawer.boundingBox();
  expect(mobileDrawerBox).not.toBeNull();
  expect(mobileDrawerBox!.x).toBeGreaterThanOrEqual(7);
  expect(mobileDrawerBox!.x + mobileDrawerBox!.width).toBeLessThanOrEqual(383);
  expect(mobileDrawerBox!.y).toBeGreaterThanOrEqual(7);
  expect(mobileDrawerBox!.y).toBeLessThanOrEqual(9);
  expect(844 - mobileDrawerBox!.y - mobileDrawerBox!.height).toBeGreaterThanOrEqual(7);
  expect(844 - mobileDrawerBox!.y - mobileDrawerBox!.height).toBeLessThanOrEqual(9);

  await drawer.getByRole("button", { name: "登录账号" }).click();
  const account = page.getByRole("dialog", { name: "卡藏账号" });
  await account.getByLabel("邮箱").fill("creator@example.com");
  await account.getByLabel("密码").fill("password");
  await account.getByRole("button", { name: "进入画布", exact: true }).click();

  await expect(account).toBeHidden();
  const mobileComposer = drawer.locator(".kc-agent-composer");
  await expect(mobileComposer).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: "发送给 Agent" })).toHaveAttribute("placeholder", "描述你想推进的内容");
  // 没有历史对话时应该展示填满面板的空状态，而不是一片空白。
  await expect(drawer.locator(".kc-agent-starters")).toHaveCount(1);
  await expect(drawer.locator(".kc-agent-empty")).toContainText("说说这一步想做什么");
  const authenticatedDrawerBox = await drawer.boundingBox();
  const mobileComposerBox = await mobileComposer.boundingBox();
  expect(mobileComposerBox).not.toBeNull();
  expect(mobileComposerBox!.x).toBeGreaterThan(authenticatedDrawerBox!.x);
  expect(mobileComposerBox!.x + mobileComposerBox!.width).toBeLessThan(authenticatedDrawerBox!.x + authenticatedDrawerBox!.width);
  expect(mobileComposerBox!.y + mobileComposerBox!.height).toBeLessThan(authenticatedDrawerBox!.y + authenticatedDrawerBox!.height);
  await page.screenshot({ path: testInfo.outputPath("agent-side-workspace-mobile-authenticated.png") });
  await expect.poll(() => agentRequests).toBe(2);
  await expect(drawer.getByLabel("Agent 回复")).not.toContainText("Agent 服务暂未配置");
});

test("Agent 加载、运行与取消反馈保持连续", async ({ page }) => {
  let cancelled = false;
  const runningRun = {
    schemaVersion: 1,
    id: "33333333-3333-4333-8333-333333333333",
    conversationId: conversation.id,
    userMessageId: openingMessages[0].id,
    assistantMessageId: null,
    status: "running",
    error: null,
    createdAt: "2026-07-16T12:00:01.000Z",
    startedAt: "2026-07-16T12:00:02.000Z",
    completedAt: null,
  } as const;
  const session = {
    user: {
      id: "99999999-9999-4999-8999-999999999999",
      email: "creator@example.com",
      displayName: "创作者",
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    expiresAt: "2026-08-16T12:00:00.000Z",
  };

  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await mockAuthenticatedBackgroundRequests(page);
  await page.route("**/api/v1/agent/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: agentModels } });
    }
    if (method === "GET" && url.pathname === "/api/v1/agent/conversations") {
      await new Promise((resolve) => setTimeout(resolve, 260));
      return route.fulfill({ json: { ok: true, data: [conversation] } });
    }
    if (method === "GET" && url.pathname === `/api/v1/agent/conversations/${conversation.id}`) {
      return route.fulfill({
        json: {
          ok: true,
          data: {
            conversation,
            messages: openingMessages,
            latestRun: cancelled ? { ...runningRun, status: "cancelled", completedAt: "2026-07-16T12:00:03.000Z" } : runningRun,
          },
        },
      });
    }
    if (method === "POST" && url.pathname.endsWith("/cancel")) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      cancelled = true;
      return route.fulfill({
        json: {
          ok: true,
          data: {
            conversation,
            messages: openingMessages,
            latestRun: { ...runningRun, status: "cancelled", completedAt: "2026-07-16T12:00:03.000Z" },
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "not found" } } });
  });

  await page.goto("/canvas");
  await page.getByLabel("打开画布 Agent").click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  await expect(drawer.getByText("正在接入画布")).toBeVisible();
  await expect(drawer.getByText("正在整理画布")).toBeVisible();
  await expect(drawer).toHaveAttribute("data-status", "working");

  const stop = drawer.getByRole("button", { name: "取消 Agent 任务" });
  await stop.click();
  await expect(stop).toContainText("停止中");
  await expect(drawer.getByText("已停止这次处理")).toBeVisible();
  await expect(drawer).toHaveAttribute("data-status", "ready");
});

test("Agent 提案必须确认后才修改画布并记录回执", async ({ page }, testInfo) => {
  const session = {
    user: {
      id: "99999999-9999-4999-8999-999999999999",
      email: "creator@example.com",
      displayName: "创作者",
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    expiresAt: "2026-08-16T12:00:00.000Z",
  };
  let projectId = "";
  let detailState: Record<string, unknown> | null = null;
  let receiptPayload: Record<string, unknown> | null = null;

  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await mockAuthenticatedBackgroundRequests(page);
  await page.route("**/api/v1/agent/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: agentModels } });
    }
    if (method === "GET" && url.pathname === "/api/v1/agent/conversations") {
      projectId = url.searchParams.get("projectId") ?? "";
      return route.fulfill({ json: { ok: true, data: [{ ...conversation, projectId }] } });
    }
    if (method === "GET" && url.pathname === `/api/v1/agent/conversations/${conversation.id}`) {
      return route.fulfill({
        json: {
          ok: true,
          data: detailState ?? { conversation: { ...conversation, projectId }, messages: [], latestRun: null },
        },
      });
    }
    if (method === "POST" && url.pathname.endsWith("/messages")) {
      const request = route.request().postDataJSON() as { canvasContext: { contextRevision: string } };
      detailState = proposalDetail(projectId, request.canvasContext.contextRevision, "pending", null);
      return route.fulfill({ status: 202, json: { ok: true, data: detailState } });
    }
    if (method === "POST" && url.pathname.endsWith("/proposal/confirm")) {
      const request = route.request().postDataJSON() as { contextRevision: string };
      const run = (detailState as { latestRun: { contextRevision: string } }).latestRun;
      expect(request.contextRevision).toBe(run.contextRevision);
      detailState = proposalDetail(projectId, run.contextRevision, "confirmed", null);
      return route.fulfill({ json: { ok: true, data: detailState } });
    }
    if (method === "POST" && url.pathname.endsWith("/receipt")) {
      receiptPayload = route.request().postDataJSON() as Record<string, unknown>;
      const run = (detailState as { latestRun: { contextRevision: string } }).latestRun;
      detailState = proposalDetail(projectId, run.contextRevision, "confirmed", {
        schemaVersion: 1,
        ...receiptPayload,
        createdAt: "2026-07-16T12:00:04.000Z",
      });
      return route.fulfill({ json: { ok: true, data: detailState } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "not found" } } });
  });

  await page.goto("/canvas");
  const nodes = page.locator(".react-flow__node-kachang");
  await expect(nodes.first()).toBeVisible();
  const initialNodeCount = await nodes.count();
  await page.getByLabel("打开画布 Agent").click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  await drawer.getByRole("textbox", { name: "发送给 Agent" }).fill("新增一个节奏节点");
  await drawer.getByRole("button", { name: "发送给 Agent" }).click();

  const proposal = drawer.locator(".kc-agent-proposal");
  await expect(proposal.getByText("新增节奏节点")).toBeVisible();
  await expect(nodes).toHaveCount(initialNodeCount);
  await page.screenshot({ path: testInfo.outputPath("agent-proposal-pending.png") });
  await proposal.getByRole("button", { name: "确认" }).click();

  await expect(nodes).toHaveCount(initialNodeCount + 1);
  await expect(drawer.getByText("已应用 1 项操作")).toBeVisible();
  expect(receiptPayload).toMatchObject({ appliedActions: 1, status: "applied", skippedActions: [] });
});

test("专业辅助基线未完成时阻止旧服务返回的提案", async ({ page }) => {
  const session = {
    user: {
      id: "99999999-9999-4999-8999-999999999999",
      email: "creator@example.com",
      displayName: "创作者",
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    expiresAt: "2026-08-16T12:00:00.000Z",
  };
  let projectId = "";
  let detailState: Record<string, unknown> | null = null;
  let confirmRequests = 0;
  let receiptRequests = 0;

  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await mockAuthenticatedBackgroundRequests(page);
  await page.route("**/api/v1/agent/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: agentModels } });
    }
    if (method === "GET" && url.pathname === "/api/v1/agent/conversations") {
      projectId = url.searchParams.get("projectId") ?? "";
      return route.fulfill({ json: { ok: true, data: [{ ...conversation, projectId }] } });
    }
    if (method === "GET" && url.pathname === `/api/v1/agent/conversations/${conversation.id}`) {
      return route.fulfill({
        json: {
          ok: true,
          data: detailState ?? { conversation: { ...conversation, projectId }, messages: [], latestRun: null },
        },
      });
    }
    if (method === "POST" && url.pathname.endsWith("/messages")) {
      const request = route.request().postDataJSON() as { canvasContext: { contextRevision: string } };
      detailState = proposalDetail(projectId, request.canvasContext.contextRevision, "pending", null);
      return route.fulfill({ status: 202, json: { ok: true, data: detailState } });
    }
    if (method === "POST" && url.pathname.endsWith("/proposal/confirm")) confirmRequests += 1;
    if (method === "POST" && url.pathname.endsWith("/receipt")) receiptRequests += 1;
    return route.fulfill({ status: 500, json: { ok: false, error: { code: "UNEXPECTED_REQUEST", message: "unexpected" } } });
  });

  await page.goto("/canvas");
  const nodes = page.locator(".react-flow__node-kachang");
  await expect(nodes.first()).toBeVisible();
  const initialNodeCount = await nodes.count();
  await page.getByLabel("打开画布 Agent").click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  const creativeModeSelect = drawer.getByLabel("创作协作模式", { exact: true });
  await creativeModeSelect.click();
  await page.getByRole("listbox", { name: "创作协作模式" })
    .getByRole("option", { name: "专业辅助" })
    .click();
  const baselineQuestion = drawer.locator(".kc-agent-baseline-question");
  await expect(baselineQuestion).toHaveCount(0);
  await drawer.getByRole("textbox", { name: "发送给 Agent" }).fill("新增一个节奏节点");
  await drawer.getByRole("button", { name: "发送给 Agent" }).click();

  const proposal = drawer.locator(".kc-agent-proposal");
  await expect(proposal.getByText("新增节奏节点")).toBeVisible();
  await expect(baselineQuestion).toBeVisible();
  await expect(baselineQuestion).toContainText("画面比例 · 1/3");
  await proposal.getByRole("button", { name: "确认" }).click();

  await expect(baselineQuestion).toBeVisible();
  await expect(page.getByText(/请先完成基线/)).toBeVisible();
  await expect(nodes).toHaveCount(initialNodeCount);
  expect(confirmRequests).toBe(0);
  expect(receiptRequests).toBe(0);
});

test("Agent 模型选择会持久化，并在模型下架后回退默认项", async ({ page }) => {
  const session = {
    user: {
      id: "99999999-9999-4999-8999-999999999999",
      email: "creator@example.com",
      displayName: "创作者",
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    expiresAt: "2026-08-16T12:00:00.000Z",
  };
  let catalog: { defaultModelId: string; models: Array<{ id: string; label: string }> } = {
    defaultModelId: agentModels.defaultModelId,
    models: [...agentModels.models],
  };

  await page.addInitScript(() => {
    if (sessionStorage.getItem("kc-agent-model-test-initialized")) return;
    localStorage.clear();
    sessionStorage.setItem("kc-agent-model-test-initialized", "true");
  });
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await mockAuthenticatedBackgroundRequests(page);
  await page.route("**/api/v1/agent/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/agent/models") {
      return route.fulfill({ json: { ok: true, data: catalog } });
    }
    if (url.pathname === "/api/v1/agent/conversations") {
      return route.fulfill({ json: { ok: true, data: [] } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "not found" } } });
  });

  await page.goto("/canvas");
  await page.getByLabel("打开画布 Agent").click();
  let modelSelect = page.getByRole("dialog", { name: "画布 Agent" }).getByLabel("Agent 模型", { exact: true });
  await modelSelect.click();
  await page.getByRole("listbox", { name: "Agent 模型" })
    .getByRole("option", { name: "GPT-5 Creative Preview 2026-07" })
    .click();
  await expect(modelSelect.locator("..")).toHaveAttribute("data-value", "gpt-5-creative-preview-2026-07");
  await expect(modelSelect.locator(".kc-cat-select-value")).toHaveText("GPT-5 Creative Preview 2026-07");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("kachang-canvas:agent-model:v1")))
    .toContain("gpt-5-creative-preview-2026-07");

  await page.reload();
  await page.getByLabel("打开画布 Agent").click();
  modelSelect = page.getByRole("dialog", { name: "画布 Agent" }).getByLabel("Agent 模型", { exact: true });
  await expect(modelSelect.locator("..")).toHaveAttribute("data-value", "gpt-5-creative-preview-2026-07");

  catalog = {
    defaultModelId: "gpt-5-mini",
    models: [{ id: "gpt-5-mini", label: "GPT-5 Mini" }],
  };
  await page.reload();
  await page.getByLabel("打开画布 Agent").click();
  modelSelect = page.getByRole("dialog", { name: "画布 Agent" }).getByLabel("Agent 模型", { exact: true });
  await expect(modelSelect.locator("..")).toHaveAttribute("data-value", "gpt-5-mini");
  await expect(modelSelect.locator(".kc-cat-select-value")).toHaveText("GPT-5 Mini");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("kachang-canvas:agent-model:v1")))
    .toContain("gpt-5-mini");

  await page.setViewportSize({ width: 1_024, height: 700 });
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.width);
});

function proposalDetail(
  projectId: string,
  contextRevision: string,
  proposalStatus: "pending" | "confirmed",
  receipt: Record<string, unknown> | null,
) {
  return {
    conversation: { ...conversation, projectId, title: "新增节奏节点", updatedAt: "2026-07-16T12:00:03.000Z" },
    messages: [
      {
        schemaVersion: 1,
        id: "22222222-2222-4222-8222-222222222222",
        conversationId: conversation.id,
        role: "user",
        content: "新增一个节奏节点",
        createdAt: "2026-07-16T12:00:01.000Z",
      },
      {
        schemaVersion: 1,
        id: "66666666-6666-4666-8666-666666666666",
        conversationId: conversation.id,
        role: "assistant",
        content: "我准备补一个承接节奏的文本节点。",
        createdAt: "2026-07-16T12:00:02.000Z",
      },
    ],
    latestRun: {
      schemaVersion: 1,
      id: "33333333-3333-4333-8333-333333333333",
      conversationId: conversation.id,
      userMessageId: "22222222-2222-4222-8222-222222222222",
      assistantMessageId: "66666666-6666-4666-8666-666666666666",
      modelId: "gpt-5-mini",
      status: "completed",
      actions: [{ type: "canvas_add_node", clientId: "beat", kind: "text", body: "节奏承接" }],
      executionMode: "proposal",
      proposal: {
        schemaVersion: 1,
        id: "77777777-7777-4777-8777-777777777777",
        title: "新增节奏节点",
        reason: "当前叙事需要一个明确的承接点。",
        successCriteria: ["新增节点出现在当前画布并可撤销"],
      },
      proposalStatus,
      contextRevision,
      receipt,
      error: null,
      createdAt: "2026-07-16T12:00:01.000Z",
      startedAt: "2026-07-16T12:00:01.100Z",
      completedAt: "2026-07-16T12:00:02.000Z",
    },
  };
}
