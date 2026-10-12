import type {
  CanvasNodeKind,
  GenerationQuoteRequest,
  ModelModality,
  ModelParameter,
  PublicModel,
} from "@weftcanvas/contracts";

import { normalizeBoundedDurationValue } from "../components/generation-parameter-field";
import { mediaAspectRatioParameterNames, type DefaultNodeAspectRatio } from "./node-size";

const PRIMARY_TEXT_PARAMETERS = new Set(["prompt", "text", "input"]);
const MESSAGE_PARAMETERS = new Set(["messages"]);
const MEDIA_REFERENCE_PARAMETER_NAME = /^(?:reference|ref)(?:image|video|audio)s?(?:url)?s?$/;
const BARE_MEDIA_PARAMETER_NAME = /^(image|video|audio)(?:s|urls?)?$/;
const POSITIONED_IMAGE_PARAMETER_NAME =
  /^(?:first|start|last|end)(?:(?:frame)(?:image)?|image)(?:url)?$/;
const INTERNAL_PARAMETER_NAMES = new Set(["model", "provider", "n", "async"]);
const COMPATIBILITY_LABEL_PATTERN = /兼容(?:字段|别名|比例)|compat(?:ibility)?|alias/iu;
const DURATION_PARAMETER_NAMES = new Set(["duration_seconds", "duration", "seconds"]);
const ASPECT_RATIO_PARAMETER_NAMES = new Set(["aspect_ratio", "aspectRatio", "ratio"]);
const DIMENSION_PARAMETER_NAMES = new Set(["size", "resolution"]);
const PLATFORM_MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  "gpt-image-2-4k-adobe": "image2-4k-fast",
  "gpt-image-2-4k-fast": "image2-4k-fast",
};

export function canonicalPlatformModelId(modelId: string) {
  return PLATFORM_MODEL_ID_ALIASES[modelId.trim().toLowerCase()] ?? modelId;
}

export function canRecoverUnavailableModelSelection(input: {
  modelId: string;
  modelAvailable: boolean;
  customModelKey: boolean;
  catalogLoadSettled: boolean;
  catalogReady: boolean;
  catalogRefreshing: boolean;
  catalogError: string | null;
  platformModelCount: number;
  customCatalogLoading: boolean;
}) {
  return Boolean(
    input.modelId &&
    !input.modelAvailable &&
    !input.customModelKey &&
    input.catalogLoadSettled &&
    input.catalogReady &&
    !input.catalogRefreshing &&
    !input.catalogError &&
    input.platformModelCount > 0 &&
    !input.customCatalogLoading,
  );
}

// Request-priced image models with a fixed multi-artifact output (Midjourney is
// the current example) bill one provider call even though the response contains
// multiple single-image artifacts. The browser must never multiply
// those artifacts into repeated calls: the quote/job quantity stays 1 and the
// delivered artifact count comes from the catalog output contract.
export function isRequestPricedFixedMultiOutputImageModel(model: PublicModel | null): boolean {
  return Boolean(
    model &&
    model.modality === "image" &&
    model.pricing.unit === "request" &&
    model.output.minCount === model.output.maxCount &&
    model.output.minCount > 1,
  );
}

/** The number of artifacts one call returns for a request-priced fixed multi-output image model, else null. */
export function requestPricedFixedOutputCount(model: PublicModel | null): number | null {
  return isRequestPricedFixedMultiOutputImageModel(model) ? model!.output.minCount : null;
}

/**
 * 上游对 n>1 的支持不可靠（曾出现扣费 N 次、只回一张图），所以「一次只回一条」
 * 的图片/视频模型要凑多条，只能由浏览器连点 N 次、每次一个任务。这里判断该
 * 策略是否适用于这个模型：
 * - 模型一次只回一条（输出契约 maxCount <= 1，排除 Midjourney 这类固定多图）；
 * - 没有可用的 n 范围参数（有范围的模型直接传 n，由上游一次出多条）；
 * - 不是按次计费的固定多图模型。
 */
export function supportsClientBatchGeneration(
  model: PublicModel | null,
  outputCountParameter: ModelParameter | null,
): boolean {
  if (!model) return false;
  if (model.modality !== "image" && model.modality !== "video") return false;
  if (isRequestPricedFixedMultiOutputImageModel(model)) return false;
  if (model.output.maxCount > 1) return false;
  return outputCountParameter === null || outputCountParameter.fixed !== undefined;
}

