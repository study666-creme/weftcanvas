import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { KachangCatalogAdapter } from "./adapter.js";
import {
  applyModelOverrides,
  JsonModelOverrideStore,
  MemoryModelOverrideStore,
  modelOverridesSchema,
  type ModelOverrides,
} from "./overrides.js";
import { GenerationQuoteService } from "./quote.js";
import { buildNonMjSourceCatalog, NON_MJ_NOW_ISO } from "./nonmj-catalog-fixture.js";
import { MemoryCatalogSnapshotStore } from "./store.js";

const NOW = Date.parse(NON_MJ_NOW_ISO);

function createAdapter(store: MemoryModelOverrideStore) {
  return new KachangCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    includeKnownModels: true,
    overrides: store,
    now: () => NOW,
    fetch: async () => new Response(JSON.stringify(buildNonMjSourceCatalog()), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"overrides-1"' },
    }),
  });
}

describe("model overrides", () => {
  it("hides a model and reprices another without touching the cached snapshot", async () => {
    const adapter = createAdapter(new MemoryModelOverrideStore({
      models: {
        "image2-A": { hidden: true },
        "nano-banana-pro": { price: { yuan: 0.1 } },
      },
    }));

    const catalog = await adapter.getCatalog();
    expect(catalog.models.some((model) => model.id === "image2-A")).toBe(false);
    const pro = catalog.models.find((model) => model.id === "nano-banana-pro")!;
    expect(pro.pricing.baseYuanMicros).toBe(100_000);
    expect(pro.pricing.baseCreditMicros).toBe(10_000_000);
    expect(pro.pricing.mode).toBe("fixed");
    expect(catalog.pricingVersion.startsWith("overrides:")).toBe(true);
    // A hidden model is still quotable on an existing node: getModel reads the
    // overridden catalog, so it must report the model as unavailable.
    expect(await adapter.getModel("image2-A")).toBeNull();

    // The admin read bypasses overrides so hidden models can be un-hidden.
    const raw = await adapter.getCatalog({ includeOverrides: false });
    expect(raw.models.some((model) => model.id === "image2-A")).toBe(true);
    expect(raw.models.find((model) => model.id === "nano-banana-pro")!.pricing.baseYuanMicros).not.toBe(100_000);
    expect(raw.pricingVersion.startsWith("overrides:")).toBe(false);
  });

  it("applies per-resolution prices as tiers and keeps untouched models intact", () => {    const catalog = {
      version: "v1",
      capabilityVersion: "c1",
      pricingVersion: "upstream-1",
      fetchedAt: NOW_ISO(),
      expiresAt: NOW_ISO(),
      quoteAvailable: true,
      models: [{
        id: "nano-banana-2-a",
        label: "Nano Banana 2",
        description: "",
        modality: "image" as const,
        operation: "generate",
        order: 10,
        input: {},
        output: { type: "image" as const, minCount: 1, maxCount: 1 },
        parameters: [],
        pricing: {
          mode: "fixed" as const,
          unit: "image" as const,
          currency: "CNY" as const,
          creditsPerYuan: 100,
          baseYuanMicros: 60_000,
          baseCreditMicros: 6_000_000,
          tiers: [],
        },
      }],
    };
    const overridden = applyModelOverrides(catalog as never, {
      models: { "nano-banana-2-a": { price: { byResolution: { "1k": 0.08, "2k": 0.09 } } } },
    });
    const model = overridden.models[0]!;
    expect(model.pricing.mode).toBe("tiered");
    expect(model.pricing.tiers).toEqual([
      { when: { resolution: "1k" }, yuanMicros: 80_000, creditMicros: 8_000_000 },
      { when: { resolution: "2k" }, yuanMicros: 90_000, creditMicros: 9_000_000 },
    ]);
    expect(overridden.pricingVersion.startsWith("overrides:")).toBe(true);
  });

  it("reprices a token model by overriding its per-million rates", () => {
    const catalog = {
      version: "v1",
      capabilityVersion: "c1",
      pricingVersion: "upstream-1",
      fetchedAt: NOW_ISO(),
      expiresAt: NOW_ISO(),
      quoteAvailable: true,
      models: [{
        id: "gpt-5.6",
        label: "GPT-5.6",
        description: "",
        modality: "text" as const,
        operation: "chat",
        order: 10,
        input: {},
        output: { type: "text" as const, minCount: 1, maxCount: 1 },
        parameters: [],
        pricing: {
          mode: "token" as const,
          unit: "token" as const,
          currency: "CNY" as const,
          creditsPerYuan: 100,
          tiers: [],
          inputYuanMicrosPerMillion: 500_000,
          outputYuanMicrosPerMillion: 3_000_000,
          inputCreditMicrosPerMillion: 50_000_000,
          outputCreditMicrosPerMillion: 300_000_000,
        },
      }],
    };

    const overridden = applyModelOverrides(catalog as never, {
      models: { "gpt-5.6": { price: { inputYuanPerMillion: 0.3 } } },
    });

    const pricing = overridden.models[0]!.pricing;
    expect(pricing.mode).toBe("token");
    // 只覆盖输入费率时，输出费率保持上游值。
    expect(pricing.inputYuanMicrosPerMillion).toBe(300_000);
    expect(pricing.inputCreditMicrosPerMillion).toBe(30_000_000);
    expect(pricing.outputYuanMicrosPerMillion).toBe(3_000_000);
    expect(overridden.pricingVersion.startsWith("overrides:")).toBe(true);
  });

  it("ignores a request-price override on a token model and vice versa", () => {
    const tokenCatalog = {
      version: "v1", capabilityVersion: "c1", pricingVersion: "upstream-1",
      fetchedAt: NOW_ISO(), expiresAt: NOW_ISO(), quoteAvailable: true,
      models: [{
        id: "gpt-5.6", label: "GPT-5.6", description: "", modality: "text" as const, operation: "chat", order: 10,
        input: {}, output: { type: "text" as const, minCount: 1, maxCount: 1 }, parameters: [],
        pricing: {
          mode: "token" as const, unit: "token" as const, currency: "CNY" as const, creditsPerYuan: 100,
          tiers: [], inputYuanMicrosPerMillion: 500_000, outputYuanMicrosPerMillion: 3_000_000,
        },
      }],
    };
    const requestPriced = applyModelOverrides(tokenCatalog as never, {
      models: { "gpt-5.6": { price: { yuan: 0.02 } } },
    });
    expect(requestPriced.models[0]!.pricing.mode).toBe("token");
    expect(requestPriced.models[0]!.pricing.inputYuanMicrosPerMillion).toBe(500_000);
    expect(requestPriced.pricingVersion).toBe("upstream-1");

    const fixedCatalog = {
      ...tokenCatalog,
      models: [{
        ...tokenCatalog.models[0],
        pricing: { mode: "fixed" as const, unit: "request" as const, currency: "CNY" as const, creditsPerYuan: 100, baseYuanMicros: 10_000, baseCreditMicros: 1_000_000, tiers: [] },
      }],
    };
    const tokenOverridden = applyModelOverrides(fixedCatalog as never, {
      models: { "gpt-5.6": { price: { inputYuanPerMillion: 1 } } },
    });
    expect(tokenOverridden.models[0]!.pricing.mode).toBe("fixed");
    expect(tokenOverridden.models[0]!.pricing.baseYuanMicros).toBe(10_000);
    expect(tokenOverridden.pricingVersion).toBe("upstream-1");
  });

  it("keeps the upstream pricing version for visibility-only edits", () => {
    const catalog = {
      version: "v1",
      capabilityVersion: "c1",
      pricingVersion: "upstream-1",
      fetchedAt: NOW_ISO(),
      expiresAt: NOW_ISO(),
      quoteAvailable: true,
      models: [],
    };
    const overridden = applyModelOverrides(catalog as never, { models: { "image2-A": { hidden: true } } });
    expect(overridden.pricingVersion).toBe("upstream-1");
  });

  it("renames display copy and assigns the promo zone without touching routing or pricing", () => {
    const catalog = {
      version: "v1",
      capabilityVersion: "c1",
      pricingVersion: "upstream-1",
      fetchedAt: NOW_ISO(),
      expiresAt: NOW_ISO(),
      quoteAvailable: true,
      models: [{
        id: "veo-3.1-fast-flex",
        label: "Veo 3.1 Fast",
        description: "Google Veo 3.1 生成 8 秒 720p 视频",
        modality: "video" as const,
        operation: "generate-video",
        order: 10,
        input: {},
        output: { type: "video" as const, minCount: 1, maxCount: 1 },
        parameters: [],
        pricing: {
          mode: "fixed" as const,
          unit: "request" as const,
          currency: "CNY" as const,
          creditsPerYuan: 100,
          baseYuanMicros: 35_000,
          baseCreditMicros: 3_500_000,
          tiers: [],
        },
      }],
    };

    const overridden = applyModelOverrides(catalog as never, {
      models: {
        "veo-3.1-fast-flex": {
          displayName: "跃动视频 Pro",
          description: "8 秒 720p 视频，镜头感强。",
          zone: "promo",
        },
      },
    });

    const model = overridden.models[0]!;
    expect(model.label).toBe("跃动视频 Pro");
    expect(model.description).toBe("8 秒 720p 视频，镜头感强。");
    expect(model.zone).toBe("promo");
    // 改名/分区不改价：路由 id 与上游价格原样保留。
    expect(model.id).toBe("veo-3.1-fast-flex");
    expect(model.pricing.baseYuanMicros).toBe(35_000);
    expect(overridden.pricingVersion).toBe("upstream-1");
  });

  it("round-trips through the file store and rejects malformed input", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/canvas-overrides-${process.pid}-${Date.now()}.json`;
    const store = new JsonModelOverrideStore(path);
    expect(await store.load()).toEqual({ models: {} });
    const value: ModelOverrides = { models: { "image2-A": { hidden: true, price: { yuan: 0.5 } } } };
    await store.save(value);
    expect(await new JsonModelOverrideStore(path).load()).toEqual(value);
    expect(() => modelOverridesSchema.parse({ models: { "image2-A": { price: {} } } })).toThrow();
    expect(() => modelOverridesSchema.parse({ models: { "image2-A": { unknown: true } } })).toThrow();
    expect(() => modelOverridesSchema.parse({ models: { "image2-A": { zone: "cheap" } } })).toThrow();
  });

  it("serves the admin override API only behind the shared secret", async () => {
    const store = new MemoryModelOverrideStore();
    const adapter = createAdapter(store);
    const app = createApiApp({
      catalog: adapter,
      quotes: new GenerationQuoteService(adapter, { now: () => NOW }),
      modelOverrides: store,
      modelOverridesAdminSecret: "s3cret",
    });

    expect((await app.request("/api/v1/admin/model-overrides")).status).toBe(404);
    expect((await app.request("/api/v1/admin/model-overrides", { headers: { "x-model-overrides-secret": "wrong" } })).status).toBe(404);

    const listed = await app.request("/api/v1/admin/model-overrides", { headers: { "x-model-overrides-secret": "s3cret" } });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { data: { models: Array<{ id: string; hidden: boolean }> } };
    expect(listedBody.data.models.some((model) => model.id === "image2-A")).toBe(true);

    const put = await app.request("/api/v1/admin/model-overrides", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-model-overrides-secret": "s3cret" },
      body: JSON.stringify({ models: { "image2-A": { hidden: true } } }),
    });
    expect(put.status).toBe(200);
    const applied = await adapter.getCatalog();
    expect(applied.models.some((model) => model.id === "image2-A")).toBe(false);
  });

  it("accepts and persists token rate overrides through the admin API", async () => {
    const store = new MemoryModelOverrideStore();
    const adapter = createAdapter(store);
    const app = createApiApp({
      catalog: adapter,
      quotes: new GenerationQuoteService(adapter, { now: () => NOW }),
      modelOverrides: store,
      modelOverridesAdminSecret: "s3cret",
    });

    const rejected = await app.request("/api/v1/admin/model-overrides", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-model-overrides-secret": "s3cret" },
      body: JSON.stringify({ models: { "gpt-5.6": { price: {} } } }),
    });
    expect(rejected.status).toBe(422);

    const put = await app.request("/api/v1/admin/model-overrides", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-model-overrides-secret": "s3cret" },
      body: JSON.stringify({
        models: { "gpt-5.6": { price: { inputYuanPerMillion: 0.3, outputYuanPerMillion: 0.9 } } },
      }),
    });
    expect(put.status).toBe(200);
    const stored = await store.load();
    expect(stored.models["gpt-5.6"]?.price).toEqual({ inputYuanPerMillion: 0.3, outputYuanPerMillion: 0.9 });
  });

  it("lets only the configured consoles frame the override admin page", async () => {
    const store = new MemoryModelOverrideStore();
    const previous = process.env.MODEL_OVERRIDES_FRAME_ANCESTORS;
    process.env.MODEL_OVERRIDES_FRAME_ANCESTORS = "https://console.example.com";
    try {
      const app = createApiApp({
        catalog: createAdapter(store),
        quotes: new GenerationQuoteService(createAdapter(store), { now: () => NOW }),
        modelOverrides: store,
        modelOverridesAdminSecret: "s3cret",
      });

      // 运营控制台的画布模型 tab 嵌这个页；一刀切 DENY 会让它渲染空白。
      // 允许名单完全来自环境变量，其它路由保持 deny-everything 默认。
      const page = await app.request("/admin/model-overrides");
      expect(page.status).toBe(200);
      expect(page.headers.get("x-frame-options")).toBeNull();
      expect(page.headers.get("content-security-policy")).toBe(
        "frame-ancestors https://console.example.com",
      );

      const other = await app.request("/api/v1/model-catalog");
      expect(other.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      if (previous === undefined) delete process.env.MODEL_OVERRIDES_FRAME_ANCESTORS;
      else process.env.MODEL_OVERRIDES_FRAME_ANCESTORS = previous;
    }
  });
});

function NOW_ISO() {
  return new Date(NOW).toISOString();
}
