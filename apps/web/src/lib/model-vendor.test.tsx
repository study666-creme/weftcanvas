import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModelVendorIcon } from "../components/model-vendor-icon";
import { MODEL_VENDOR_GLYPHS } from "./model-vendor-glyphs";
import { GENERIC_VENDOR, MODEL_VENDORS, modelVendorOf } from "./model-vendor";

describe("model vendor registry", () => {
  it("认得了 API 目录里所有已知厂商（id / 展示名 / group 三种入口）", () => {
    expect(modelVendorOf("glm-5.1", "GLM-5.1", "GLM").key).toBe("glm");
    expect(modelVendorOf("deepseek-v4.1-flash").key).toBe("deepseek");
    expect(modelVendorOf("gemini-3.7-flash").key).toBe("gemini");
    expect(modelVendorOf("claude-sonnet-5").key).toBe("claude");
    // group 字段单独喂进来也要认得（文本节点走的是 modelVendorLabel(id, label)）
    expect(modelVendorOf("", "", "Anthropic").key).toBe("claude");
    expect(modelVendorOf("", "", "智谱").key).toBe("glm");
    expect(modelVendorOf("", "", "混元").key).toBe("hunyuan");
    expect(modelVendorOf("", "", "小米").key).toBe("xiaomi");
    expect(modelVendorOf("o3-mini").key).toBe("openai");
    expect(modelVendorOf("gpt-6-astra").key).toBe("openai");
    expect(modelVendorOf("kimi-k3").key).toBe("kimi");
    expect(modelVendorOf("minimax-h3").key).toBe("minimax");
    expect(modelVendorOf("qwen-max").key).toBe("qwen");
    expect(modelVendorOf("grok-5").key).toBe("grok");
  });

  it("用户自带 key 的模型单独给钥匙图标，未知厂商落到通用兜底", () => {
    expect(modelVendorOf("", "", "自有 API").key).toBe("custom");
    expect(modelVendorOf("custom:p1:text:my-model").key).toBe("custom");
    expect(modelVendorOf("mystery-model", "Mystery Model").key).toBe(GENERIC_VENDOR.key);
  });

  it("每个厂商都配了商标路径，key 不与兜底重复", () => {
    const keys = new Set<string>();
    for (const vendor of MODEL_VENDORS) {
      expect(vendor.brand).toMatch(/^#[0-9a-f]{6}$/i);
      expect(vendor.match).toBeInstanceOf(RegExp);
      expect(keys.has(vendor.key)).toBe(false);
      keys.add(vendor.key);
      if (vendor.key === "custom") continue;
      // custom / generic 走线性兜底图标，其余厂商必须有真商标
      expect(MODEL_VENDOR_GLYPHS[vendor.key as keyof typeof MODEL_VENDOR_GLYPHS]).toBeTruthy();
    }
    expect(keys.has(GENERIC_VENDOR.key)).toBe(false);
  });
});

describe("ModelVendorIcon", () => {
  it("渲染真商标路径 + 品牌色变量，纯装饰不进无障碍树", () => {
    const markup = renderToStaticMarkup(<ModelVendorIcon vendor="deepseek" tile />);
    expect(markup).toContain('data-vendor="deepseek"');
    expect(markup).toContain("wc-vendor-icon--tile");
    expect(markup).toContain("--wc-vendor-brand:#4d6bfe");
    expect(markup).toContain("<path");
    expect(markup).toContain('aria-hidden="true"');
  });

  it("没有商标的厂商退回线性图标（不留空盒子）", () => {
    const markup = renderToStaticMarkup(<ModelVendorIcon vendor="generic" />);
    expect(markup).toContain("wc-vendor-icon-fallback");
    // 实心商标用 fill=currentColor 的单条 path，线性兜底图标没有这层填充
    expect(markup).not.toContain('fill="currentColor"');
  });
});
