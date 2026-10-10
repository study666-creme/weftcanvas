import type { PublicModel } from "@kachang/contracts";
import { z } from "zod";

import type { ModelOverrides } from "../catalog/overrides.js";

/** Agent 默认按次价：2 分钱一次对话 = 2 积分（管理员可在模型后台改价）。 */
export const AGENT_DEFAULT_REQUEST_PRICE_YUAN = 0.02;

/**
 * 厂商系列按次零售价（运营口径 2026-10-01）：Claude 系列一律 0.4 元/次
 * （40 积分），Gemini Pro 系列 0.1 元/次（10 积分），其余按次文本模型维持
 * 默认价。后台改价（model-overrides）仍然优先于这套规则。
 */
export function agentRequestPriceYuan(
  model: { id: string; label?: string },
  overrideYuan?: number,
): number {
  if (overrideYuan != null) return overrideYuan;
  const haystack = `${model.id} ${model.label ?? ""}`.toLowerCase();
  if (haystack.includes("claude")) return 0.4;
  if (haystack.includes("gemini") && haystack.includes("pro")) return 0.1;
  return AGENT_DEFAULT_REQUEST_PRICE_YUAN;
}

export type AgentTextModel = {
  id: string;
  label: string;
  description?: string;
  group?: string;
  meta: string;
  billing: "request" | "token";
  thinking?: { levels: string[]; default: string };
};

