import { describe, expect, it } from "vitest";

import { normalizeSourceCatalog, type CatalogCompatibilityOverlay } from "./normalize.js";

/**
 * Regression guard for two silent-drop / silent-rewrite bugs found on
 * 2026-09-20 against the live station catalog:
 *
 * 1. `tiered_token` is the source shape for token models whose per-million
 *    rates vary by context tier. The sanitizer used to reject the mode, so
 *    every such model (all four Gemini lines, GPT-5.6 Sol) vanished from the
 *    picker without any error.
 * 2. A hard-coded id set rewrote `unit: "request"` to `"second"` for
 *    minimax_h3, billing a flat per-request video as if it were per second.
 *    The published unit is the only authority.
 */

const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function chatModel(id: string, label: string, pricing: Record<string, unknown>, tags?: string) {
  return {
    id,
    label,
    description: `${label} 测试模型`,
    modality: "text",
    operation: "chat",
    order: 10,
    input: { text: { required: true } },
    output: { type: "text" },
    endpoint: { method: "POST", path: "/v1/chat/completions", content_type: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", required: true, fixed: id, label: "模型" },
      { name: "prompt", path: "prompt", type: "string", required: true, label: "提示词" },
    ],
    public: { id, label, description: `${label} 测试模型` },
    selectable: true,
    ...(tags ? { tags } : {}),
    pricing,
  };
}

function videoModel(id: string, label: string, pricing: Record<string, unknown>) {
  return {
    id,
    label,
    description: `${label} 测试视频模型`,
    modality: "video",
    operation: "generate",
    order: 20,
    output: { type: "video" },
    endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", required: true, fixed: id, label: "模型" },
      { name: "prompt", path: "prompt", type: "string", required: true, label: "提示词" },
    ],
    public: { id, label, description: `${label} 测试视频模型` },
    selectable: true,
    pricing,
  };
}

const source = {
  success: true as const,
  version: "test-units-1",
  capability_version: "2026-09-20.001",
  pricing_version: "",
  fetched_at: "2026-09-20T12:00:00.000Z",
  credits_per_yuan: 100,
  models: [
    chatModel("gemini-3.8-flash", "Gemini 3.8 Flash", {
      mode: "tiered_token",
      unit: "token",
      currency: "CNY",
      input_credits_per_million: 60,
      output_credits_per_million: 300,
      input_yuan_per_million: 0.6,
      output_yuan_per_million: 3,
      tiers: [
        { name: "≤ 128K", input_credits_per_million: 60, output_credits_per_million: 300 },
        { name: "> 128K", input_credits_per_million: 90, output_credits_per_million: 450 },
      ],
    }, "chat,text,gemini,fast,reasoning,per-request,token"),
    chatModel("gpt-5.6-sol", "GPT-5.6 Sol", {
      mode: "tiered_token",
      unit: "token",
      currency: "CNY",
      input_credits_per_million: 50,
      output_credits_per_million: 300,
      input_yuan_per_million: 0.5,
      output_yuan_per_million: 3,
      tiers: [{ name: "≤ 256K", input_credits_per_million: 50, output_credits_per_million: 300 }],
    }),
    videoModel("minimax_h3", "Minimax H3", {
      mode: "tiered",
      unit: "request",
      currency: "CNY",
      credits: 9,
      yuan: 0.09,
      tiers: [
        { name: "768", when: { resolution: "768" }, yuan: 0.09, credits: 9 },
        { name: "1080p", when: { resolution: "1080p" }, yuan: 0.16, credits: 16 },
      ],
    }),
  ],
};
/**
 * 站点计价单位规则现居私有 overlay；公开树用等价的内联 overlay 钉住注入机制
 * 与两端口径（H3=按秒、S-2.0 等线路=按次）。
 */
const stationUnitOverlay: CatalogCompatibilityOverlay = {
  priceUnitOverride: (model, publishedUnit) =>
    (model.id === "minimax_h3" && publishedUnit === "request" ? "second" : undefined),
} as const;