/**
 * Quote/job quantity for a generation request. Request-priced fixed
 * multi-output image models always send quantity 1; otherwise the model's own
 * output-count parameter (when present) carries the count and the quantity stays
 * 1, and only a standalone quantity-less image model sends its selected quantity.
 */
export function generationRequestQuantity(
  model: PublicModel | null,
  hasOutputCountParameter: boolean,
  configuredQuantity: number,
): number {
  if (isRequestPricedFixedMultiOutputImageModel(model)) return 1;
  return hasOutputCountParameter ? 1 : configuredQuantity;
}

export function modalityForNodeKind(kind: CanvasNodeKind): ModelModality {
  if (kind === "config" || kind === "edit") return "image";
  // 插件节点没有生成面板入口；媒体模态是仅有的四种生成目标。
  if (kind === "text" || kind === "image" || kind === "video" || kind === "audio") return kind;
  return "image";
}

export function isBoundTextParameter(parameter: ModelParameter) {
  return PRIMARY_TEXT_PARAMETERS.has(parameter.name) || MESSAGE_PARAMETERS.has(parameter.name);
}

export function isModelBoundTextParameter(model: PublicModel, parameter: ModelParameter) {
  return parameter.name === primaryTextParameterName(model);
}

export function isModelMediaReferenceParameter(model: PublicModel, parameter: ModelParameter) {
  const normalizedName = parameter.name.replaceAll("_", "").toLowerCase();
  if (MEDIA_REFERENCE_PARAMETER_NAME.test(normalizedName)) return true;
  const bareKind = BARE_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1];
  const mediaInputName = POSITIONED_IMAGE_PARAMETER_NAME.test(normalizedName)
    ? "images"
    : bareKind
      ? (`${bareKind}s` as "images" | "videos" | "audios")
      : undefined;
  if (mediaInputName) return acceptsMediaInput(model.input[mediaInputName]);
  if (!MESSAGE_PARAMETERS.has(parameter.name) || !hasModelMediaInput(model)) return false;
  return model.parameters.some(
    (candidate) => candidate.name !== parameter.name && PRIMARY_TEXT_PARAMETERS.has(candidate.name),
  );
}

export function isModelInternalParameter(parameter: ModelParameter) {
  return (
    parameter.fixed !== undefined &&
    INTERNAL_PARAMETER_NAMES.has(parameter.name.trim().toLowerCase())
  );
}

export function isModelCompatibilityParameterHidden(model: PublicModel, parameter: ModelParameter) {
  return canonicalParameterName(model, parameter.name) !== parameter.name;
}

/**
 * Parameters the canvas exposes to end users. Canvas users only collect the
 * finished result — they never pick a transport/response format or raw pixel
 * dimensions. We keep only the creative controls (aspect ratio, duration) and
 * hide implementation knobs; the correct format/size is forwarded internally.
 */

/**
 * 传输与响应格式：结果的解析依赖固定格式，暴露给用户会直接破坏内部处理，
 * 因此任何界面都不显示。
 */
const TRANSPORT_FORMAT_PARAMETER_NAMES = new Set([
  "response_format",
  "responseformat",
  "response_type",
  "output_format",
  "outputformat",
  "format",
  "mime",
  "mime_type",
  "file_format",
]);
const TRANSPORT_FORMAT_NAME_PATTERN =
  /(?:^|_)(?:response|output|file|mime)(?:_|$)|(?:^|_)(?:format|encoding)(?:_|$)/iu;
const TRANSPORT_FORMAT_LABEL_PATTERN = /响应格式|输出格式|返回格式|url格式|链接格式/iu;

/**
 * 分辨率与像素尺寸：属于创作规格而不是实现细节，工作台需要让用户自己选，
 * 只有面向节点画布的简化入口才隐藏它们。
 */
const RESOLUTION_PARAMETER_NAMES = new Set(["resolution"]);
const RESOLUTION_NAME_PATTERN = /pixel|dimension|width|height|\d{3,4}x\d{3,4}/iu;
const RESOLUTION_LABEL_PATTERN = /像素尺寸|像素|分辨率尺寸|宽高|尺寸\(像素\)|分辨率/iu;

