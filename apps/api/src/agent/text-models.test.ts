import { describe, expect, it, vi } from "vitest";

import type { PublicModel } from "@weftcanvas/contracts";

import {
  AGENT_DEFAULT_REQUEST_PRICE_YUAN,
  agentTextModelGroup,
  buildAgentTextModels,
  createStationTextPricingLookup,
  parseStationTextPricing,
} from "./text-models.js";

function textModel(id: string, label: string, extra: Partial<PublicModel> = {}): PublicModel {
  return {
    id,
    label,
    description: "",
    modality: "text",
    operation: "chat",
    order: 0,
    parameters: [],
    input: { textRequired: true },
    output: { type: "text", minCount: 1, maxCount: 1 },
    pricing: { mode: "token", unit: "token", currency: "CNY", creditsPerYuan: 100, tiers: [] },
    ...extra,
  } as PublicModel;
}

const noOverrides = { models: {} };

describe("agent text model vendor grouping", () => {
  it("puts same-vendor models in one group instead of splitting by billing", () => {
    expect(agentTextModelGroup("glm-5.2 GLM-5.2")).toBe("GLM");
    expect(agentTextModelGroup("glm-5.3-flash GLM-5.3 Flash")).toBe("GLM");
    expect(agentTextModelGroup("deepseek-v4-pro-0813 DeepSeek V4 Pro 0813")).toBe("DeepSeek");
    expect(agentTextModelGroup("gemini-3.7-flash Gemini 3.7 Flash")).toBe("Gemini");
    expect(agentTextModelGroup("Kimi-K2.6 Kimi K2.6")).toBe("Kimi");
    expect(agentTextModelGroup("MiniMax-M2.7 Minimax M2.7")).toBe("Minimax");
    expect(agentTextModelGroup("hy4-preview Hunyuan HY4 Preview")).toBe("混元");
    expect(agentTextModelGroup("mimo-v2.5 小米 MiMo V2.5")).toBe("小米");
    expect(agentTextModelGroup("grok-4.6 Grok 4.6")).toBe("Grok");
    expect(agentTextModelGroup("mystery-model Mystery")).toBe("其他");
  });
});

