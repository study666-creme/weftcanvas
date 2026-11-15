import { describe, expect, it } from "vitest";

import { WeftcanvasCatalogAdapter } from "./adapter.js";
import { GenerationQuoteService } from "./quote.js";
import { MemoryCatalogSnapshotStore } from "./store.js";

/**
 * 480 与 720 双档视频模型的计费回归。
 *
 * 用户 2026-11-05 报障：站点发布 480P/720P 双档的模型，在画布换分辨率不改变
 * 计费，全部按 480 收——平台按 720 的成本出片却只收到 480 的钱。报价链路上
 * 有三处会静默退化成「全部命中最低档」，这些用例把它们逐个钉住：
 *
 * 1. `when: {}` 的空条件档在 `every()` 下恒真，排在第一就会吞掉所有请求；
 * 2. 上游档位写 `720P`、选项写 `720p` 时精确比较打不中，回落到基准价；
 * 3. 宽泛档（只看 quality）排在精确档（quality + resolution）前面时先命中。
 */
const NOW = Date.parse("2026-11-05T09:00:00.000Z");

type Tier = { when: Record<string, string>; yuan: number; credits: number };

function tierVideoPayload(
  tiers: Tier[],
  extraParameters: Array<Record<string, unknown>> = [],
  base: { yuan: number; credits: number } = { yuan: 0.38, credits: 38 },
) {
  return {
    success: true,
    version: "tier-catalog",
    capability_version: "tier-capability",
    pricing_version: "tier-pricing",
    fetched_at: new Date(NOW).toISOString(),
    credits_per_yuan: 100,
    models: [
      {
        id: "private-tier-video",
        modality: "video",
        operation: "generate",
        input: { text: { required: true } },
        output: { type: "video", count: { fixed: 1 } },
        parameters: [
          { name: "model", type: "string", fixed: "private-tier-video" },
          { name: "prompt", type: "string", required: true, label: "提示词" },
          {
            name: "duration_seconds",
            type: "integer",
            default: 4,
            min: 4,
            max: 30,
            label: "时长（秒）",
          },
          ...extraParameters,
          {
            name: "resolution",
            type: "string",
            default: "720p",
            options: ["480p", "720p"],
            label: "分辨率",
          },
        ],
        public: { id: "tier-video", label: "双档视频" },
        selectable: true,
        endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
        pricing: {
          mode: "tiered",
          unit: "second",
          currency: "CNY",
          credits_per_yuan: 100,
          credits: base.credits,
          yuan: base.yuan,
          tiers,
        },
      },
    ],
  };
}

function quotesFor(payload: unknown) {
  const adapter = new WeftcanvasCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    now: () => NOW,
    fetch: async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"tier-catalog"' },
      }),
  });
  return new GenerationQuoteService(adapter, { now: () => NOW });
}

const standardTiers: Tier[] = [
  { when: { resolution: "480p" }, yuan: 0.28, credits: 28 },
  { when: { resolution: "720p" }, yuan: 0.38, credits: 38 },
];

describe("tiered video pricing by resolution", () => {
  it("bills 4 seconds of 480p and 720p at their own per-second rate", async () => {
    const quotes = quotesFor(tierVideoPayload(standardTiers));
    // 0.28 × 4 = 1.12 元 / 0.38 × 4 = 1.52 元。
    await expect(
      quotes.createQuote({
        modelId: "tier-video",
        modality: "video",
        parameters: { prompt: "测试", duration_seconds: 4, resolution: "480p" },
        inputs: {},
      }),
    ).resolves.toMatchObject({ credits: "112", yuan: "1.12" });
    await expect(
      quotes.createQuote({
        modelId: "tier-video",
        modality: "video",
        parameters: { prompt: "测试", duration_seconds: 4, resolution: "720p" },
        inputs: {},
      }),
    ).resolves.toMatchObject({ credits: "152", yuan: "1.52" });
  });

  it("never lets an unconditional tier swallow the resolution tiers", async () => {
    // 站点把基准价发布成无条件档（when: {}）且排在第一。它以前在 every() 下
    // 恒真，720p 的请求也按 0.28 结算——正是「全按 480 收费」的成因。
    const quotes = quotesFor(
      tierVideoPayload([
        { when: {}, yuan: 0.28, credits: 28 },
        { when: { resolution: "720p" }, yuan: 0.38, credits: 38 },
      ]),
    );
    await expect(
      quotes.createQuote({
        modelId: "tier-video",
        modality: "video",
        parameters: { prompt: "测试", duration_seconds: 4, resolution: "720p" },
        inputs: {},
      }),
    ).resolves.toMatchObject({ credits: "152" });
  });

  it("matches a tier written in a different letter case than the option", async () => {
    // 基准价是 480 档（站点常见写法：基准取最低档）。档位键写成 720P 而选项是
    // 720p 时，精确比较打不中任何档，旧逻辑会静默回落到基准价的 0.28。
    const quotes = quotesFor(
      tierVideoPayload(
        [
          { when: { resolution: "480P" }, yuan: 0.28, credits: 28 },
          { when: { resolution: "720P" }, yuan: 0.38, credits: 38 },
        ],
        [],
        { yuan: 0.28, credits: 28 },
      ),
    );
    await expect(
      quotes.createQuote({
        modelId: "tier-video",
        modality: "video",
        parameters: { prompt: "测试", duration_seconds: 4, resolution: "720p" },
        inputs: {},
      }),
    ).resolves.toMatchObject({ credits: "152" });
    await expect(
      quotes.createQuote({
        modelId: "tier-video",
        modality: "video",
        parameters: { prompt: "测试", duration_seconds: 4, resolution: "480p" },
        inputs: {},
      }),
    ).resolves.toMatchObject({ credits: "112" });
  });

  it("keeps an unconditional tier as the base price when nothing else matches", async () => {
    // 空条件档不参与命中，但仍然承担「这个模型的基准价」：目录只发布它、没有
    // baseCreditMicros 时不能变成报不出价。
    const quotes = quotesFor(
      tierVideoPayload([{ when: {}, yuan: 0.3, credits: 30 }], [], { yuan: 0.3, credits: 30 }),
    );
    await expect(
      quotes.createQuote({
        modelId: "tier-video",
        modality: "video",
        parameters: { prompt: "测试", duration_seconds: 4, resolution: "720p" },
        inputs: {},
      }),
    ).resolves.toMatchObject({ credits: "120" });
  });

  it("prefers the tier with more matched conditions over a broader one", async () => {
    const quotes = quotesFor(
      tierVideoPayload(
        [
          { when: { quality: "high" }, yuan: 0.4, credits: 40 },
          { when: { quality: "high", resolution: "720p" }, yuan: 0.5, credits: 50 },
        ],
        [
          {
            name: "quality",
            type: "string",
            default: "high",
            options: ["standard", "high"],
            label: "质量",
          },
        ],
      ),
    );
    await expect(
      quotes.createQuote({
        modelId: "tier-video",
        modality: "video",
        parameters: { prompt: "测试", duration_seconds: 4, resolution: "720p", quality: "high" },
        inputs: {},
      }),
    ).resolves.toMatchObject({ credits: "200" });
  });
});
