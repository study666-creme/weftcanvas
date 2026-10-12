import type { PublicModel } from "@weftcanvas/contracts";
import { useMemo } from "react";

import { isCustomModelKey } from "../lib/custom-api";
import { CanvasSelect } from "./canvas-select";

export function GenerationModelSelect({
  value,
  models,
  disabled = false,
  onChange,
  variant = "standard",
  selectedParameters,
  menuClassName = "",
}: {
  value: string;
  models: PublicModel[];
  disabled?: boolean;
  onChange: (modelId: string) => void;
  variant?: "standard" | "compact";
  selectedParameters?: Record<string, unknown>;
  menuClassName?: string;
}) {
  const selectedModel = models.find((model) => model.id === value);
  const selectedMeta =
    selectedModel && selectedParameters
      ? modelConfiguredPriceLabel(selectedModel, selectedParameters)
      : undefined;
  const options = useMemo(
    () =>
      orderModelsForPicker(models).map((model) => {
        const label = modelPickerLabel(model);
        return {
          value: model.id,
          label,
          title: label,
          meta: modelPriceLabel(model),
          group: modelGroupLabel(model),
          detail: model.description,
          accent: true,
        };
      }),
    [models],
  );

  return (
    <div className="wc-generation-model-picker">
      <input data-generation-model-select type="hidden" value={value} readOnly />
      <CanvasSelect
        value={value}
        options={options}
        onChange={onChange}
        ariaLabel="模型"
        disabled={disabled}
        placeholder={options.length ? "选择模型" : "暂无可用模型"}
        variant={variant}
        menuClassName={`wc-generation-model-menu${menuClassName ? ` ${menuClassName}` : ""}`}
        menuMinWidth={340}
        selectedMeta={selectedMeta}
      />
    </div>
  );
}

export function modelPriceLabel(model: PublicModel) {
  if (isCustomModelKey(model.id)) return "自有 API";
  if (model.pricing.mode === "token") return tokenModelPriceLabel(model);
  const micros = calculateCatalogPriceMicros(model, defaultPricingParameters(model), false);
  return micros === null ? "按参数计费" : formatCreditMicros(micros, model.pricing.unit, false);
}

/**
 * token 计费模型的展示价。视频模型（如 Seedance）的 token 用量由上游按帧数与
 * 分辨率决定，浏览器估不出来，站点为此发布了「元/秒」参考价——展示它比干写
 * 「按 Token 计费」有用得多；文本模型没有参考价，维持原样。
 */
function tokenModelPriceLabel(model: PublicModel) {
  const referenceMicros = model.pricing.estimatedYuanMicrosPerSecond;
  if (model.modality === "video" && referenceMicros != null && referenceMicros > 0) {
    const credits = referenceMicros * model.pricing.creditsPerYuan;
    return `≈ ${formatCreditMicros(credits, "second", false)}（参考价）`;
  }
  return "按 Token 计费";
}

export function modelConfiguredPriceLabel(model: PublicModel, configured: Record<string, unknown>) {
  if (isCustomModelKey(model.id)) return "自有 API";
  if (model.pricing.mode === "token") return modelPriceLabel(model);
  const micros = calculateCatalogPriceMicros(model, pricingParameters(model, configured), true);
  return micros === null
    ? modelPriceLabel(model)
    : formatCreditMicros(micros, model.pricing.unit, true);
}

export function pricingUnitText(unit: PublicModel["pricing"]["unit"]): string {
  if (unit === "second") return "按秒计费";
  if (unit === "image") return "按张计费";
  if (unit === "request") return "按条计费";
  return "按 Token 计费";
}

function defaultPricingParameters(model: PublicModel) {
  return Object.fromEntries(
    model.parameters.flatMap((parameter) => {
      const value = parameter.fixed ?? parameter.default;
      return value === undefined ? [] : [[parameter.name, value]];
    }),
  );
}

function pricingParameters(model: PublicModel, configured: Record<string, unknown>) {
  const parameters: Record<string, unknown> = {};
  for (const parameter of model.parameters) {
    let value: unknown;
    if (parameter.fixed !== undefined) value = parameter.fixed;
    else if (Object.hasOwn(configured, parameter.name)) value = configured[parameter.name];
    else value = parameter.default;
    if (value !== undefined) parameters[parameter.name] = value;
  }
  return parameters;
}

function calculateCatalogPriceMicros(
  model: PublicModel,
  parameters: Record<string, unknown>,
  multiplyUnits: boolean,
) {
  const pricing = model.pricing;
  const tier = pricing.tiers.find((candidate) =>
    Object.entries(candidate.when).every(([name, value]) => sameValue(parameters[name], value)),
  );
  const baseCreditMicros = tier?.creditMicros ?? pricing.baseCreditMicros;
  const baseYuanMicros = tier?.yuanMicros ?? pricing.baseYuanMicros;
  if (baseCreditMicros === undefined && baseYuanMicros === undefined) return null;

  let units = 1;
  if (multiplyUnits && pricing.unit === "second") {
    const duration = parameters.duration ?? parameters.seconds;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0)
      units *= duration;
  }
  if (multiplyUnits && pricing.unit === "image") {
    const count = parameters.n;
    if (typeof count === "number" && Number.isFinite(count) && count > 0) units *= count;
  }

  const micros = baseCreditMicros ?? baseYuanMicros! * pricing.creditsPerYuan;
  return Math.ceil(micros * units);
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatCreditMicros(micros: number, unit: PublicModel["pricing"]["unit"], total: boolean) {
  const credits = micros / 1_000_000;
  const value = `${Number.isInteger(credits) ? credits : Number(credits.toFixed(4))} 积分`;
  if (unit === "request") return total ? `${value}（按条计费）` : `${value}/条`;
  if (unit === "image") return total ? `${value}（按张计费）` : `${value}/张`;
  if (unit === "second") return total ? `${value}（按秒计费）` : `${value}/秒`;
  return value;
}