describe("station pricing lookup", () => {
  const payload = {
    data: [
      {
        model_name: "gemini-3.7-flash",
        price: { unit: "1M_tokens" },
        group_prices: {
          按次文本: { unit: "request", request: 0.012 },
          按量Gemini: { unit: "1M_tokens" },
        },
      },
      {
        model_name: "claude-sonnet-5",
        price: { unit: "1M_tokens" },
        group_prices: { Claude官逆: { unit: "1M_tokens" } },
      },
    ],
  };

  it("marks a model per-request when any group publishes a request price", () => {
    const parsed = parseStationTextPricing(payload);
    expect(parsed.requestPricedModelIds.has("gemini-3.7-flash")).toBe(true);
    expect(parsed.requestPricedModelIds.has("claude-sonnet-5")).toBe(false);
    expect(parsed.knownModelIds.has("claude-sonnet-5")).toBe(true);
  });

  it("falls back to the last successful read and never throws when the station is down", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockRejectedValueOnce(new Error("connect timeout"));
    const lookup = createStationTextPricingLookup({
      url: "https://station.test/api/pricing",
      fetch: fetcher as unknown as typeof globalThis.fetch,
      ttlMs: 0,
    });
    const first = await lookup();
    expect(first?.requestPricedModelIds.has("gemini-3.7-flash")).toBe(true);
    const second = await lookup();
    expect(second).toEqual(first);
  });

  it("reports null when the station has never answered", async () => {
    const lookup = createStationTextPricingLookup({
      url: "https://station.test/api/pricing",
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(lookup()).resolves.toBeNull();
  });
});

describe("buildAgentTextModels", () => {
  const gemini = textModel("gemini-3.7-flash", "Gemini 3.7 Flash", { perRequest: true });
  const glm = textModel("glm-5.2", "GLM-5.2", {
    pricing: {
      mode: "tiered",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 1_000_000,
      tiers: [],
    },
  });
  const claude = textModel("claude-sonnet-5", "Claude Sonnet 5");
  const sol = textModel("gpt-5.6-sol", "GPT-5.6 Sol", { perRequest: true });

  const station = parseStationTextPricing({
    data: [
      {
        model_name: "gemini-3.7-flash",
        group_prices: { 按次文本: { unit: "request", request: 0.012 } },
      },
      // 站点价格表里存在但只有按量价：即便目录写了 per-request 也不能当按次。
      { model_name: "gpt-5.6-sol", group_prices: { GPT标准: { unit: "1M_tokens" } } },
      { model_name: "claude-sonnet-5", group_prices: { Claude官逆: { unit: "1M_tokens" } } },
    ],
  });

  it("keeps per-request-priced token-mode Gemini in the picker", () => {
    const models = buildAgentTextModels({
      models: [glm, gemini, claude],
      overrides: noOverrides,
      stationPricing: station,
      includeTokenModels: false,
    });
    const ids = models.map((model) => model.id);
    expect(ids).toContain("gemini-3.7-flash");
    expect(ids).toContain("glm-5.2");
    expect(ids).not.toContain("claude-sonnet-5");
    // Gemini 走按次价：默认 2 积分/次，而不是按量费率。
    expect(models.find((model) => model.id === "gemini-3.7-flash")).toMatchObject({
      group: "Gemini",
      billing: "request",
      meta: `${AGENT_DEFAULT_REQUEST_PRICE_YUAN * 100} 积分/次`,
    });
  });

  it("prices Gemini Pro at 10 and every Claude at 40 credits per request", () => {
    // 运营口径 2026-10-01：Pro 系列不再吃 2 积分统一价；Claude 全系 40。
    const pro = textModel("gemini-3.1-pro", "Gemini 3.1 Pro", { perRequest: true });
    const sonnet = textModel("claude-sonnet-5", "Claude Sonnet 5", { perRequest: true });
    const claudeStation = parseStationTextPricing({
      data: [
        { model_name: "gemini-3.1-pro", group_prices: { 按次文本: { unit: "request" } } },
        { model_name: "claude-sonnet-5", group_prices: { 按次文本: { unit: "request" } } },
      ],
    });
    const models = buildAgentTextModels({
      models: [pro, sonnet],
      overrides: noOverrides,
      stationPricing: claudeStation,
      includeTokenModels: false,
    });
    expect(models.find((model) => model.id === "gemini-3.1-pro")).toMatchObject({
      billing: "request",
      meta: "10 积分/次",
    });
    expect(models.find((model) => model.id === "claude-sonnet-5")).toMatchObject({
      billing: "request",
      meta: "40 积分/次",
    });
  });

  it("keeps the operator override above the series price rules", () => {
    const pro = textModel("gemini-3.1-pro", "Gemini 3.1 Pro", { perRequest: true });
    const models = buildAgentTextModels({
      models: [pro],
      overrides: { models: { "gemini-3.1-pro": { price: { yuan: 0.05 } } } },
      stationPricing: station,
      includeTokenModels: false,
    });
    expect(models[0]?.meta).toBe("5 积分/次");
  });

  it("trusts the station over the catalog tag for token-only models", () => {
    const models = buildAgentTextModels({
      models: [sol],
      overrides: noOverrides,
      stationPricing: station,
      includeTokenModels: false,
    });
    expect(models).toHaveLength(0);
  });

  it("falls back to catalog tags when the station pricing is unavailable", () => {
    const models = buildAgentTextModels({
      models: [glm, gemini, claude],
      overrides: noOverrides,
      stationPricing: null,
      includeTokenModels: false,
    });
    expect(models.map((model) => model.id)).toEqual(["glm-5.2", "gemini-3.7-flash"]);
  });

  it("adds every text model when token models are explicitly enabled", () => {
    const models = buildAgentTextModels({
      models: [glm, gemini, claude],
      overrides: noOverrides,
      stationPricing: station,
      includeTokenModels: true,
    });
    expect(models.map((model) => model.id)).toEqual([
      "glm-5.2",
      "gemini-3.7-flash",
      "claude-sonnet-5",
    ]);
    expect(models.find((model) => model.id === "claude-sonnet-5")?.billing).toBe("token");
  });

  it("applies operator price overrides to the per-request label", () => {
    const models = buildAgentTextModels({
      models: [glm],
      overrides: { models: { "glm-5.2": { price: { yuan: 0.05 } } } },
      stationPricing: station,
      includeTokenModels: false,
    });
    expect(models[0]?.meta).toBe("5 积分/次");
  });

  it("skips unlisted compatibility entries and non-text models", () => {
    const legacy = textModel("deepseek-v4-flash", "DeepSeek V4 Flash", {
      listed: false,
      pricing: { mode: "fixed", unit: "request", currency: "CNY", creditsPerYuan: 100, tiers: [] },
    });
    const image = { ...textModel("image2", "全能模型2"), modality: "image" as const };
    const models = buildAgentTextModels({
      models: [legacy, image, glm],
      overrides: noOverrides,
      stationPricing: station,
      includeTokenModels: false,
    });
    expect(models.map((model) => model.id)).toEqual(["glm-5.2"]);
  });
});
