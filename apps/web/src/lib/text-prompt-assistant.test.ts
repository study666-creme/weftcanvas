import type { PublicModel } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import {
  composeTextPromptTask,
  describeTextAssistantFailure,
  resolveTextPromptModel,
} from "./text-prompt-assistant";

function model(id: string, modality: PublicModel["modality"]): PublicModel {
  return {
    id,
    label: id,
    description: "",
    modality,
    operation: "chat",
    order: 0,
    input: { textRequired: true, images: { min: 0, max: 0, multiple: false } },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: [],
    pricing: {
      mode: "token",
      unit: "token",
      currency: "CNY",
      creditsPerYuan: 100,
      inputCreditMicrosPerMillion: 1,
      outputCreditMicrosPerMillion: 1,
      tiers: [],
    },
  } as PublicModel;
}

describe("composeTextPromptTask", () => {
  it("wraps the source prompt in an optimization instruction", () => {
    const prompt = composeTextPromptTask("optimize", "一只坐在窗边的猫");
    expect(prompt).toContain("优化下面这段提示词");
    expect(prompt).toContain("一只坐在窗边的猫");
    expect(prompt).toContain("只输出优化后的提示词正文");
  });

  it("asks for a generation prompt derived from creative text", () => {
    const prompt = composeTextPromptTask("derive", "少年在雨夜的电车上遇见一只会说话的鲸鱼");
    expect(prompt).toContain("提炼一条可直接用于 AI 图片或视频生成的提示词");
    expect(prompt).toContain("少年在雨夜的电车上遇见一只会说话的鲸鱼");
    expect(prompt).toContain("只输出一条提示词正文");
  });

  it("returns an empty instruction when the node has no text", () => {
    expect(composeTextPromptTask("optimize", "   ")).toBe("");
    expect(composeTextPromptTask("derive", "\n\t ")).toBe("");
  });
});

describe("resolveTextPromptModel", () => {
  const models = [model("image-model", "image"), model("text-a", "text"), model("text-b", "text")];

  it("prefers the node's explicit text model", () => {
    expect(resolveTextPromptModel(models, "text-b", "text-a")?.id).toBe("text-b");
  });

  it("falls back to the remembered text model, then the first text model", () => {
    expect(resolveTextPromptModel(models, "missing", "text-b")?.id).toBe("text-b");
    expect(resolveTextPromptModel(models, null, null)?.id).toBe("text-a");
  });

  it("never resolves a non-text model", () => {
    expect(resolveTextPromptModel([model("image-model", "image")], "image-model", null)).toBeNull();
    expect(resolveTextPromptModel([], "text-a", "text-b")).toBeNull();
  });
});

describe("describeTextAssistantFailure", () => {
  it("通道不支持文本时给出可执行的下一步，而不是原样丢回接口错误", () => {
    const cause = Object.assign(new Error("当前账号通道暂不支持这个模型类型"), {
      code: "MODEL_MODALITY_UNAVAILABLE",
    });
    expect(describeTextAssistantFailure(cause, "x")).toContain("Agent");
    expect(describeTextAssistantFailure(cause, "x")).not.toContain("当前账号通道暂不支持");
  });

  it("其他失败保留接口原文，认不出类型才用兜底", () => {
    expect(describeTextAssistantFailure(new Error("积分不足"), "x")).toBe("积分不足");
    expect(describeTextAssistantFailure("boom", "兜底文案")).toBe("兜底文案");
  });
});
