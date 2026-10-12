import { randomUUID } from "node:crypto";

import {
  generationQuoteRequestSchema,
  generationQuoteSchema,
  type GenerationQuoteRequest,
  type ModelInput,
  type ModelParameter,
  type ModelPricing,
  type PublicModel,
} from "@weftcanvas/contracts";

import { WeftcanvasCatalogAdapter } from "./adapter.js";
import { OutputCountError, totalOutputCount } from "../generation/output-count.js";
import { h3SuperResolutionRequiresImage } from "../generation/minimax-h3.js";
import {
  declaresReferenceVideoDurations,
  MAX_REFERENCE_VIDEO_TOTAL_SECONDS,
  REFERENCE_VIDEO_DURATIONS_PARAMETER,
  sanitizeReferenceVideoDurations,
  sumReferenceVideoDurations,
} from "../generation/reference-video-durations.js";

export class QuoteValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "QuoteValidationError";
    this.code = code;
  }
}

export class GenerationQuoteService {
  constructor(
    private readonly catalogAdapter: WeftcanvasCatalogAdapter,
    private readonly options: { now?: () => number; quoteTtlMs?: number } = {},
  ) {}

  async createQuote(value: unknown) {
    const request = generationQuoteRequestSchema.parse(value);
    const record = await this.catalogAdapter.getModel(request.modelId);
    if (!record)
      throw new QuoteValidationError("MODEL_NOT_AVAILABLE", "所选模型当前不可用，请重新选择");
    if (!record.catalog.quoteAvailable)
      throw new QuoteValidationError("QUOTE_UNAVAILABLE", "当前价格暂时无法确认，请稍后重试");
    if (record.model.modality !== request.modality)
      throw new QuoteValidationError("MODEL_MODALITY_MISMATCH", "所选模型不支持当前节点类型");

    const normalizedParameters = normalizeParameters(record.model, request.parameters);
    validateInputCounts(record.model.input, request.inputs);
    validateInputDependentParameters(record.model, request.inputs, normalizedParameters);
    validateH3ResolutionReferences(record.model.id, request.inputs, normalizedParameters);
    validateReferenceVideoDurations(record.model, request.inputs, normalizedParameters);
    const outputCount = validateOutputCount(record.model, request, normalizedParameters);
    const amount = calculateAmount(record.model, request, normalizedParameters, outputCount);
    const now = (this.options.now ?? Date.now)();
    const expiresAt = Math.min(
      now + (this.options.quoteTtlMs ?? 2 * 60_000),
      Date.parse(record.catalog.expiresAt),
    );

    return generationQuoteSchema.parse({
      id: randomUUID(),
      modelId: record.model.id,
      modelLabel: record.model.label,
      modality: record.model.modality,
      quantity: request.quantity,
      outputCount,
      normalizedParameters,
      creditMicros: amount.creditMicros,
      credits: formatMicros(amount.creditMicros),
      yuanMicros: amount.yuanMicros,
      yuan: formatMicros(amount.yuanMicros),
      estimated: amount.estimated,
      pricingUnit: record.model.pricing.unit,
      catalogVersion: record.catalog.version,
      capabilityVersion: record.catalog.capabilityVersion,
      pricingVersion: record.catalog.pricingVersion,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }
}

function validateH3ResolutionReferences(
  modelId: string,
  inputs: GenerationQuoteRequest["inputs"],
  parameters: Record<string, unknown>,
) {
  if (!h3SuperResolutionRequiresImage(modelId, parameters)) return;
  const imageCount = inputs.images + (inputs.styleImages ?? 0) + (inputs.elementImages ?? 0);
  if (imageCount === 0) {
    throw new QuoteValidationError("H3_REFERENCE_REQUIRED", "H3 的 2K/4K 需要至少一张参考图片");
  }
}

function normalizeParameters(model: PublicModel, submitted: Record<string, unknown>) {
  const allowed = new Set(model.parameters.map((parameter) => parameter.name));
  const unknown = Object.keys(submitted).filter((name) => !allowed.has(name));
  if (unknown.length)
    throw new QuoteValidationError(
      "UNKNOWN_PARAMETER",
      `当前模型不支持参数：${unknown.join("、")}`,
    );

  const normalized: Record<string, unknown> = {};
  for (const parameter of model.parameters) {
    const provided = submitted[parameter.name];
    let value = provided;
    if (parameter.fixed !== undefined) {
      if (provided !== undefined && !sameValue(provided, parameter.fixed)) {
        throw new QuoteValidationError("FIXED_PARAMETER", `${parameter.label}是固定参数，不能修改`);
      }
      value = parameter.fixed;
    } else if (provided === undefined && parameter.default !== undefined) {
      value = parameter.default;
    }
    if (value === undefined) {
      if (parameter.required)
        throw new QuoteValidationError("MISSING_PARAMETER", `请填写${parameter.label}`);
      continue;
    }
    value = canonicalOptionValue(parameter, value);
    validateParameter(parameter, value);
    normalized[parameter.name] = value;
  }

  for (const parameter of model.parameters) {
    if (normalized[parameter.name] === undefined) continue;
    const conflict = parameter.mutuallyExclusiveWith.find((name) => normalized[name] !== undefined);
    if (conflict)
      throw new QuoteValidationError(
        "CONFLICTING_PARAMETERS",
        `${parameter.label}不能与${conflict}同时使用`,
      );
  }
  return normalized;
}

function validateParameter(parameter: ModelParameter, value: unknown) {
  if (parameter.type === "string" && typeof value !== "string") invalidType(parameter);
  if (parameter.type === "boolean" && typeof value !== "boolean") invalidType(parameter);
  if ((parameter.type === "number" || parameter.type === "integer") && typeof value !== "number")
    invalidType(parameter);
  if (parameter.type === "integer" && (!Number.isInteger(value) || !Number.isFinite(value)))
    invalidType(parameter);
  if (parameter.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
    invalidType(parameter);
  if (parameter.type === "array" && !Array.isArray(value)) invalidType(parameter);
  if (parameter.type === "object" && (!value || typeof value !== "object" || Array.isArray(value)))
    invalidType(parameter);
  if (parameter.options && !parameter.options.some((option) => sameValue(option, value))) {
    throw new QuoteValidationError("INVALID_PARAMETER_OPTION", `${parameter.label}不支持这个选项`);
  }
  if (typeof value === "number") {
    if (parameter.min !== undefined && value < parameter.min)
      throw new QuoteValidationError(
        "PARAMETER_OUT_OF_RANGE",
        `${parameter.label}不能小于 ${parameter.min}`,
      );
    if (parameter.max !== undefined && value > parameter.max)
      throw new QuoteValidationError(
        "PARAMETER_OUT_OF_RANGE",
        `${parameter.label}不能大于 ${parameter.max}`,
      );
  }
  if (typeof value === "string") {
    if (parameter.minLength !== undefined && value.length < parameter.minLength)
      throw new QuoteValidationError("PARAMETER_TOO_SHORT", `${parameter.label}内容太短`);
    if (parameter.maxLength !== undefined && value.length > parameter.maxLength)
      throw new QuoteValidationError("PARAMETER_TOO_LONG", `${parameter.label}内容太长`);
  }
  if (Array.isArray(value)) {
    if (parameter.minItems !== undefined && value.length < parameter.minItems)
      throw new QuoteValidationError("TOO_FEW_ITEMS", `${parameter.label}数量不足`);
    if (parameter.maxItems !== undefined && value.length > parameter.maxItems)
      throw new QuoteValidationError("TOO_MANY_ITEMS", `${parameter.label}数量过多`);
  }
}

// Catalog providers do not agree on the casing of symbolic options (MJ has
// used both `1k` and `1K`). Accept the existing saved value, but retain the
// catalog's spelling in the quote and the upstream request.
function canonicalOptionValue(parameter: ModelParameter, value: unknown) {
  if (typeof value !== "string" || !parameter.options?.length) return value;
  return (
    parameter.options.find(
      (option) => typeof option === "string" && option.toLowerCase() === value.toLowerCase(),
    ) ?? value
  );
}

function validateInputCounts(input: ModelInput, counts: GenerationQuoteRequest["inputs"]) {
  const styleImageCount = counts.styleImages ?? 0;
  const elementImageCount = counts.elementImages ?? 0;
  if (input.referenceMedia) {
    const hasDeclaredImagePurpose =
      input.referenceMedia.images !== undefined ||
      input.referenceMedia.styleImages !== undefined ||
      input.referenceMedia.elementImages !== undefined;
    validateInputCount(
      "图片",
      input.referenceMedia.images ?? (hasDeclaredImagePurpose ? undefined : input.images),
      counts.images,
    );
    validateInputCount("风格图", input.referenceMedia.styleImages, styleImageCount);
    validateInputCount("元素图", input.referenceMedia.elementImages, elementImageCount);
    validateInputCount("视频", input.referenceMedia.videos ?? input.videos, counts.videos);
    validateInputCount("音频", input.referenceMedia.audios ?? input.audios, counts.audios);
    const total =
      counts.images + styleImageCount + elementImageCount + counts.videos + counts.audios;
    if (
      input.referenceMedia.maxTotalItems !== undefined &&
      total > input.referenceMedia.maxTotalItems
    ) {
      throw new QuoteValidationError(
        "TOO_MANY_REFERENCES",
        `参考素材最多支持 ${input.referenceMedia.maxTotalItems} 个`,
      );
    }
    return;
  }
  if (styleImageCount > 0 || elementImageCount > 0) {
    throw new QuoteValidationError("UNSUPPORTED_REFERENCE", "当前模型不支持风格图或元素图参考");
  }
  validateInputCount("图片", input.images, counts.images);
  validateInputCount("视频", input.videos, counts.videos);
  validateInputCount("音频", input.audios, counts.audios);
}

function validateInputCount(label: string, capability: ModelInput["images"], count: number) {
  if (!capability && count > 0)
    throw new QuoteValidationError("UNSUPPORTED_REFERENCE", `当前模型不支持参考${label}`);
  if (!capability) return;
  if (count < capability.min)
    throw new QuoteValidationError(
      "TOO_FEW_REFERENCES",
      `参考${label}至少需要 ${capability.min} 个`,
    );
  if (capability.max !== undefined && count > capability.max)
    throw new QuoteValidationError(
      "TOO_MANY_REFERENCES",
      `参考${label}最多支持 ${capability.max} 个`,
    );
  if (!capability.multiple && count > 1)
    throw new QuoteValidationError("TOO_MANY_REFERENCES", `当前模型只支持一个参考${label}`);
}

function validateInputDependentParameters(
  model: PublicModel,
  inputs: GenerationQuoteRequest["inputs"],
  parameters: Record<string, unknown>,
) {
  if (model.id !== "grok-imagine-video" || inputs.images < 2) return;
  const seconds = parameters.duration_seconds ?? parameters.seconds ?? parameters.duration;
  if (typeof seconds === "number" && seconds > 10) {
    throw new QuoteValidationError(
      "PARAMETER_OUT_OF_RANGE",
      "grok-imagine-video supports at most 10 seconds when using multiple reference images",
    );
  }
}

/**
 * 参考视频时长只在客户端真的发来时才校验：目录发布了这个参数的模型（当前是
 * H3 系列）要求它与参考视频成对出现，但不是所有客户端都能在本地量出视频时长
 * （例如快速生成页），那些提交由生成服务从素材元数据兜底推导，报价侧不能把
 * 它们提前判死。带了就按目录口径校验数量对齐与 15 秒总上限，错误在报价阶段
 * 就告知用户，不必等上游 400。
 */
function validateReferenceVideoDurations(
  model: PublicModel,
  inputs: GenerationQuoteRequest["inputs"],
  parameters: Record<string, unknown>,
) {
  if (!declaresReferenceVideoDurations(model)) return;
  const durations = sanitizeReferenceVideoDurations(
    parameters[REFERENCE_VIDEO_DURATIONS_PARAMETER],
  );
  if (durations === null) return;
  if (durations.length !== inputs.videos) {
    throw new QuoteValidationError(
      "REFERENCE_VIDEO_DURATION_MISMATCH",
      "参考视频时长与参考视频数量不一致",
    );
  }
  if (sumReferenceVideoDurations(durations) > MAX_REFERENCE_VIDEO_TOTAL_SECONDS) {
    throw new QuoteValidationError(
      "REFERENCE_VIDEO_DURATION_LIMIT",
      `参考视频总时长不能超过 ${MAX_REFERENCE_VIDEO_TOTAL_SECONDS} 秒`,
    );
  }
}

function calculateAmount(
  model: PublicModel,
  request: GenerationQuoteRequest,
  parameters: Record<string, unknown>,
  outputCount = totalOutputCount(model.modality, request.quantity, parameters),
) {
  const pricing = model.pricing;
  if (pricing.mode === "token") {
    // 视频的 token 用量由上游按帧数与分辨率决定，浏览器估不出来：拿 prompt 字数
    // 套文本 token 公式会给出比真实价低两个数量级的报价，且完全不随时长变化。
    // 这类模型改用站点发布的元/秒参考价，按预扣口径报价。
    if (model.modality === "video")
      return calculateVideoReferenceAmount(model, request, parameters);
    return calculateTokenAmount(pricing, request);
  }
  const tier = pricing.tiers.find((candidate) =>
    Object.entries(candidate.when).every(([name, value]) => sameValue(parameters[name], value)),
  );
  const baseCreditMicros = tier?.creditMicros ?? pricing.baseCreditMicros;
  const baseYuanMicros = tier?.yuanMicros ?? pricing.baseYuanMicros;
  if (baseCreditMicros === undefined && baseYuanMicros === undefined) {
    throw new QuoteValidationError("PRICE_NOT_AVAILABLE", "当前模型价格暂时无法确认");
  }
  // Image prices are per delivered image, including both the legacy quantity
  // multiplier and the model's n/count parameter. Other units retain their
  // existing semantics (video seconds, request, or token estimates).
  // Request-priced image APIs such as Midjourney bill one generation call
  // even though the response contains multiple image artifacts.
  let units =
    pricing.unit === "request"
      ? request.quantity
      : model.modality === "image"
        ? outputCount
        : request.quantity;
  if (pricing.unit === "second") {
    const duration = parameters.duration_seconds ?? parameters.duration ?? parameters.seconds;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      throw new QuoteValidationError("MISSING_DURATION", "当前视频模型需要有效时长");
    }
    units *= duration;
    // 参考视频按该模型的每秒价格另行计费（站点目录对 H3 系列的明示口径）。
    // 预扣若只算成片秒数，实扣会超出预扣一个参考素材的量级，所以这部分秒数
    // 按同一档每秒价并进 units；没有参考视频时为 0，行为不变。
    units += referenceVideoBillableSeconds(model, parameters);
  }
  if (pricing.unit === "image") units = outputCount;
  const creditMicros = Math.ceil(
    (baseCreditMicros ?? yuanToCredits(baseYuanMicros!, pricing.creditsPerYuan)) * units,
  );
  const yuanMicros = Math.ceil(
    (baseYuanMicros ?? creditsToYuan(baseCreditMicros!, pricing.creditsPerYuan)) * units,
  );
  // 参考图超量是固定每张费，不与时长相乘，只能在算出基础额之后另加。
  const overage = referenceImageOverageCharge(model, request);
  return {
    creditMicros: creditMicros + overage.creditMicros,
    yuanMicros: yuanMicros + overage.yuanMicros,
    estimated: false,
  };
}

function validateOutputCount(
  model: PublicModel,
  request: GenerationQuoteRequest,
  parameters: Record<string, unknown>,
) {
  // Request-priced image models with a fixed multi-artifact output (Midjourney
  // is the current example) bill one provider call and return four images. The
  // Canvas quantity is therefore always 1;
  // a larger quantity is rejected here, before any reservation, and never
  // becomes a multiplied 200/2.0 quote.
  if (request.quantity !== 1 && isRequestPricedFixedMultiOutputImage(model)) {
    throw new QuoteValidationError(
      "OUTPUT_COUNT_UNSUPPORTED",
      `该模型单次调用固定返回 ${model.output.minCount} 张图片，每次只计一次调用费用`,
    );
  }
  let count: number;
  try {
    // A fixed multi-output model (MJ is the current example) uses `n` for
    // provider submission count while its catalog output contract declares
    // the four artifacts returned by one call. Do not treat fixed `n=1` as a
    // one-image request.
    count =
      model.output.minCount === model.output.maxCount && model.output.minCount > 1
        ? request.quantity * model.output.minCount
        : totalOutputCount(model.modality, request.quantity, parameters);
  } catch (error) {
    if (error instanceof OutputCountError) {
      throw new QuoteValidationError(error.code, error.message);
    }
    throw error;
  }
  if (model.output.type !== model.modality) {
    throw new QuoteValidationError(
      "MODEL_OUTPUT_MISMATCH",
      "The model output type does not match the generation modality",
    );
  }
  if (count < model.output.minCount || count > model.output.maxCount) {
    throw new QuoteValidationError(
      "OUTPUT_COUNT_UNSUPPORTED",
      `Requested ${count} outputs; this model supports ${model.output.minCount}-${model.output.maxCount}`,
    );
  }
  return count;
}

/**
 * 参考视频的可计费秒数。上游把参考视频按该模型的每秒价格计费（站点目录对
 * H3 系列的明示口径），预扣只算成片秒数会让实扣超出预扣一个参考素材的量级。
 * 模型没发布这个参数、或本次请求没带合法音长时为 0，其他模型行为不变。
 */
function referenceVideoBillableSeconds(model: PublicModel, parameters: Record<string, unknown>) {
  if (!declaresReferenceVideoDurations(model)) return 0;
  const durations = sanitizeReferenceVideoDurations(
    parameters[REFERENCE_VIDEO_DURATIONS_PARAMETER],
  );
  return durations === null ? 0 : sumReferenceVideoDurations(durations);
}

/**
 * 参考图超量固定费：前 5 张免费，第 6 张起每张 0.1 元。这条口径来自站点目录
 * 对 H3 系列模型的描述原文（结构化价格里没有这一档），2026-09-23 运营确认照
 * 此执行——少计费的后果是实扣超过预扣，所以这里按目录口径把常数钉住并写清
 * 出处；每模型汇率从目录 credits_per_yuan 读，不把「100 积分/元」写死。
 */
const FREE_REFERENCE_IMAGES = 5;
const REFERENCE_IMAGE_OVERAGE_YUAN = 0.1;

function referenceImageOverageCharge(model: PublicModel, request: GenerationQuoteRequest) {
  if (!declaresReferenceVideoDurations(model)) return { creditMicros: 0, yuanMicros: 0 };
  const images =
    request.inputs.images + (request.inputs.styleImages ?? 0) + (request.inputs.elementImages ?? 0);
  const overage = Math.max(0, images - FREE_REFERENCE_IMAGES);
  if (!overage) return { creditMicros: 0, yuanMicros: 0 };
  return {
    creditMicros: Math.ceil(
      overage * REFERENCE_IMAGE_OVERAGE_YUAN * model.pricing.creditsPerYuan * 1_000_000,
    ),
    yuanMicros: Math.ceil(overage * REFERENCE_IMAGE_OVERAGE_YUAN * 1_000_000),
  };
}

function isRequestPricedFixedMultiOutputImage(model: PublicModel) {
  return (
    model.modality === "image" &&
    model.pricing.unit === "request" &&
    model.output.minCount === model.output.maxCount &&
    model.output.minCount > 1
  );
}

function calculateTokenAmount(pricing: ModelPricing, request: GenerationQuoteRequest) {
  if (request.inputTokens === undefined || request.maxOutputTokens === undefined) {
    throw new QuoteValidationError(
      "TOKEN_ESTIMATE_REQUIRED",
      "文本模型报价需要输入与最大输出 Token 估算",
    );
  }
  const inputCredits = pricing.inputCreditMicrosPerMillion;
  const outputCredits = pricing.outputCreditMicrosPerMillion;
  const inputYuan = pricing.inputYuanMicrosPerMillion;
  const outputYuan = pricing.outputYuanMicrosPerMillion;
  if (
    (inputCredits === undefined || outputCredits === undefined) &&
    (inputYuan === undefined || outputYuan === undefined)
  ) {
    throw new QuoteValidationError("PRICE_NOT_AVAILABLE", "当前模型价格暂时无法确认");
  }
  const quantity = request.quantity;
  const creditMicros = Math.ceil(
    (((inputCredits ?? yuanToCredits(inputYuan!, pricing.creditsPerYuan)) * request.inputTokens) /
      1_000_000 +
      ((outputCredits ?? yuanToCredits(outputYuan!, pricing.creditsPerYuan)) *
        request.maxOutputTokens) /
        1_000_000) *
      quantity,
  );
  const yuanMicros = Math.ceil(
    (((inputYuan ?? creditsToYuan(inputCredits!, pricing.creditsPerYuan)) * request.inputTokens) /
      1_000_000 +
      ((outputYuan ?? creditsToYuan(outputCredits!, pricing.creditsPerYuan)) *
        request.maxOutputTokens) /
        1_000_000) *
      quantity,
  );
  return { creditMicros, yuanMicros, estimated: true };
}

/**
 * token 计价视频模型的预扣报价：金额 = 时长 × 站点发布的元/秒参考价。
 * 报价在 quantity 上相乘，与按秒计价的视频模型保持同一口径。
 * 站点没有发布参考价时明确报「无法确认价格」，绝不用别处的单价凑一个数出来。
 */
function calculateVideoReferenceAmount(
  model: PublicModel,
  request: GenerationQuoteRequest,
  parameters: Record<string, unknown>,
) {
  const pricing = model.pricing;
  const referenceYuanMicros = pricing.estimatedYuanMicrosPerSecond;
  if (referenceYuanMicros === undefined) {
    throw new QuoteValidationError("PRICE_NOT_AVAILABLE", "当前模型价格暂时无法确认");
  }
  const duration = parameters.duration_seconds ?? parameters.duration ?? parameters.seconds;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw new QuoteValidationError("MISSING_DURATION", "当前视频模型需要有效时长");
  }
  const units = duration * request.quantity;
  const yuanMicros = Math.ceil(referenceYuanMicros * units);
  const creditMicros = Math.ceil(yuanToCredits(yuanMicros, pricing.creditsPerYuan));
  return { creditMicros, yuanMicros, estimated: true };
}

function invalidType(parameter: ModelParameter): never {
  throw new QuoteValidationError("INVALID_PARAMETER_TYPE", `${parameter.label}格式不正确`);
}
function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function creditsToYuan(creditMicros: number, creditsPerYuan: number) {
  return creditMicros / creditsPerYuan;
}

function yuanToCredits(yuanMicros: number, creditsPerYuan: number) {
  return yuanMicros * creditsPerYuan;
}

function formatMicros(value: number) {
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