export function isUserFacingParameter(
  parameter: ModelParameter,
  options: { exposeDimensions?: boolean } = {},
) {
  const name = parameter.name.trim().toLowerCase();
  if (TRANSPORT_FORMAT_PARAMETER_NAMES.has(name)) return false;
  if (TRANSPORT_FORMAT_NAME_PATTERN.test(name)) return false;
  const label = (parameter.label ?? "").toLowerCase();
  if (TRANSPORT_FORMAT_LABEL_PATTERN.test(label)) return false;
  // 工作台需要精确的分辨率/尺寸控制，这里只保留传输格式的隐藏。
  if (options.exposeDimensions) return true;
  if (RESOLUTION_PARAMETER_NAMES.has(name)) return false;
  if (RESOLUTION_NAME_PATTERN.test(name)) return false;
  if (RESOLUTION_LABEL_PATTERN.test(label)) return false;
  return true;
}

export function defaultModelParameters(model: PublicModel) {
  return canonicalizeConfiguredValues(model, {});
}

/**
 * Parameters for a freshly auto-picked model. Remembered parameters from the
 * creator's last session are overlaid on the model defaults (validated against
 * this model), then the creator's 默认画幅 wins for the aspect parameter so
 * new media nodes generate in the configured frame instead of the model's
 *出厂默认比例. Returns null-safe parameters even when nothing is remembered.
 */
export function autoPickGenerationSettings(input: {
  model: PublicModel;
  remembered: { parameters: Record<string, unknown> } | null;
  defaultAspectRatio: DefaultNodeAspectRatio | null;
}) {
  const seeded = canonicalizeConfiguredValues(input.model, input.remembered?.parameters ?? {});
  const aspectParameter = modelAspectRatioParameter(input.model);
  const defaultAspectRatio = input.defaultAspectRatio;
  if (
    aspectParameter &&
    defaultAspectRatio &&
    aspectParameter.options?.some(
      (option) =>
        typeof option === "string" && option.toLowerCase() === defaultAspectRatio.toLowerCase(),
    )
  ) {
    seeded[aspectParameter.name] = defaultAspectRatio;
  }
  return seeded;
}

function modelAspectRatioParameter(model: PublicModel): ModelParameter | null {
  return (
    model.parameters.find(
      (parameter) =>
        parameter.fixed === undefined &&
        canonicalParameterName(model, parameter.name) === parameter.name &&
        (mediaAspectRatioParameterNames as readonly string[]).includes(parameter.name),
    ) ?? null
  );
}

export function reconcileModelParameters(model: PublicModel, current: Record<string, unknown>) {
  return canonicalizeConfiguredValues(model, current);
}

export function composeModelParameters(
  model: PublicModel,
  body: string,
  configured: Record<string, unknown>,
) {
  const parameters: Record<string, unknown> = {};
  const synchronized = canonicalizeConfiguredValues(model, configured);
  const textParameterName = primaryTextParameterName(model);
  for (const parameter of model.parameters) {
    if (
      isModelMediaReferenceParameter(model, parameter) ||
      canonicalParameterName(model, parameter.name) !== parameter.name
    )
      continue;
    let value: unknown;
    if (parameter.fixed !== undefined) value = parameter.fixed;
    else if (parameter.name === textParameterName && MESSAGE_PARAMETERS.has(parameter.name))
      value = [{ role: "user", content: body }];
    else if (parameter.name === textParameterName) value = body;
    else
      value = firstValidParameterValue(
        model,
        parameter,
        Object.hasOwn(synchronized, parameter.name) ? synchronized[parameter.name] : undefined,
        parameter.default,
        // 只给「必填但目录没给默认值」的枚举兜底第一项；可选枚举（如 Midjourney 的
        // 后续动作/平移方向/融图画幅）不填就绝不提交——以前一律兜底 options[0]，
        // 普通生成会携带 action=upscale 等二次操作参数，语义完全错误。
        parameter.required ? parameter.options?.[0] : undefined,
        defaultBoundedDurationValue(model, parameter),
      );
    if (
      value !== undefined &&
      !(typeof value === "string" && value === "" && !parameter.required)
    ) {
      parameters[parameter.name] = value;
    }
  }
  return parameters;
}

export function estimateInputTokens(text: string) {
  if (!text) return 1;
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + other * 1.15 + 12));
}

