import { describe, expect, it } from "vitest";

import { readCanvasApiProviderName, resolveProviderPlan } from "./assembly.js";

describe("provider name", () => {
  it("accepts the declared names and defaults to auto", () => {
    expect(readCanvasApiProviderName(undefined)).toBe("auto");
    expect(readCanvasApiProviderName("dev-test")).toBe("dev-test");
    expect(readCanvasApiProviderName(" weftcanvas ")).toBe("weftcanvas");
    expect(readCanvasApiProviderName("auto")).toBe("auto");
  });

  it("rejects unknown provider names instead of guessing", () => {
    expect(() => readCanvasApiProviderName("openai")).toThrow(/CANVAS_API_PROVIDER/);
    expect(readCanvasApiProviderName("")).toBe("auto");
  });
});

describe("provider plan", () => {
  it("resolves dev-test with no endpoint defaults", async () => {
    const plan = await resolveProviderPlan({ CANVAS_API_PROVIDER: "dev-test" });
    expect(plan.providerName).toBe("dev-test");
    expect(plan.catalogSourceUrl).toBeUndefined();
    expect(plan.catalogVideoInventoryUrl).toBeUndefined();
    expect(plan.stationPricingUrl).toBeUndefined();
    expect(plan.weftcanvas).toBeNull();
  });

  it("lets dev-test self-hosters point at their own gateway", async () => {
    const plan = await resolveProviderPlan({
      CANVAS_API_PROVIDER: "dev-test",
      CATALOG_SOURCE_URL: "https://models.example.internal/api/catalog",
      WEFTCANVAS_PRICING_URL: "https://models.example.internal/api/pricing",
    });
    expect(plan.catalogSourceUrl).toBe("https://models.example.internal/api/catalog");
    expect(plan.stationPricingUrl).toBe("https://models.example.internal/api/pricing");
  });

  it("accepts the neutral CANVAS_UPSTREAM_* names for a third-party upstream", async () => {
    // 第三方中转站/自托管接入时不该被迫使用别家的品牌名（PROMPT_HUB_*/WEFTCANVAS_*）。
    const plan = await resolveProviderPlan({
      CANVAS_API_PROVIDER: "dev-test",
      CANVAS_UPSTREAM_CATALOG_URL: "https://relay.example.com/api/model-catalog",
      CANVAS_UPSTREAM_PRICING_URL: "https://relay.example.com/api/pricing",
      CANVAS_UPSTREAM_VIDEO_INVENTORY_URL: "https://relay.example.com/api/video-inventory",
    });
    expect(plan.catalogSourceUrl).toBe("https://relay.example.com/api/model-catalog");
    expect(plan.stationPricingUrl).toBe("https://relay.example.com/api/pricing");
    expect(plan.catalogVideoInventoryUrl).toBe("https://relay.example.com/api/video-inventory");
  });

  it("prefers the neutral name when both the new and legacy keys are set", async () => {
    const plan = await resolveProviderPlan({
      CANVAS_API_PROVIDER: "dev-test",
      CANVAS_UPSTREAM_CATALOG_URL: "https://new.example.com/api/catalog",
      CATALOG_SOURCE_URL: "https://legacy.example.com/api/catalog",
      WEFTCANVAS_CATALOG_URL: "https://legacy2.example.com/api/catalog",
    });
    expect(plan.catalogSourceUrl).toBe("https://new.example.com/api/catalog");
  });

  it("treats a blank neutral value as unset and falls back to the legacy key", async () => {
    const plan = await resolveProviderPlan({
      CANVAS_API_PROVIDER: "dev-test",
      CANVAS_UPSTREAM_CATALOG_URL: "   ",
      CATALOG_SOURCE_URL: "https://legacy.example.com/api/catalog",
    });
    expect(plan.catalogSourceUrl).toBe("https://legacy.example.com/api/catalog");
  });

  it("resolves auto to dev-test when no hosted credentials exist", async () => {
    const plan = await resolveProviderPlan({});
    expect(plan.providerName).toBe("dev-test");
    expect(plan.weftcanvas).toBeNull();
  });

  // weftcanvas 私有模块存在时的装配断言（auto→weftcanvas、IDENTITY_PROVIDER 别名）
  // 在 weftcanvas-assembly.test.ts——公开树不含私有 overlay，点名 weftcanvas 时
  // resolveProviderPlan 会给出明确的"私有 overlay 缺失"错误。

  it("refuses production auto without an explicit choice", async () => {
    await expect(resolveProviderPlan({ NODE_ENV: "production" })).rejects.toThrow(
      /CANVAS_API_PROVIDER=dev-test/,
    );
  });
});