/**
 * 与模型广场一致的厂商口径：同名厂商的模型归进同一个分类标签（GLM 放一起、
 * DeepSeek 放一起），而不是按「按次 / 按量」把同一家模型拆到不同分类里。
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

export function agentTextModelGroup(haystack: string) {
  const text = haystack.toLowerCase();
  return VENDOR_RULES.find((rule) => rule.match.test(text))?.label ?? "其他";
}

/** 从目录参数里读出模型支持的思考强度档位（reasoning_effort）。 */
export function agentThinkingFromParameters(
  parameters: ReadonlyArray<{ name: string; options?: readonly unknown[]; default?: unknown }>,
) {
  const parameter = parameters.find((item) => item.name === "reasoning_effort" && Array.isArray(item.options));
  if (!parameter) return undefined;
  const levels = (parameter.options ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (!levels.length) return undefined;
  const fallback = levels.includes("medium") ? "medium" : levels[0]!;
  const requested = typeof parameter.default === "string" ? parameter.default.trim() : "";
  return { levels, default: levels.includes(requested) ? requested : fallback };
}

function formatCredits(value: number) {
  return String(Number(value.toFixed(4)));
}

/** 按量（token）模型：显示积分费率（积分 / 百万 token）。 */
export function agentTokenPriceLabel(pricing: {
  creditsPerYuan: number;
  inputCreditMicrosPerMillion?: number;
  outputCreditMicrosPerMillion?: number;
  inputYuanMicrosPerMillion?: number;
  outputYuanMicrosPerMillion?: number;
}) {
  const perMillion = (credits: number | undefined, yuan: number | undefined) => {
    if (credits !== undefined) return credits / 1_000_000;
    if (yuan !== undefined) return (yuan / 1_000_000) * pricing.creditsPerYuan;
    return null;
  };
  const input = perMillion(pricing.inputCreditMicrosPerMillion, pricing.inputYuanMicrosPerMillion);
  const output = perMillion(pricing.outputCreditMicrosPerMillion, pricing.outputYuanMicrosPerMillion);
  if (input === null && output === null) return "按 Token 计费";
  return `${input === null ? "—" : formatCredits(input)}/${output === null ? "—" : formatCredits(output)} 积分 · 每M`;
}

/** 按次模型：显示积分零售价（积分 / 次）；后台按元定价，这里换算成积分。 */
export function agentRequestPriceLabel(yuan: number, creditsPerYuan: number) {
  return `${formatCredits(yuan * creditsPerYuan)} 积分/次`;
}

/**
 * 站点公开价格表（`/api/pricing`）里与按次准入相关的部分。
 *
 * Agent 只按轮次计费，所以它只能收「有按次价」的模型；站点把按次价发布在
 * `group_prices` 的 `unit: "request"` 分组里（如「按次文本」）。模型目录本身
 * 只有计费模式，Gemini 这类 `tiered_token` 模型看不出还挂着按次价。
 */
export type StationTextPricing = {
  /** 价格表里出现过的模型 id（小写，无论计价方式）。 */
  knownModelIds: ReadonlySet<string>;
  /** 有按次价（request 单位）的模型 id（小写）。 */
  requestPricedModelIds: ReadonlySet<string>;
};

const stationPriceRowSchema = z.object({
  model_name: z.string().trim().min(1),
  price: z.object({ unit: z.string().optional() }).passthrough().nullish(),
  group_prices: z.record(z.string(), z.object({ unit: z.string().optional() }).passthrough()).nullish(),
}).passthrough();

const stationPricingSchema = z.object({ data: z.array(stationPriceRowSchema) }).passthrough();

export function parseStationTextPricing(value: unknown): StationTextPricing {
  const parsed = stationPricingSchema.parse(value);
  const knownModelIds = new Set<string>();
  const requestPricedModelIds = new Set<string>();
  for (const row of parsed.data) {
    const id = row.model_name.toLowerCase();
    knownModelIds.add(id);
    const units = [
      row.price?.unit,
      ...Object.values(row.group_prices ?? {}).map((group) => group.unit),
    ];
    if (units.some((unit) => unit === "request" || unit === "per-request")) requestPricedModelIds.add(id);
  }
  return { knownModelIds, requestPricedModelIds };
}

/**
 * 价格表读取器：带 TTL 进程内缓存，失败时退回上一次成功的结果（`null` 表示
 * 从未成功过，调用方退回目录标签口径）。这是营运增强，绝不阻断模型列表。
 */
export function createStationTextPricingLookup(options: {
  url: string;
  fetch?: typeof globalThis.fetch;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const now = options.now ?? Date.now;
  let cached: { value: StationTextPricing; at: number } | null = null;
  let inflight: Promise<StationTextPricing | null> | null = null;

  return async function lookup(): Promise<StationTextPricing | null> {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const response = await fetcher(options.url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`station pricing request failed with ${response.status}`);
        const value = parseStationTextPricing(await response.json());
        cached = { value, at: now() };
        return value;
      } catch (cause) {
        console.warn(
          "[agent] 站点价格表不可用，按目录标签判断按次模型",
          cause instanceof Error ? cause.message : cause,
        );
        return cached ? cached.value : null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/**
 * 组装 Agent 模型选择器的文本模型列表。
 *
 * 准入顺序：
 *  1. `includeTokenModels`（`AGENT_INCLUDE_TOKEN_MODELS=true`）时放开全部文本模型；
 *  2. 价格表明确有按次价的模型；
 *  3. 价格表里查不到的模型退回目录标记（`perRequest` 或本来就不是按量计费），
 *     避免上游价格表更新滞后时把按次模型从选择器里漏掉。
 */
export function buildAgentTextModels(input: {
  models: readonly PublicModel[];
  overrides: ModelOverrides;
  /** 站点价格表；null 表示不可用。 */
  stationPricing: StationTextPricing | null;
  includeTokenModels: boolean;
}): AgentTextModel[] {
  const { models, overrides, stationPricing, includeTokenModels } = input;
  const known = stationPricing?.knownModelIds ?? new Set<string>();
  const requestPriced = stationPricing?.requestPricedModelIds ?? new Set<string>();
  const entries: AgentTextModel[] = [];
  for (const model of models) {
    if (model.modality !== "text" || model.listed === false) continue;
    const id = model.id.toLowerCase();
    const requestEligible = requestPriced.has(id)
      || (!known.has(id) && (model.perRequest === true || model.pricing.mode !== "token"));
    if (!requestEligible && !includeTokenModels) continue;
    const billing: "request" | "token" = requestEligible ? "request" : "token";
    const overrideYuan = overrides.models[model.id]?.price?.yuan;
    const thinking = agentThinkingFromParameters(model.parameters);
    entries.push({
      id: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      group: agentTextModelGroup(`${model.id} ${model.label}`),
      meta: billing === "token"
        ? agentTokenPriceLabel(model.pricing)
        : agentRequestPriceLabel(agentRequestPriceYuan(model, overrideYuan), model.pricing.creditsPerYuan),
      billing,
      ...(thinking ? { thinking } : {}),
    });
  }
  return entries;
}
