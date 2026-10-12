import { describe, expect, it } from "vitest";

import { AgentModelRegistry } from "./models.js";

describe("AgentModelRegistry", () => {
  it("opens the allowlist by default so the platform catalog decides inventory", () => {
    const registry = new AgentModelRegistry("gpt-5-mini", undefined);

    expect(registry.getCatalog()).toEqual({
      defaultModelId: "gpt-5-mini",
      models: [{ id: "gpt-5-mini", label: "GPT-5 Mini" }],
    });
    expect(registry.allows("glm-5.1")).toBe(true);
    expect(registry.allows("kimi-k3")).toBe(true);
    expect(registry.allows("not a model id")).toBe(false);
  });

  it("treats an explicit * as open mode", () => {
    const registry = new AgentModelRegistry("gpt-5-mini", " * ");

    expect(registry.allows("deepseek-v4-pro-0813")).toBe(true);
  });

  it("enforces a strict allowlist when one is configured", () => {
    const registry = new AgentModelRegistry("gpt-5-mini", "gpt-5-mini,gpt-5.4");

    expect(registry.getCatalog().models.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "gpt-5.4",
    ]);
    expect(registry.allows("gpt-5.4")).toBe(true);
    expect(registry.allows("glm-5.1")).toBe(false);
  });
});
