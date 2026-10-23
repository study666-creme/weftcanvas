import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const USER_ID = "55555555-5555-4555-8555-555555555555";
const AUDIO_BYTES = readFileSync(fileURLToPath(new URL("./audio-tone.mp3", import.meta.url)));

const session = {
  user: { id: USER_ID, email: "audio@example.com", displayName: "音频创作者", createdAt: NOW },
  expiresAt: EXPIRES_AT,
};

const audioModel = {
  id: "e2e-audio-model",
  label: "Suno 音乐",
  description: "文本生成音乐",
  modality: "audio",
  operation: "music",
  order: 1,
  input: { textRequired: true },
  output: { type: "audio", minCount: 1, maxCount: 1 },
  parameters: [
    { name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] },
  ],
  pricing: {
    mode: "fixed",
    unit: "request",
    currency: "CNY",
    creditsPerYuan: 100,
    baseCreditMicros: 500_000,
    baseYuanMicros: 5_000,
    tiers: [],
  },
};

function catalog() {
  return {
    version: "audio-catalog",
    capabilityVersion: "audio-capability",
    pricingVersion: "audio-pricing",
    fetchedAt: NOW,
    expiresAt: EXPIRES_AT,
    quoteAvailable: true,
    models: [audioModel],
  };
}

function audioQuote(parameters: Record<string, unknown>) {
  return {
    id: "quote-audio",
    modelId: "e2e-audio-model",
    modelLabel: "Suno 音乐",
    modality: "audio",
    quantity: 1,
    outputCount: 1,
    normalizedParameters: parameters,
    creditMicros: 500_000,
    credits: "0.5",
    yuanMicros: 5_000,
    yuan: "0.05",
    estimated: false,
    pricingUnit: "request",
    catalogVersion: "audio-catalog",
    capabilityVersion: "audio-capability",
    pricingVersion: "audio-pricing",
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

test("音频节点可用目录音频模型生成，结果回填为可播放音频", async ({ page }) => {
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
  const quotes: Array<{ modality: string; parameters: Record<string, unknown> }> = [];
  const submissions: Array<{
    modality: string;
    nodeId: string;
    parameters: Record<string, unknown>;
  }> = [];

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: session } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({ json: { ok: true, data: catalog() } }),
  );
  await page.route("**/api/v1/generation-quotes", (route) => {
    const body = route.request().postDataJSON() as {
      modality: string;
      parameters: Record<string, unknown>;
    };
    quotes.push({ modality: body.modality, parameters: body.parameters });
    return route.fulfill({ json: { ok: true, data: audioQuote(body.parameters) } });
  });
  await page.route("**/api/v1/generation-jobs*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) return route.fulfill({ status: 204, body: "" });
    if (request.method() === "GET") return route.fulfill({ json: { ok: true, data: [] } });

    const body = request.postDataJSON() as {
      projectId: string;
      nodeId: string;
      modality: string;
      parameters: Record<string, unknown>;
    };
    submissions.push({
      modality: body.modality,
      nodeId: body.nodeId,
      parameters: body.parameters,
    });
    credits -= 1;
    const created = {
      schemaVersion: 1,
      version: 1,
      id: "job-audio-result",
      projectId: body.projectId,
      nodeId: body.nodeId,
      modelId: "e2e-audio-model",
      modelLabel: "Suno 音乐",
      modality: "audio",
      status: "completed",
      progress: 100,
      quote: audioQuote(body.parameters),
      artifacts: [
        {
          id: "artifact-audio-result",
          kind: "audio",
          mediaId: "generated-audio-1",
          name: "生成音频 1.mp3",
          mimeType: "audio/mpeg",
          size: AUDIO_BYTES.byteLength,
          duration: 1.2,
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
  await page.route("**/api/v1/media/generated-audio-1/content*", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": String(AUDIO_BYTES.byteLength) },
      body: AUDIO_BYTES,
    }),
  );
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

  const createTools = page.getByRole("navigation", { name: "创建工具" });
  await createTools.locator(".wc-create-rail-plus-wrapper").hover();
  await createTools.getByRole("menuitem", { name: "添加音频节点" }).click();
  const audioNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="audio"])',
  );
  await expect(audioNode.locator(".wc-node-music-generate")).toBeVisible();
  await expect(audioNode.locator(".wc-node-music-generate")).toHaveText("用音频模型生成");

  await audioNode.locator(".wc-node-music-generate").click();
  const dialog = page.getByRole("dialog", { name: "音频节点生成设置" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".wc-generation-prompt textarea")).toHaveAttribute(
    "placeholder",
    "描述音乐风格与情绪，或写下要说的话",
  );
  await expect(dialog.getByRole("button", { name: "模型" })).toContainText("Suno 音乐");

  const prompt = "雨夜的爵士乐，慵懒女声，低音萨克斯";
  await dialog.locator(".wc-generation-prompt textarea").fill(prompt);
  await expect.poll(() => quotes.length).toBe(1);
  expect(quotes[0]!.modality).toBe("audio");
  expect(quotes[0]!.parameters.prompt).toBe(prompt);

  const submit = dialog.locator(".wc-generation-submit");
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ modality: "audio", parameters: { prompt } });
  await expect(audioNode.locator(".wc-mini-player")).toBeVisible();
  await expect(audioNode.getByRole("button", { name: "播放" })).toBeVisible();
  await expect(audioNode.locator(".wc-audio-wave")).toBeVisible();

  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
});
