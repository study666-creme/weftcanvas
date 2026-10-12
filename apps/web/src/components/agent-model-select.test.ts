import { describe, expect, it } from "vitest";

import type { AgentModel } from "@weftcanvas/contracts";

import { agentModelVendorGroups } from "./agent-model-select";

function model(
  id: string,
  label: string,
  group?: string,
  billing?: AgentModel["billing"],
): AgentModel {
  return {
    id,
    label,
    meta: "2 积分/次",
    ...(group ? { group } : {}),
    ...(billing ? { billing } : {}),
  };
}

describe("agent model vendor groups", () => {
  // 用户明确要求：GLM 放一起、DeepSeek 放一起——分类口径是厂商，不是计费方式。
  const catalog = [
    model("glm-5.1", "GLM-5.1", "GLM", "request"),
    model("glm-5.3", "GLM-5.3", "GLM", "token"),
    model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "DeepSeek", "request"),
    model("deepseek-v4-pro-0813", "DeepSeek V4 Pro 0813", "DeepSeek", "request"),
    model("gemini-3.7-flash", "Gemini 3.7 Flash", "Gemini", "request"),
    model("gemini-3.8-flash", "Gemini 3.8 Flash", "Gemini", "request"),
    model("claude-sonnet-5", "Claude Sonnet 5", "Claude", "token"),
    model("mystery", "Mystery Model", undefined, "request"),
  ];

  it("keeps one tab per vendor, with GLM and DeepSeek each whole", () => {
    const groups = agentModelVendorGroups(catalog);
    expect(groups.map((group) => group.label)).toEqual([
      "GLM",
      "DeepSeek",
      "Gemini",
      "Claude",
      "其他",
    ]);
    expect(groups[0]!.models.map((item) => item.id)).toEqual(["glm-5.1", "glm-5.3"]);
    expect(groups[1]!.models.map((item) => item.id)).toEqual([
      "deepseek-v4.1-flash",
      "deepseek-v4-pro-0813",
    ]);
  });

  it("sorts per-request models above token-priced ones inside a vendor tab", () => {
    const groups = agentModelVendorGroups(catalog);
    const glm = groups.find((group) => group.label === "GLM")!;
    expect(glm.models.map((item) => item.id)).toEqual(["glm-5.1", "glm-5.3"]);
  });

  it("keeps models without vendor metadata in a trailing 其他 tab", () => {
    const groups = agentModelVendorGroups(catalog);
    expect(groups.at(-1)!.label).toBe("其他");
    expect(groups.at(-1)!.models.map((item) => item.id)).toEqual(["mystery"]);
  });

  it("never drops a model, even when groups are missing entirely", () => {
    const anonymous = [model("a", "A"), model("b", "B")];
    const groups = agentModelVendorGroups(anonymous);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.models.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
