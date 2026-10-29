import type { ModelVendorGlyphKey } from "./model-vendor-glyphs";

/**
 * 厂商口径的唯一事实来源：分组标签（模型选择器的 tab 名）、商标图标、品牌色。
 *
 * 标签与 API 侧 `agentTextModelGroup` 保持一致（GLM 归一个 tab、DeepSeek 归一个
 * tab），规则按顺序匹配、先命中的优先，未知厂商落到「其他」。新增厂商只要在
 * 这里补一条 + 去 lib/model-vendor-glyphs.ts 贴一张 24×24 的 path，选择器、
 * 分组、图标会一起生效。
 */
export type ModelVendorKey = ModelVendorGlyphKey | "custom" | "generic";

export type ModelVendor = {
  key: ModelVendorKey;
  /** 选择器 tab 与分组用的标签。 */
  label: string;
  /** 商标主色：只用来铺柔和底色、并和正文色混出自动对比的图标色。 */
  brand: string;
  match: RegExp;
};

export const MODEL_VENDORS: readonly ModelVendor[] = [
  {
    key: "openai",
    label: "OpenAI",
    brand: "#0e9f6e",
    match: /gpt|^o[0-9]|全能模型|dall|openai|astra/i,
  },
  { key: "claude", label: "Claude", brand: "#c96442", match: /claude|anthropic/i },
  { key: "gemini", label: "Gemini", brand: "#3b82f6", match: /gemini|google/i },
  { key: "glm", label: "GLM", brand: "#3355ff", match: /glm|chatglm|智谱|zhipu/i },
  { key: "deepseek", label: "DeepSeek", brand: "#4d6bfe", match: /deepseek/i },
  { key: "kimi", label: "Kimi", brand: "#3b3b45", match: /kimi|moonshot/i },
  { key: "minimax", label: "Minimax", brand: "#e8503a", match: /minimax|mini-?h3/i },
  { key: "qwen", label: "Qwen", brand: "#615ced", match: /qwen|通义|千问/i },
  { key: "grok", label: "Grok", brand: "#24262b", match: /grok|xai|x\.ai/i },
  { key: "hunyuan", label: "混元", brand: "#0052d9", match: /hunyuan|^hy[0-9]|腾讯|混元/i },
  { key: "xiaomi", label: "小米", brand: "#ff6900", match: /mimo|xiaomi|小米/i },
  // 用户自带 key 的模型没有厂商可比，单独一个钥匙图标；「其他」用兜底星标。
  { key: "custom", label: "自有 API", brand: "#5b6470", match: /自有\s*api|^custom:/i },
];

/** 未知厂商的兜底：标签固定「其他」，图标退回通用星标。 */
export const GENERIC_VENDOR: ModelVendor = {
  key: "generic",
  label: "其他",
  brand: "#8a8f98",
  match: /$^/,
};

const BY_KEY = new Map<ModelVendorKey, ModelVendor>(
  [...MODEL_VENDORS, GENERIC_VENDOR].map((vendor) => [vendor.key, vendor]),
);

export function modelVendorByKey(key: ModelVendorKey): ModelVendor {
  return BY_KEY.get(key) ?? GENERIC_VENDOR;
}

/**
 * 从任意文本里认厂商：模型 id、展示名、API 的 group 字段都行。
 * 参数顺序有讲究——id 放第一个，`^o[0-9]` 这种按串首匹配的规则才认得 o1/o3。
 */
export function modelVendorOf(...parts: Array<string | null | undefined>): ModelVendor {
  const haystack = parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!haystack) return GENERIC_VENDOR;
  return MODEL_VENDORS.find((vendor) => vendor.match.test(haystack)) ?? GENERIC_VENDOR;
}

/** 只要分组标签时用这个（与历史 `modelVendorLabel` 行为一致）。 */
export function modelVendorLabelOf(id: string, label = ""): string {
  return modelVendorOf(id, label).label;
}