export function modelGroupLabel(model: PublicModel) {
  if (isCustomModelKey(model.id)) return CUSTOM_MODEL_GROUP_LABEL;
  if (isPromoZoneModel(model)) return "特惠模型";
  if (model.modality === "image")
    return (
      {
        universal: "全能模型2",
        banana: "香蕉",
        other: "其他图片模型",
      } as const
    )[imageModelBucket(model)];
  if (model.modality !== "video") return model.modality === "audio" ? "音频模型" : "文本模型";
  const routeLine = videoRouteLine(model);
  return routeLine === null ? "线路待同步" : `线路${formatChineseRouteLine(routeLine)}`;
}

export const CUSTOM_MODEL_GROUP_LABEL = "自有 API";

/** 运营分区：特惠引流区（随时可能下架、不保证可用性与成功率）。 */
export function isPromoZoneModel(model: PublicModel) {
  return model.zone === "promo";
}

export const PROMO_MODEL_NOTICE =
  "特惠模型随时可能下架或不可用，可用时也不保证成功率；请优先使用稳定区模型。";

/**
 * 默认选中模型：稳定主推区（zone !== "promo"）的第一个；特惠区只做引流，
 * 永远不作为默认选中。没有任何稳定模型时才退回列表第一个。
 */
export function pickDefaultModel(models: PublicModel[]): PublicModel | null {
  return models.find((model) => !isPromoZoneModel(model)) ?? models[0] ?? null;
}

export function modelPickerLabel(model: PublicModel) {
  if (
    model.modality !== "image" ||
    isCustomModelKey(model.id) ||
    imageModelBucket(model) !== "banana"
  )
    return model.label;
  return model.label
    .replace(/(香蕉\s*[·•:：/\-]\s*)标准(?=\s|$)/i, "$1Standard")
    .replace(/(香蕉\s*[·•:：/\-]\s*)极速(?=\s|$)/i, "$1Fast")
    .replace(/(香蕉\s*[·•:：/\-]\s*)专业(?=\s|$)/i, "$1Pro")
    .replace(/(香蕉\s*[·•:：/\-]\s*)2代(?=\s|$)/i, (_match, prefix: string) => `${prefix}2`);
}

export function orderModelsForPicker(models: PublicModel[]) {
  if (!models.length) return models;
  // 特惠区永远殿后：主推位留给稳定区模型。
  const zoneRank = (model: PublicModel) => (isPromoZoneModel(model) ? 1 : 0);
  if (models[0]?.modality === "image") {
    return [...models].sort((left, right) => {
      const zoneDifference = zoneRank(left) - zoneRank(right);
      if (zoneDifference) return zoneDifference;
      const groupDifference = imageModelBucketRank(left) - imageModelBucketRank(right);
      if (groupDifference) return groupDifference;
      const orderDifference = left.order - right.order;
      if (orderDifference) return orderDifference;
      return left.label.localeCompare(right.label, "zh-CN");
    });
  }
  if (models[0]?.modality !== "video") {
    // 文本/音频保持既有顺序（测试契约）；仅当混有特惠模型时整体后移。
    if (!models.some(isPromoZoneModel)) return models;
    const stable = models.filter((model) => !isPromoZoneModel(model));
    const promo = models.filter(isPromoZoneModel);
    return [...stable, ...promo];
  }
  return [...models].sort((left, right) => {
    const zoneDifference = zoneRank(left) - zoneRank(right);
    if (zoneDifference) return zoneDifference;
    const routeDifference = videoModelLineRank(left) - videoModelLineRank(right);
    if (routeDifference) return routeDifference;
    const orderDifference = left.order - right.order;
    if (orderDifference) return orderDifference;
    return left.label.localeCompare(right.label, "zh-CN");
  });
}

function imageModelBucket(model: PublicModel) {
  const text = `${model.id} ${model.label} ${model.description}`.toLowerCase();
  if (/nano[\s_-]*banana|lingtu|香蕉/.test(text)) return "banana";
  if (/gpt[\s_-]*image[\s_-]*2|(?:^|\s)image2|全能模型2/.test(text)) return "universal";
  return "other";
}

function imageModelBucketRank(model: PublicModel) {
  if (isCustomModelKey(model.id)) return Number.MAX_SAFE_INTEGER;
  return ({ universal: 0, banana: 1, other: 2 } as const)[imageModelBucket(model)];
}

function videoRouteLine(model: PublicModel) {
  const routeLine = model.routeLine;
  return typeof routeLine === "number" && Number.isInteger(routeLine) && routeLine > 0
    ? routeLine
    : null;
}

function videoModelLineRank(model: PublicModel) {
  if (isCustomModelKey(model.id)) return Number.MAX_SAFE_INTEGER;
  return videoRouteLine(model) ?? Number.MAX_SAFE_INTEGER - 1;
}

function formatChineseRouteLine(routeLine: number) {
  if (routeLine > 99) return String(routeLine);
  const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (routeLine < 10) return digits[routeLine];
  const tens = Math.floor(routeLine / 10);
  const ones = routeLine % 10;
  return `${tens === 1 ? "" : digits[tens]}十${digits[ones]}`;
}
