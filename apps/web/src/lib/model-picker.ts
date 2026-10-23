import type { AgentModel, PublicModel } from "@weftcanvas/contracts";

import { isCustomModelKey } from "./custom-api";

/**
 * 厂商口径与 API 侧 `agentTextModelGroup` 保持一致（GLM 归一个 tab、
 * DeepSeek 归一个 tab），这样节点里的文本模型选择器和 Agent 抽屉里的
 * 选择器就是同一套分类，而不是按「按次 / 按量」把同一家拆开。
 *
 * 规则按顺序匹配，先命中的优先；未知厂商落到「其他」。
 */
const VENDOR_RULES: ReadonlyArray<{ label: string; match: RegExp }> = [
  { label: "OpenAI", match: /gpt|^o[0-9]|全能模型|dall|openai|astra/i },
  { label: "Claude", match: /claude|anthropic/i },
  { label: "Gemini", match: /gemini|google/i },
  { label: "GLM", match: /glm|chatglm|智谱|zhipu/i },
  { label: "DeepSeek", match: /deepseek/i },
  { label: "Kimi", match: /kimi|moonshot/i },
  { label: "Minimax", match: /minimax|mini-?h3/i },
  { label: "Qwen", match: /qwen|通义/i },
  { label: "Grok", match: /grok|xai/i },
  { label: "混元", match: /hunyuan|^hy[0-9]|腾讯/i },
  { label: "小米", match: /mimo|xiaomi|小米/i },
];

export function modelVendorLabel(id: string, label = "") {
  const haystack = `${id} ${label}`.toLowerCase();
  return VENDOR_RULES.find((rule) => rule.match.test(haystack))?.label ?? "其他";
}

function formatCredits(value: number) {
  return String(Number(value.toFixed(4)));
}

/**
 * 文本模型的展示价：
 * - 按量模型给「输入/输出 积分 · 每M」，和 Agent 选择器一致；
 * - 按次模型给「x 积分/次」；
 * - 目录没有费率时退回「按 Token 计费」，不再留空。
 */
export function textModelPriceLabel(model: PublicModel) {
  if (isCustomModelKey(model.id)) return "自有 API";
  const pricing = model.pricing;
  if (pricing.mode === "token" || pricing.unit === "token") {
    const perMillion = (credits: number | undefined, yuan: number | undefined) => {
      if (credits !== undefined) return credits / 1_000_000;
      if (yuan !== undefined) return (yuan / 1_000_000) * pricing.creditsPerYuan;
      return null;
    };
    const input = perMillion(
      pricing.inputCreditMicrosPerMillion,
      pricing.inputYuanMicrosPerMillion,
    );
    const output = perMillion(
      pricing.outputCreditMicrosPerMillion,
      pricing.outputYuanMicrosPerMillion,
    );
    if (input === null && output === null) return "按 Token 计费";
    return `${input === null ? "—" : formatCredits(input)}/${output === null ? "—" : formatCredits(output)} 积分 · 每M`;
  }

  const parameters = Object.fromEntries(
    model.parameters.flatMap((parameter) => {
      const value = parameter.fixed ?? parameter.default;
      return value === undefined ? [] : [[parameter.name, value]];
    }),
  );
  const tier = pricing.tiers.find((candidate) =>
    Object.entries(candidate.when).every(
      ([name, value]) => JSON.stringify(parameters[name]) === JSON.stringify(value),
    ),
  );
  const micros =
    tier?.creditMicros ?? pricing.baseCreditMicros ?? tier?.yuanMicros ?? pricing.baseYuanMicros;
  if (micros === undefined) return "按参数计费";
  const credits = micros / 1_000_000;
  return `${Number.isInteger(credits) ? credits : Number(credits.toFixed(4))} 积分/次`;
}

/**
 * 把模型目录条目投影成 Agent 选择器要的形状：厂商分组 + 价格标签 + 计费方式。
 * 这样节点里的文本模型选择器可以直接复用 Agent 的同款下拉面板（厂商 tab +
 * 双列模型列表 + 价格），不用再维护第二套 UI。
 */
export function publicModelPickerModels(models: PublicModel[]): AgentModel[] {
  return models.map((model) => {
    const custom = isCustomModelKey(model.id);
    const billing: AgentModel["billing"] =
      !custom && (model.pricing.mode === "token" || model.pricing.unit === "token")
        ? "token"
        : "request";
    return {
      id: model.id,
      label: model.label,
      group: custom ? "自有 API" : modelVendorLabel(model.id, model.label),
      meta: textModelPriceLabel(model),
      billing,
      detail: model.description.slice(0, 240) || undefined,
    };
  });
}
