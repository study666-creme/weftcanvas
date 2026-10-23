import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

type NetworkState = { unmocked: string[]; external: string[] };

async function installNetworkGuard(page: Page, network: NetworkState) {
  let expectedOrigin: string | null = null;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expectedOrigin ??= url.origin;
    if (url.origin !== expectedOrigin) {
      network.external.push(`${request.method()} ${url.href}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      network.unmocked.push(`${request.method()} ${url.pathname}${url.search}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

const NOW = new Date().toISOString();
const EXPIRES_AT = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const USER_ID = "44444444-4444-4444-8444-444444444444";

const session = {
  user: {
    id: USER_ID,
    email: "assistant@example.com",
    displayName: "提示词创作者",
    createdAt: NOW,
  },
  expiresAt: EXPIRES_AT,
};

const textModel = {
  id: "e2e-text-model",
  label: "全能文本模型",
  description: "平台文本模型，按 token 计费",
  modality: "text",
  operation: "chat",
  order: 1,
  input: { textRequired: true },
  output: { type: "text", minCount: 1, maxCount: 1 },
  parameters: [
    { name: "messages", label: "消息", type: "array", required: true, mutuallyExclusiveWith: [] },
  ],
  pricing: {
    mode: "token",
    unit: "token",
    currency: "CNY",
    creditsPerYuan: 100,
    inputCreditMicrosPerMillion: 15_000_000,
    outputCreditMicrosPerMillion: 90_000_000,
    tiers: [],
  },
};

function catalog() {
  return {
    version: "text-catalog",
    capabilityVersion: "text-capability",
    pricingVersion: "text-pricing",
    fetchedAt: NOW,
    expiresAt: EXPIRES_AT,
    quoteAvailable: true,
    models: [textModel],
  };
}

function textQuote(parameters: Record<string, unknown>) {
  return {
    id: "quote-assistant",
    modelId: "e2e-text-model",
    modelLabel: "全能文本模型",
    modality: "text",
    quantity: 1,
    outputCount: 1,
    normalizedParameters: parameters,
    creditMicros: 195_000,
    credits: "0.195",
    yuanMicros: 1_950,
    yuan: "0.00195",
    estimated: true,
    pricingUnit: "token",
    catalogVersion: "text-catalog",
    capabilityVersion: "text-capability",
    pricingVersion: "text-pricing",
    expiresAt: EXPIRES_AT,
  };
}

function walletSummary(credits: number) {
  return {
    credits,
    creditsPermanent: credits,
    dailyCredits: 0,
    creditGrantMode: "bundle" as const,
    dailyCreditsNote: "",
    membership: { tier: null, until: null, active: false, genDiscount: null },
    lifetimeCreditsSpent: 0,
  };
}

test("文本节点可用文本模型优化提示词，并把生成的提示词落到右侧新节点", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("wc-e2e-seeded") !== "1") {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem("wc-e2e-seeded", "1");
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
  });

  const network: NetworkState = { unmocked: [], external: [] };
  await installNetworkGuard(page, network);
  await mockAuthenticatedBackgroundApis(page);

  let credits = 100;
  const submissions: Array<{ nodeId: string; parameters: Record<string, unknown> }> = [];
  const quotes: Array<{ parameters: Record<string, unknown> }> = [];

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: session } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({ json: { ok: true, data: catalog() } }),
  );
  await page.route("**/api/v1/generation-quotes", (route) => {
    const body = route.request().postDataJSON() as { parameters: Record<string, unknown> };
    quotes.push({ parameters: body.parameters });
    return route.fulfill({ json: { ok: true, data: textQuote(body.parameters) } });
  });
  await page.route("**/api/v1/generation-jobs*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) return route.fulfill({ status: 204, body: "" });
    if (request.method() === "GET") return route.fulfill({ json: { ok: true, data: [] } });

    const body = request.postDataJSON() as {
      projectId: string;
      nodeId: string;
      parameters: Record<string, unknown>;
    };
    submissions.push({ nodeId: body.nodeId, parameters: body.parameters });
    credits -= 1;
    const messages = body.parameters.messages as Array<{ content: string }> | undefined;
    const prompt = messages?.[0]?.content ?? "";
    const created = {
      schemaVersion: 1,
      version: 1,
      id: `job-assistant-${submissions.length}`,
      projectId: body.projectId,
      nodeId: body.nodeId,
      modelId: "e2e-text-model",
      modelLabel: "全能文本模型",
      modality: "text",
      status: "completed",
      progress: 100,
      quote: textQuote(body.parameters),
      artifacts: [
        {
          id: `artifact-assistant-${submissions.length}`,
          kind: "text",
          text: prompt.includes("优化下面这段提示词")
            ? "雨夜站台，暖黄灯下的猫，低机位，浅景深，电影感光线"
            : "雨夜站台，少年与鲸鱼隔着车窗对视，冷蓝霓虹，广角镜头",
          createdAt: NOW,
        },
      ],
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
    };
    return route.fulfill({ status: 202, json: { ok: true, data: created } });
  });
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({ json: { ok: true, data: walletSummary(credits) } }),
  );
  await page.route(/\/api\/v1\/announcements(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ok: true, data: { items: [] } } }),
  );
  await page.route(/\/api\/v1\/agent\/connectors(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );

  await page.goto("/canvas");
  await expect(page.locator("[data-save-state]")).toBeVisible();

  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加文本节点" })
    .click();
  const textNodes = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  const createdNode = textNodes.last();
  const sourceNodeId = await createdNode.getAttribute("data-id");
  expect(sourceNodeId).not.toBeNull();
  const sourceNode = page.locator(`.react-flow__node-weftcanvas[data-id="${sourceNodeId}"]`);
  await createdNode.locator(".wc-node-drag-strip").click();

  const composer = page.locator("[data-node-prompt-composer]");
  await expect(composer).toBeVisible();
  const optimize = composer.getByRole("button", { name: "优化提示词" });
  const derive = composer.getByRole("button", { name: "根据文本生成提示词" });
  await expect(optimize).toBeDisabled();

  const sourceText = "一只猫坐在雨夜的站台长椅上";
  await composer.locator("[data-prompt-editor]").fill(sourceText);
  await expect(optimize).toBeEnabled();
  await expect(derive).toBeEnabled();

  await optimize.click();
  await expect.poll(() => quotes.length).toBe(1);
  const optimizePrompt = (quotes[0]!.parameters.messages as Array<{ content: string }>)[0]!.content;
  expect(optimizePrompt).toContain("优化下面这段提示词");
  expect(optimizePrompt).toContain(sourceText);
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]!.nodeId).toBe(sourceNodeId);
  await expect(sourceNode.locator(".wc-node-text-preview")).toContainText("电影感光线");
  await expect(composer.locator("[data-prompt-editor]")).toContainText("电影感光线");

  await composer.locator("[data-prompt-editor]").fill("少年在雨夜的电车上遇见一只会说话的鲸鱼");
  await derive.click();
  await expect.poll(() => submissions.length).toBe(2);
  const derivePrompt = (quotes[1]!.parameters.messages as Array<{ content: string }>)[0]!.content;
  expect(derivePrompt).toContain("提炼一条可直接用于 AI 图片或视频生成的提示词");
  expect(submissions[1]!.nodeId).not.toBe(sourceNodeId);

  await expect(textNodes).toHaveCount(2);
  const resultNode = textNodes.last();
  await expect(resultNode.locator(".wc-node-text-preview")).toContainText("冷蓝霓虹");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(sourceNode.locator(".wc-node-text-preview")).toContainText("少年在雨夜的电车上遇见");

  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
});
