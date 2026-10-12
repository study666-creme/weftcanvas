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