export function estimateMaximumOutputTokens(
  model: PublicModel,
  configured: Record<string, unknown>,
  explicit: number | null,
) {
  if (explicit) return explicit;
  for (const name of ["max_output_tokens", "max_tokens"]) {
    const value =
      configured[name] ?? model.parameters.find((parameter) => parameter.name === name)?.default;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return 1_024;
}

export function quoteTokenFields(
  model: PublicModel,
  body: string,
  configured: Record<string, unknown>,
  explicitMaximum: number | null,
): Pick<GenerationQuoteRequest, "inputTokens" | "maxOutputTokens"> {
  if (model.pricing.mode !== "token") return {};
  return {
    inputTokens: estimateInputTokens(body),
    maxOutputTokens: estimateMaximumOutputTokens(model, configured, explicitMaximum),
  };
}

export function setExclusiveParameter(
  model: PublicModel,
  current: Record<string, unknown>,
  name: string,
  value: unknown,
) {
  const canonicalName = canonicalParameterName(model, name);
  const next = { ...current, [canonicalName]: value };
  if (canonicalName !== name) delete next[name];
  if (!hasValue(value)) return next;
  const parameter = model.parameters.find((item) => item.name === canonicalName);
  for (const excluded of parameter?.mutuallyExclusiveWith ?? []) delete next[excluded];
  return canonicalizeConfiguredValues(model, next, false);
}

export function removeModelParameter(
  model: PublicModel,
  current: Record<string, unknown>,
  name: string,
) {
  const canonicalName = canonicalParameterName(model, name);
  const family = aliasFamily(model, canonicalName);
  // 别名族整体移除；同时必须移除参数本身——普通参数（无别名族，如 Midjourney 的
  // action）以前只靠 family 过滤，等于永远删不掉，取消选择后值会残留在提交里。
  const removed = new Set(family.map((parameter) => parameter.name));
  removed.add(canonicalName);
  const next = Object.fromEntries(Object.entries(current).filter(([key]) => !removed.has(key)));
  return canonicalizeConfiguredValues(model, next, false);
}

function hasValue(value: unknown) {
  if (value === undefined || value === null || value === "" || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function matchesParameterType(parameter: ModelParameter, value: unknown) {
  if (value === undefined) return false;
  if (parameter.type === "string") return typeof value === "string";
  if (parameter.type === "number" || parameter.type === "integer")
    return typeof value === "number" && Number.isFinite(value);
  if (parameter.type === "boolean") return typeof value === "boolean";
  if (parameter.type === "array") return Array.isArray(value);
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstValidParameterValue(
  model: PublicModel,
  parameter: ModelParameter,
  ...candidates: unknown[]
) {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const normalized = normalizeModelParameterValue(model, parameter, candidate);
    if (!matchesParameterType(parameter, normalized)) continue;
    const canonicalOption = parameter.options?.find(
      (option) =>
        Object.is(option, normalized) ||
        (typeof option === "string" &&
          typeof normalized === "string" &&
          option.toLowerCase() === normalized.toLowerCase()),
    );
    if (parameter.options?.length && canonicalOption === undefined) continue;
    if (typeof normalized === "number") {
      const rounded = parameter.type === "integer" ? Math.round(normalized) : normalized;
      return Math.min(parameter.max ?? rounded, Math.max(parameter.min ?? rounded, rounded));
    }
    return structuredClone(canonicalOption ?? normalized);
  }
  return undefined;
}

function primaryTextParameterName(model: PublicModel) {
  const known = model.parameters.find(
    (parameter) =>
      isBoundTextParameter(parameter) && !isModelMediaReferenceParameter(model, parameter),
  );
  if (known) return known.name;
  if (!model.input.textRequired) return null;
  return (
    model.parameters.find((parameter) => parameter.required && parameter.type === "string")?.name ??
    null
  );
}

function hasModelMediaInput(model: PublicModel) {
  return [model.input.images, model.input.videos, model.input.audios].some(acceptsMediaInput);
}

function acceptsMediaInput(input: PublicModel["input"]["images"]) {
  return input !== undefined && input.max !== 0;
}

function normalizeModelParameterValue(
  model: PublicModel,
  parameter: ModelParameter,
  value: unknown,
) {
  return model.modality === "video" || model.modality === "audio"
    ? normalizeBoundedDurationValue(parameter, value)
    : value;
}

function canonicalizeConfiguredValues(
  model: PublicModel,
  current: Record<string, unknown>,
  includeDefaults = true,
) {
  const next: Record<string, unknown> = {};
  for (const parameter of model.parameters) {
    if (
      isModelBoundTextParameter(model, parameter) ||
      isModelMediaReferenceParameter(model, parameter) ||
      parameter.fixed !== undefined ||
      canonicalParameterName(model, parameter.name) !== parameter.name
    )
      continue;
    const family = aliasFamily(model, parameter.name);
    const candidates = family.length > 1 ? family : [parameter];
    const savedNames = aliasNames(parameter.name) ?? new Set([parameter.name]);
    const values: unknown[] = [];
    for (const savedName of savedNames) {
      if (Object.hasOwn(current, savedName))
        values.push(convertAliasValue(parameter, current[savedName]));
    }
    if (
      ASPECT_RATIO_PARAMETER_NAMES.has(parameter.name) &&
      !model.parameters.some((candidate) => DIMENSION_PARAMETER_NAMES.has(candidate.name))
    ) {
      for (const dimensionName of DIMENSION_PARAMETER_NAMES) {
        if (!Object.hasOwn(current, dimensionName)) continue;
        const ratio = aspectRatioFromDimension(current[dimensionName]);
        if (ratio !== undefined) values.push(ratio);
      }
    }
    if (includeDefaults) {
      for (const candidate of candidates) {
        // 与 composeModelParameters 同一口径：可选枚举不默认第一项，避免把
        // 「后续动作/平移方向」这类二次操作参数悄悄预选进面板状态。
        values.push(
          candidate.default,
          candidate.required ? candidate.options?.[0] : undefined,
          defaultBoundedDurationValue(model, candidate),
        );
      }
    }
    const value = firstValidParameterValue(model, parameter, ...values);
    if (value !== undefined) next[parameter.name] = value;
  }
  return next;
}

function aliasFamily(model: PublicModel, name: string) {
  const names = aliasNames(name);
  return names ? model.parameters.filter((parameter) => names.has(parameter.name)) : [];
}

function aliasNames(name: string) {
  return DURATION_PARAMETER_NAMES.has(name)
    ? DURATION_PARAMETER_NAMES
    : ASPECT_RATIO_PARAMETER_NAMES.has(name)
      ? ASPECT_RATIO_PARAMETER_NAMES
      : DIMENSION_PARAMETER_NAMES.has(name)
        ? DIMENSION_PARAMETER_NAMES
        : undefined;
}

function canonicalParameterName(model: PublicModel, name: string) {
  const family = aliasFamily(model, name);
  if (family.length < 2) return name;
  if (DIMENSION_PARAMETER_NAMES.has(name)) {
    return family.find((parameter) => parameter.name === "resolution")?.name ?? family[0]!.name;
  }
  const nonCompatibility = family.filter(
    (parameter) => !COMPATIBILITY_LABEL_PATTERN.test(parameter.label),
  );
  if (nonCompatibility.length === 1) return nonCompatibility[0]!.name;
  if (DURATION_PARAMETER_NAMES.has(name))
    return (
      family.find((parameter) => parameter.name === "duration_seconds")?.name ??
      family.find((parameter) => parameter.name === "seconds")?.name ??
      family[0]!.name
    );
  if (ASPECT_RATIO_PARAMETER_NAMES.has(name))
    return (
      family.find((parameter) => parameter.name === "aspect_ratio")?.name ??
      family.find((parameter) => parameter.name === "aspectRatio")?.name ??
      family[0]!.name
    );
  return family[0]!.name;
}

function convertAliasValue(parameter: ModelParameter, value: unknown) {
  if (parameter.type === "string" && typeof value === "number") return String(value);
  if (
    (parameter.type === "number" || parameter.type === "integer") &&
    typeof value === "string" &&
    value.trim()
  ) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return value;
}

function aspectRatioFromDimension(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)\s*[x*×]\s*(\d+)$/iu.exec(value.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    return undefined;
  let left = width;
  let right = height;
  while (right !== 0) [left, right] = [right, left % right];
  return `${width / left}:${height / left}`;
}

function defaultBoundedDurationValue(model: PublicModel, parameter: ModelParameter) {
  if (model.modality !== "video" && model.modality !== "audio") return undefined;
  if (!DURATION_PARAMETER_NAMES.has(parameter.name.toLowerCase())) return undefined;
  return normalizeBoundedDurationValue(parameter, undefined);
}