function normalize() {
  return normalizeSourceCatalog(source, {
    validatedAt: NOW,
    maxQuoteAgeMs: 3_600_000,
    includeKnownModels: false,
    overlay: stationUnitOverlay,
  });
}

describe("source catalog pricing modes and units", () => {
  it("keeps tiered_token models and exposes their base token rates", () => {
    const snapshot = normalize();
    const ids = snapshot.catalog.models.map((model) => model.id);
    expect(ids).toContain("gemini-3.8-flash");
    expect(ids).toContain("gpt-5.6-sol");

    const gemini = snapshot.catalog.models.find((model) => model.id === "gemini-3.8-flash")!;
    expect(gemini.pricing.mode).toBe("token");
    expect(gemini.pricing.unit).toBe("token");
    expect(gemini.pricing.inputCreditMicrosPerMillion).toBe(60_000_000);
    expect(gemini.pricing.outputCreditMicrosPerMillion).toBe(300_000_000);
    // 上游的 per-request 标记必须活到公共目录：Agent 选择器只收有按次价的模型，
    // 而 Gemini 这类 tiered_token 模型在 mode 上看不出还有按次价。
    expect(gemini.perRequest).toBe(true);
    // 没有该标签的模型不得被误标成按次。
    expect(snapshot.catalog.models.find((model) => model.id === "gpt-5.6-sol")!.perRequest).toBeUndefined();
  });

  /**
   * 计费口径回归：MiniMax H3 站点按秒计费，卡藏目录却发布 unit:"request"
   * （其中 9 是每秒费率）。照目录按次收会少收一个数量级，这个 bug 已经反复
   * 出现过几次。这里同时钉住两端，防止有人再次整段删掉纠正、或一刀切改宽：
   * H3 必须按秒，S-2.0 等真正按次的线路必须保持按次。
   */
  it("bills MiniMax H3 per second even though the catalog publishes per request", () => {
    const snapshot = normalize();
    const h3 = snapshot.catalog.models.find((model) => model.id === "minimax_h3")!;
    expect(h3.pricing.unit).toBe("second");
    expect(h3.pricing.baseCreditMicros).toBe(9_000_000);
    // 每秒 9 积分：一条 10 秒的 768P 视频必须收 90，而不是 9。
    expect(h3.pricing.baseCreditMicros! * 10).toBe(90_000_000);
  });

  it("keeps genuinely per-request video lines on the published unit", () => {
    const perRequest = {
      ...source,
      models: [
        ...source.models,
        videoModel("S-2.0-933-线路六", "S-2.0-933-线路六", {
          mode: "tiered",
          unit: "request",
          currency: "CNY",
          credits: 340,
          yuan: 3.4,
          tiers: [{ name: "720P", when: { resolution: "720P" }, yuan: 3.4, credits: 340 }],
        }),
        videoModel("MiniMax-H3-漫剧优化", "MiniMax H3 漫剧优化", {
          mode: "tiered",
          unit: "second",
          currency: "CNY",
          credits: 14,
          yuan: 0.14,
          tiers: [{ name: "768", when: { resolution: "768" }, yuan: 0.14, credits: 14 }],
        }),
      ],
    };
    const snapshot = normalizeSourceCatalog(perRequest, {
      validatedAt: NOW,
      maxQuoteAgeMs: 3_600_000,
      includeKnownModels: false,
    overlay: stationUnitOverlay,
    });
    expect(snapshot.catalog.models.find((model) => model.id === "S-2.0-933-线路六")!.pricing.unit)
      .toBe("request");
    expect(snapshot.catalog.models.find((model) => model.id === "MiniMax-H3-漫剧优化")!.pricing.unit)
      .toBe("second");
  });
});

