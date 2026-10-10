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
const USER_ID = "22222222-2222-4222-8222-222222222222";

const session = {
  user: {
    id: USER_ID,
    email: "text@example.com",
    displayName: "文本创作者",
    createdAt: NOW,
  },
  expiresAt: EXPIRES_AT,
};

const capabilities = {
  available: true,
  registration: "external" as const,
  registrationUrl: "https://prompt-hubs.com/register",
  passwordResetUrl: "https://prompt-hubs.com/forgot-password",
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
    { name: "max_tokens", label: "最大输出令牌", type: "integer", required: false, min: 1, max: 131072, mutuallyExclusiveWith: [] },
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
    id: "quote-text",
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

function summary(credits: number) {
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

test("文本节点可通过生成设置使用目录文本模型：报价、提交、文本产物回填节点", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("kc-e2e-seeded") !== "1") {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem("kc-e2e-seeded", "1");
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
  const quotes: Array<{ modality: string; parameters: Record<string, unknown>; inputTokens?: number; maxOutputTokens?: number }> = [];
  const submissions: Array<Record<string, unknown>> = [];
  const idempotencyKeys: string[] = [];
  const jobs: Array<Record<string, unknown>> = [];

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: { ok: true, data: session, capabilities },
  }));
  await page.route("**/api/v1/card-library/groups", (route) => route.fulfill({
    json: { ok: true, data: { groups: [] } },
  }));
  await page.route("**/api/v1/card-library/cards**", (route) => route.fulfill({
    json: { ok: true, data: { cards: [], total: 0, page: 1, limit: 18 } },
  }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({
    json: { ok: true, data: catalog() },
  }));
  await page.route("**/api/v1/generation-quotes", (route) => {
    const body = route.request().postDataJSON() as { modality: string; parameters: Record<string, unknown>; inputTokens?: number; maxOutputTokens?: number };
    quotes.push({ modality: body.modality, parameters: body.parameters, inputTokens: body.inputTokens, maxOutputTokens: body.maxOutputTokens });
    return route.fulfill({ json: { ok: true, data: textQuote(body.parameters) } });
  });
  await page.route("**/api/v1/generation-jobs*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) return route.fulfill({ status: 204, body: "" });
    if (request.method() === "GET") return route.fulfill({ json: { ok: true, data: jobs } });

    const body = request.postDataJSON() as { projectId: string; nodeId: string; parameters: Record<string, unknown> };
    submissions.push(body);
    idempotencyKeys.push(String(body.idempotencyKey));
    credits -= 1;
    const created = {
      schemaVersion: 1,
      version: 1,
      id: "job-text-result",
      projectId: body.projectId,
      nodeId: body.nodeId,
      modelId: "e2e-text-model",
      modelLabel: "全能文本模型",
      modality: "text",
      status: "completed",
      progress: 100,
      quote: textQuote(body.parameters),
      artifacts: [{
        id: "artifact-text-result",
        kind: "text",
        text: "夜色渐深，站台上的雨丝被暖黄灯光拉成细线。",
        createdAt: NOW,
      }],
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
    };
    jobs.push(created);
    return route.fulfill({ status: 202, json: { ok: true, data: created } });
  });
  await page.route("**/api/v1/wallet", (route) => route.fulfill({ json: { ok: true, data: summary(credits) } }));

  await page.goto("/canvas");
  await expect(page.locator('[data-save-state]')).toBeVisible();

  await page.getByRole("navigation", { name: "创建工具" }).getByLabel("添加文本节点").click();
  const textNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])').last();
  await textNode.locator(".kc-node-drag-strip").click();
  await expect(page.locator("[data-node-prompt-composer]")).toBeVisible();

  await textNode.hover();
  await page.locator('.kc-node-action-toolbar[data-node-kind="text"] [data-toolbar-action="generate"]').click();
  const dialog = page.getByRole("dialog", { name: "文本节点生成设置" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-generation-model-select]")).toHaveValue("e2e-text-model");

  const prompt = "写一段雨夜站台的分镜描述";
  await dialog.locator(".kc-generation-prompt textarea").fill(prompt);
  await dialog.locator('.kc-generation-field:has(> span:text("最大输出令牌")) input[type="number"]').fill("2048");
  await expect.poll(() => quotes.some((entry) => entry.modality === "text")).toBe(true);
  await expect(dialog.locator(".kc-generation-quote")).toContainText("0.195");

  const submit = dialog.locator(".kc-generation-submit");
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(() => submissions.length).toBe(1);
  const submitted = submissions[0]!;
  expect(submitted).toMatchObject({
    modality: "text",
    modelId: "e2e-text-model",
    quantity: 1,
  });
  const parameters = submitted.parameters as Record<string, unknown>;
  expect(parameters.messages).toEqual([{ role: "user", content: prompt }]);
  expect(parameters.max_tokens).toBe(2048);
  expect(submitted.inputTokens).toBeGreaterThan(0);
  expect(submitted.maxOutputTokens).toBe(2048);
  expect(submitted.inputs).toEqual({ images: [], styleImages: [], elementImages: [], videos: [], audios: [] });
  expect(submitted.expectedQuote).toMatchObject({ id: "quote-text", modelId: "e2e-text-model" });
  expect(idempotencyKeys).toEqual([expect.stringMatching(/^job:[0-9a-f]{8}-/)]);

  await expect(textNode.locator(".kc-node-wrap")).toHaveAttribute("data-node-status", "success");
  await expect(textNode.locator(".kc-node-text-preview")).toContainText("夜色渐深，站台上的雨丝");
  await expect(page.getByLabel("文本节点提示词")).toContainText("夜色渐深，站台上的雨丝");
  await expect(page.locator(".kc-credit-trigger")).toContainText("99");

  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
});