describe("seedance presentation", () => {
  const seedanceSource = {
    ...source,
    models: [
      ...source.models,
      {
        id: "doubao-seedance-2.0",
        label: "doubao-seedance-2.0",
        description: "字节 Seedance 2.0 视频模型",
        modality: "video",
        operation: "generate",
        order: 44,
        output: { type: "video" },
        endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
        parameters: [
          { name: "model", path: "model", type: "string", required: true, fixed: "doubao-seedance-2.0", label: "模型" },
          { name: "prompt", path: "prompt", type: "string", required: true, label: "提示词" },
          { name: "duration_seconds", path: "duration_seconds", type: "integer", min: 4, max: 15 },
        ],
        public: { id: "doubao-seedance-2.0", label: "doubao-seedance-2.0", description: "字节 Seedance 2.0 视频模型" },
        selectable: true,
        pricing: {
          mode: "token",
          unit: "token",
          currency: "CNY",
          credits_per_yuan: 100,
          input_credits_per_million: 2990,
          output_credits_per_million: 2990,
          input_yuan_per_million: 29.9,
          output_yuan_per_million: 29.9,
          estimated_yuan_per_second: 0.64584,
        },
      },
    ],
  };

  it("derives a friendly label when the upstream publishes only the raw id", () => {
    const snapshot = normalizeSourceCatalog(seedanceSource, {
      validatedAt: NOW,
      maxQuoteAgeMs: 3_600_000,
      includeKnownModels: false,
    overlay: stationUnitOverlay,
    });
    const seedance = snapshot.catalog.models.find((model) => model.id === "doubao-seedance-2.0")!;
    expect(seedance.label).toBe("Seedance 2.0");
    // Token 视频模型的参考秒价必须活着：报价靠它，展示也靠它。
    expect(seedance.pricing.estimatedYuanMicrosPerSecond).toBe(645_840);
    expect(seedance.pricing.mode).toBe("token");
  });

  it("keeps an upstream label that is already human-readable", () => {
    const withLabel = {
      ...seedanceSource,
      models: seedanceSource.models.map((model) =>
        model.id === "doubao-seedance-2.0"
          ? { ...model, public: { ...model.public, label: "Seedance 2.0 官转65折" } }
          : model),
    };
    const snapshot = normalizeSourceCatalog(withLabel, {
      validatedAt: NOW,
      maxQuoteAgeMs: 3_600_000,
      includeKnownModels: false,
    overlay: stationUnitOverlay,
    });
    expect(snapshot.catalog.models.find((model) => model.id === "doubao-seedance-2.0")!.label)
      .toBe("Seedance 2.0 官转65折");
  });
});

describe("raw-id display labels", () => {
  const withRawLabel = {
    ...source,
    models: [
      ...source.models,
      chatModel("gemini-3.9-flash", "gemini-3.9-flash", {
        mode: "tiered_token",
        unit: "token",
        currency: "CNY",
        input_credits_per_million: 60,
        output_credits_per_million: 300,
        input_yuan_per_million: 0.6,
        output_yuan_per_million: 3,
      }),
    ],
  };

  it("derives a label for a non-seedance model published under its raw id", () => {
    const snapshot = normalizeSourceCatalog(withRawLabel, {
      validatedAt: NOW,
      maxQuoteAgeMs: 3_600_000,
      includeKnownModels: false,
    overlay: stationUnitOverlay,
    });
    expect(snapshot.catalog.models.find((model) => model.id === "gemini-3.9-flash")!.label)
      .toBe("Gemini 3.9 Flash");
  });

  it("leaves technical names that already read as names untouched", () => {
    const technical = {
      ...source,
      models: [
        ...source.models,
        videoModel("S-2.0-933-线路六", "S-2.0-933-线路六", {
          mode: "fixed",
          unit: "request",
          currency: "CNY",
          credits: 340,
          yuan: 3.4,
        }),
      ],
    };
    const snapshot = normalizeSourceCatalog(technical, {
      validatedAt: NOW,
      maxQuoteAgeMs: 3_600_000,
      includeKnownModels: false,
    overlay: stationUnitOverlay,
    });
    expect(snapshot.catalog.models.find((model) => model.id === "S-2.0-933-线路六")!.label)
      .toBe("S-2.0-933-线路六");
  });
});
