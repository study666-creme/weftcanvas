import { createHash } from "node:crypto";

import {
  modelParameterSchema,
  modelPricingSchema,
  publicModelCatalogSchema,
  publicModelSchema,
  isAllowedAudioEndpoint,
  type ModelInputCount,
  type ModelParameter,
  type ModelReferenceImageInput,
  type ModelReferenceMedia,
  type PublicModel,
  type PublicModelCatalog,
} from "@weftcanvas/contracts";

import {
  sourceCatalogModelSchema,
  sourceCatalogSchema,
  type SourceCatalogModel,
} from "./source-schema.js";
import { applyRawIdLabels, applySeedanceSplitOverlay } from "./seedance-overlay.js";
import type { StoredCatalogSnapshot } from "./store.js";

// Bump when compatibility aliases, labels, pricing, or the reviewed public
// projection change so a persisted snapshot is refreshed instead of serving
// stale metadata or stale prices.
// 21: pricing 带上站点的元/秒参考价与说明（token 计价的视频模型靠它报价）。
// 22: MiniMax H3 的计价单位按站点口径纠正为按秒（目录发布的是按次，站点
//     overlay 的 priceUnitOverride 负责）。必须 bump：不 bump 的话已持久化
//     的快照会继续按旧口径（按次）报价，等于修复不生效。
// 23: 上游目录容错（d5eacd4：书信字段一律推导），快照按新解析口径刷新。
// 24: 音频模型进入执行白名单（chat/completions 返回链接、Gemini 原生返回内联
//     PCM），目录不再丢弃它们，并给音频模型挂上 audio.v1 协议。
export const CATALOG_NORMALIZATION_VERSION = 24;

/** 站点 overlay 可以抬高效版本号，让带策展规则的快照独立失效。 */
export function catalogNormalizationVersion(overlay?: CatalogCompatibilityOverlay) {
  return CATALOG_NORMALIZATION_VERSION + (overlay?.versionOffset ?? 0);
}

export type ParsedSourceCatalog = ReturnType<typeof sourceCatalogSchema.parse>;

/**
 * 站点策展兼容层（docs/PLUGIN-ROADMAP.md §5 P2 遗留项的落点）：私有 overlay
 * 注入托管站点的策展规则（兼容模型注入、品牌化改写、计价单位口径、旧快照
 * 迁移）。公开树缺省不注入——归一化只做结构性转换，不携带任何站点策展与
 * 零售计价规则。
 */
export type CatalogCompatibilityOverlay = {
  /** overlay 的策展规则变化时递增，让带 overlay 的快照独立失效。 */
  versionOffset?: number;
  /** 向解析后的 source 注入上游缺失、站点仍提供的兼容模型。 */
  addKnownModels?(
    source: ParsedSourceCatalog,
    options: { includeKnownModels: boolean },
  ): ParsedSourceCatalog;
  /**
   * 策展过滤：整条源模型出门前的最后一次取舍（合规口径、只保留某几家的模型等）。
   * 返回的列表决定后面的一切——公开目录、私有路由、计价只认过滤后的结果，被删掉
   * 的模型不会留下半截痕迹。
   */
  filterSourceModels?(
    source: ParsedSourceCatalog,
    options: { includeKnownModels: boolean },
  ): ParsedSourceCatalog;
  /** 逐模型兼容改写（品牌化、固定输出契约等）。 */
  applyModelCompatibility?(
    model: SourceCatalogModel,
    options: { includeKnownModels: boolean },
  ): SourceCatalogModel;
  /** 按站点口径修正计价单位（返回 undefined = 沿用上游发布的单位）。 */
  priceUnitOverride?(
    model: SourceCatalogModel,
    publishedUnit: SourceCatalogModel["pricing"]["unit"],
  ): SourceCatalogModel["pricing"]["unit"] | undefined;
  /** 原始模型行级别的站点兼容注入（sanitize 阶段）。 */
  ensureRawCompatibilityModels?(
    models: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>>;
  /** 旧快照的站点兼容迁移（载入阶段）；未注入 = 原样使用快照。 */
  ensureSnapshotCompatibility?(snapshot: StoredCatalogSnapshot): StoredCatalogSnapshot;
};

const MEDIA_REFERENCE_PARAMETER_NAME = /^(?:reference|ref)(image|video|audio)s?(?:url)?s?$/;
const BARE_MEDIA_PARAMETER_NAME = /^(image|video|audio)(?:s|urls?)?$/;
const POSITIONED_IMAGE_PARAMETER_NAME =
  /^(first|start|last|end)(?:(?:frame)(?:image)?|image)(?:url)?$/;
const SPECIALIZED_IMAGE_PARAMETER_NAME = /^(style|element)(?:references?|images?)(?:url)?s?$/;
const INPUT_MEDIA_PARAMETER_NAME = /^(?:input|source)(image|video|audio)(?:url)?s?$/;
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ENDPOINT_BY_MODALITY = {
  text: new Set(["/v1/chat/completions"]),
  image: new Set(["/v1/images/generations", "/v1/midjourney/generations"]),
  video: new Set(["/v1/videos"]),
  audio: new Set(["/v1/chat/completions"]),
} as const;

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

export function normalizeSourceCatalog(
  value: unknown,
  options: {
    validatedAt: number;
    maxQuoteAgeMs: number;
    etag?: string;
    includeKnownModels?: boolean;
    /** 站点策展兼容层；公开/自托管缺省不注入。 */
    overlay?: CatalogCompatibilityOverlay;
  },
): StoredCatalogSnapshot {
  const overlay = options.overlay;
  const parsed = applyRawIdLabels(
    applySeedanceSplitOverlay(sourceCatalogSchema.parse(sanitizeSourceCatalog(value, overlay))),
  );
  const source =
    overlay?.addKnownModels?.(parsed, {
      includeKnownModels: Boolean(options.includeKnownModels),
    }) ?? parsed;
  // 上游一行模型都没给 = 拿到的是半截目录（例如 OpenAI 风格的 data[] 没带计价），
  // 宁可报错保留上一份快照，也不要发布一份"看起来正常的空目录"。
  if (!source.models.length) throw new CatalogValidationError("Catalog contains no models");
  const curated =
    overlay?.filterSourceModels?.(source, {
      includeKnownModels: Boolean(options.includeKnownModels),
    }) ?? source;
  const sourceModels: Record<string, string> = {};
  const routes: StoredCatalogSnapshot["routes"] = {};
  const publicModels: PublicModel[] = [];
  const usedIds = new Set<string>();

  for (const sourceModel of curated.models) {
    const model =
      overlay?.applyModelCompatibility?.(sourceModel, {
        includeKnownModels: Boolean(options.includeKnownModels),
      }) ?? sourceModel;
    if (model.selectable === false || !model.public) continue;
    let route: StoredCatalogSnapshot["routes"][string];
    try {
      route = normalizePrivateRoute(model);
    } catch (error) {
      if (error instanceof CatalogValidationError) continue;
      throw error;
    }
    const publicId = model.public.id.trim();
    if (usedIds.has(publicId))
      throw new CatalogValidationError(`Duplicate public model id: ${publicId}`);
    usedIds.add(publicId);
    sourceModels[publicId] = model.id;
    routes[publicId] = route;
    publicModels.push(normalizeModel(model, source.credits_per_yuan, overlay));
  }

  // 上游给了可选模型却一个都没发布出来 = 目录坏了，宁可保留上一份快照；策展层
  // 主动清空（站点选择不上架任何模型）不在此列——那是一份合法的空目录。
  if (!publicModels.length && curated.models.length)
    throw new CatalogValidationError("Catalog contains no selectable public models");
  publicModels.sort(
    (left, right) => left.order - right.order || left.label.localeCompare(right.label, "zh-CN"),
  );

  const pricingVersion = source.pricing_version.trim()
    ? source.pricing_version
    : // 空目录没有可聚合的价格内容，别让 derivePricingVersion([]) 造一个假版本号。
      publicModels.length
      ? derivePricingVersion(publicModels, source.credits_per_yuan)
      : "empty-catalog";

  const catalog = publicModelCatalogSchema.parse({
    version: source.version,
    capabilityVersion: source.capability_version,
    pricingVersion,
    fetchedAt: source.fetched_at,
    expiresAt: new Date(options.validatedAt + options.maxQuoteAgeMs).toISOString(),
    quoteAvailable: true,
    models: publicModels,
  });

  return {
    catalog,
    sourceModels,
    routes,
    etag: options.etag,
    validatedAt: options.validatedAt,
    normalizationVersion: catalogNormalizationVersion(overlay),
  };
}

type SourceParameter = SourceCatalogModel["parameters"][number];

const PUBLIC_PARAMETER_ALIAS_FAMILIES: readonly (readonly string[])[] = [
  ["duration_seconds", "seconds", "duration"],
  ["aspect_ratio", "aspectRatio", "ratio"],
  ["size", "resolution"],
];

const COMPATIBILITY_LABEL_PATTERN = /兼容(?:字段|别名|比例)/u;

const CANONICAL_PUBLIC_PARAMETER_LABELS: Readonly<Record<string, string>> = {
  duration_seconds: "时长（秒）",
  seconds: "时长（秒）",
  duration: "时长（秒）",
  aspect_ratio: "画面比例",
  aspectRatio: "画面比例",
  ratio: "画面比例",
  size: "画面尺寸",
  resolution: "分辨率",
};

/** 上游把「同时发布了按次零售价」标记在 tags 里；缺 tags 时视为没有按次价。 */
function hasPerRequestTag(tags: string | undefined) {
  return (tags ?? "").split(",").some((tag) => tag.trim().toLowerCase() === "per-request");
}

/** 内部导出：站点 overlay 的旧快照迁移复用同一套模型归一化。 */
export function normalizeModel(
  model: SourceCatalogModel,
  catalogCreditsPerYuan: number,
  overlay?: CatalogCompatibilityOverlay,
) {
  const sourceParameters = projectPublicParameters(model);
  const parameters = sourceParameters
    .filter(
      (parameter) =>
        parameter.name !== "model" &&
        !isMediaParameter(
          parameter.name,
          parameter.format ?? parameter.items?.format,
          parameter.path,
        ),
    )
    .map(normalizeParameter);
  const inferredResolution = fixedResolutionFromModelId(model);
  if (inferredResolution && !hasDeclaredResolution(parameters)) {
    parameters.push(
      modelParameterSchema.parse({
        name: "resolution",
        label: "分辨率",
        type: "string",
        required: false,
        fixed: inferredResolution,
        mutuallyExclusiveWith: [],
      }),
    );
  }
  const outputCount = model.output.count;
  const fixedCount = outputCount?.fixed;
  const protocol = model.protocol ?? imageProtocolForModel(model);
  // 音频协议从输出契约推导：内联数据（Gemini 原生 PCM）还是有时效链接（suno）。
  const audioProtocol =
    model.modality === "audio"
      ? {
          version: "audio.v1" as const,
          outputFormat:
            model.output.format === "inline-data" ? ("inline-data" as const) : ("url" as const),
        }
      : null;
  return publicModelSchema.parse({
    id: model.public!.id,
    label: model.public!.label,
    description: model.public!.description ?? "",
    modality: model.modality,
    operation: model.operation,
    order: model.order ?? 0,
    ...(model.listed === false ? { listed: false } : {}),
    ...(hasPerRequestTag(model.tags) ? { perRequest: true } : {}),
    ...(audioProtocol
      ? { protocol: audioProtocol }
      : protocol
        ? {
            protocol: {
              version: protocol.version,
              endpoint: protocol.endpoint,
              mediaRoles: protocol.media_roles,
            },
          }
        : {}),
    input: {
      textRequired: model.input?.text?.required === true,
      images: normalizeInputCount(model, "images"),
      videos: normalizeInputCount(model, "videos"),
      audios: normalizeInputCount(model, "audios"),
      referenceMedia: normalizeReferenceMedia(model),
    },
    output: {
      type: model.output.type,
      minCount: fixedCount ?? outputCount?.min ?? 1,
      maxCount: fixedCount ?? outputCount?.max ?? 1,
    },
    parameters,
    pricing: normalizePricing(model, catalogCreditsPerYuan, publicParameterAliases(model), overlay),
  });
}

function imageProtocolForModel(model: SourceCatalogModel) {
  if (model.modality !== "image") return undefined;
  const path = model.endpoint?.path;
  if (
    path !== "/v1/images/generations" &&
    path !== "/v1/chat/completions" &&
    path !== "/v1/midjourney/generations"
  ) {
    return undefined;
  }
  const roles = new Set<"reference" | "style_reference" | "element_reference" | "mask">();
  for (const parameter of model.parameters) {
    const name = `${parameter.name} ${parameter.path ?? ""}`.replaceAll("_", "").toLowerCase();
    if (/(?:mask|inpaint)/.test(name)) roles.add("mask");
    else if (/style(?:reference|image)/.test(name)) roles.add("style_reference");
    else if (/element(?:reference|image)/.test(name)) roles.add("element_reference");
    else if (
      isMediaParameter(parameter.name, parameter.format ?? parameter.items?.format, parameter.path)
    )
      roles.add("reference");
  }
  if (!roles.size) roles.add("reference");
  return {
    version: "image.v1" as const,
    endpoint: { method: "POST" as const, path },
    media_roles: [...roles],
  };
}

/**
 * The browser contract has one field per documented concept. Provider route
 * metadata remains untouched in the private snapshot, so aliases can still
 * be translated by an execution adapter without becoming user-selectable
 * Canvas parameters.
 */
function projectPublicParameters(model: SourceCatalogModel) {
  const publicModel = canonicalizePublicImageParameters(model);
  const aliases = publicParameterAliases(publicModel);
  const canonicalNames = new Set(aliases.values());
  return publicModel.parameters
    .filter((parameter) => !aliases.has(parameter.name.trim()))
    .map((parameter) => {
      const name = parameter.name.trim();
      if (!canonicalNames.has(name) || !isCompatibilityParameter(parameter)) return parameter;
      return { ...parameter, label: CANONICAL_PUBLIC_PARAMETER_LABELS[name] ?? parameter.label };
    });
}

/**
 * Canvas exposes provider-neutral image intent. Image providers historically
 * put ratios in `size`, while resolution is a separate quality tier. Promote
 * ratio-valued size fields to the canonical `aspect_ratio` dropdown and hide
 * pixel-size/alias fields from the browser. The private execution route keeps
 * the original names, so this is a presentation/protocol projection only.
 */
function canonicalizePublicImageParameters(model: SourceCatalogModel): SourceCatalogModel {
  if (model.modality !== "image") return model;

  let parameters = [...model.parameters];
  const aspect = parameters.find((parameter) => parameter.name.trim() === "aspect_ratio");
  const ratioAlias = parameters.find((parameter) => parameter.name.trim() === "ratio");
  const size = parameters.find((parameter) => parameter.name.trim() === "size");
  const hasRatioOptions =
    Boolean(size?.options?.length) &&
    size!.options!.every(
      (option) => typeof option === "string" && /^(?:auto|\d+:\d+)$/u.test(option),
    );

  if (!aspect && !ratioAlias && size && hasRatioOptions) {
    parameters = parameters.map((parameter) =>
      parameter === size
        ? {
            ...parameter,
            name: "aspect_ratio",
            path: "aspect_ratio",
            label: "画面比例",
          }
        : parameter,
    );
  } else if (!aspect && ratioAlias) {
    parameters = parameters.map((parameter) =>
      parameter === ratioAlias
        ? {
            ...parameter,
            name: "aspect_ratio",
            path: "aspect_ratio",
            label: "画面比例",
          }
        : parameter,
    );
  }

  const hasCanonicalAspect = parameters.some(
    (parameter) => parameter.name.trim() === "aspect_ratio",
  );
  if (hasCanonicalAspect) {
    parameters = parameters.filter(
      (parameter) => !["size", "aspectRatio", "ratio"].includes(parameter.name.trim()),
    );
  }
  return parameters === model.parameters ? model : { ...model, parameters };
}

function publicParameterAliases(model: SourceCatalogModel) {
  const aliases = new Map<string, string>();
  const requestExample =
    isRecord(model.documentation) && isRecord(model.documentation.request_example)
      ? model.documentation.request_example
      : undefined;
  for (const family of PUBLIC_PARAMETER_ALIAS_FAMILIES) {
    const parameters = model.parameters.filter((parameter) => family.includes(parameter.name));
    if (parameters.length < 2) continue;
    const documented = requestExample
      ? parameters.filter((parameter) => Object.hasOwn(requestExample, parameter.name))
      : [];
    let canonical: SourceParameter | undefined;
    if (
      family.includes("resolution") &&
      parameters.some((parameter) => parameter.name === "resolution")
    ) {
      canonical = parameters.find((parameter) => parameter.name === "resolution");
    } else if (documented.length === 1) {
      canonical = documented[0];
    } else {
      const nonCompatibility = parameters.filter(
        (parameter) => !isCompatibilityParameter(parameter),
      );
      if (nonCompatibility.length === 1) canonical = nonCompatibility[0];
      else if (family.includes("seconds"))
        canonical = parameters.find((parameter) => parameter.name === "seconds") ?? parameters[0];
      else if (family.includes("aspect_ratio"))
        canonical =
          parameters.find((parameter) => parameter.name === "aspect_ratio") ?? parameters[0];
      else
        canonical =
          parameters.find((parameter) => parameter.name === "resolution") ?? parameters[0];
    }
    if (!canonical) continue;
    for (const parameter of parameters) {
      if (parameter !== canonical) aliases.set(parameter.name.trim(), canonical.name.trim());
    }
  }
  return aliases;
}

function isCompatibilityParameter(parameter: SourceParameter) {
  return (
    COMPATIBILITY_LABEL_PATTERN.test(parameter.label ?? "") ||
    /(?:compat|alias)/iu.test(parameter.label ?? "")
  );
}

type MediaKind = "image" | "video" | "audio";
type MediaPosition = "reference" | "first" | "last" | "style" | "element";
type MediaBinding = { kind: MediaKind; position: MediaPosition };
type ReferenceCountSource = { min?: number; max?: number; multiple?: boolean; role?: string };
type BindableMediaParameter = {
  parameter: SourceParameter;
  path: string;
  binding: MediaBinding;
};

function normalizeReferenceMedia(model: SourceCatalogModel): ModelReferenceMedia | undefined {
  const mediaParameters = bindableMediaParameters(model);
  const source = model.input?.reference_media;
  if (!mediaParameters.length && !source) return undefined;
  const images = normalizeReferenceInputCount(
    mediaParameters.filter(
      ({ binding }) =>
        binding.kind === "image" && ["reference", "first", "last"].includes(binding.position),
    ),
    source?.images,
    "image",
    model.modality === "image" ? 0 : undefined,
  );
  const styleImages = normalizeReferenceInputCount(
    mediaParameters.filter(
      ({ binding }) => binding.kind === "image" && binding.position === "style",
    ),
    source?.style_images,
  );
  const elementImages = normalizeReferenceInputCount(
    mediaParameters.filter(
      ({ binding }) => binding.kind === "image" && binding.position === "element",
    ),
    source?.element_images,
  );
  const videos = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "video"),
    source?.videos,
  );
  const audios = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "audio"),
    source?.audios,
  );
  const parameterTotal = aggregateReferenceLimit(mediaParameters);
  const maxTotalItems = minimumDefined(parameterTotal, source?.max_total_items);

  return {
    ...(images ? { images } : {}),
    ...(styleImages ? { styleImages } : {}),
    ...(elementImages ? { elementImages } : {}),
    ...(videos ? { videos } : {}),
    ...(audios ? { audios } : {}),
    ...(maxTotalItems !== undefined ? { maxTotalItems } : {}),
  };
}

function normalizeReferenceInputCount(
  parameters: BindableMediaParameter[],
  source: ReferenceCountSource | undefined,
  kind?: "image",
  minimumOverride?: number,
): ModelReferenceImageInput | ModelInputCount | undefined {
  if (!parameters.length) {
    if (!source) return undefined;
    const max = source.max;
    return {
      min: max === 0 ? 0 : (minimumOverride ?? source.min ?? 0),
      ...(max !== undefined ? { max } : {}),
      multiple: source.multiple ?? (max !== undefined && max > 1),
      ...(kind === "image" && source.role ? { role: source.role } : {}),
    };
  }

  const uniqueParameters = [
    ...new Map(parameters.map((item) => [`${item.path}:${item.parameter.type}`, item])).values(),
  ];
  const positioned = uniqueParameters.filter(
    ({ binding }) => binding.position === "first" || binding.position === "last",
  );
  const arrayParameter = uniqueParameters.find(
    ({ parameter }) => parameter.type === "array",
  )?.parameter;
  const singleParameters = uniqueParameters.filter(({ parameter }) => parameter.type === "string");
  // When a route exposes both an all-purpose image array and optional
  // first/last fields, the provider binds ordinary Canvas references to the
  // array. Publish that real execution capacity instead of collapsing the
  // model to the two optional frame slots.
  const usesFrames = kind === "image" && !arrayParameter && positioned.length > 0;
  const inferredMin = usesFrames
    ? positioned.filter(({ parameter }) => parameter.required === true).length
    : arrayParameter
      ? Math.max(arrayParameter.min_items ?? 0, arrayParameter.required === true ? 1 : 0)
      : singleParameters.some(({ parameter }) => parameter.required === true)
        ? 1
        : 0;
  const inferredMax = usesFrames
    ? positioned.length
    : arrayParameter
      ? arrayParameter.max_items
      : 1;
  const max = minimumDefined(inferredMax, source?.max);
  const multiple = Boolean(
    (usesFrames
      ? positioned.length > 1
      : arrayParameter && (inferredMax === undefined || inferredMax > 1)) &&
    source?.multiple !== false &&
    (max === undefined || max > 1),
  );
  const role = usesFrames ? "frame" : kind === "image" ? source?.role : undefined;

  return {
    min: max === 0 ? 0 : (minimumOverride ?? Math.max(inferredMin, source?.min ?? 0)),
    ...(max !== undefined ? { max } : {}),
    multiple,
    ...(role ? { role } : {}),
  };
}

function bindableMediaParameters(model: SourceCatalogModel): BindableMediaParameter[] {
  return model.parameters.flatMap((parameter) => {
    if (
      (parameter.type !== "string" && parameter.type !== "array") ||
      parameter.fixed !== undefined
    )
      return [];
    const binding = mediaParameterBinding(
      parameter.name,
      parameter.format ?? parameter.items?.format,
      parameter.path,
    );
    if (!binding) return [];
    return [{ parameter, path: parameter.path ?? parameter.name, binding }];
  });
}

function aggregateReferenceLimit(parameters: BindableMediaParameter[]) {
  const declaredPaths = new Set(parameters.map(({ path }) => path.trim()));
  const limits: number[] = [];
  for (const { parameter } of parameters) {
    const constraints = [
      parameter.aggregate_constraint
        ? {
            fields: parameter.aggregate_constraint.fields,
            max: parameter.aggregate_constraint.max_total_items,
          }
        : undefined,
      parameter.aggregateConstraint
        ? {
            fields: parameter.aggregateConstraint.fields,
            max: parameter.aggregateConstraint.maxTotalItems,
          }
        : undefined,
    ];
    for (const constraint of constraints) {
      if (!constraint) continue;
      const fields = new Set(constraint.fields.map((field) => field.trim()));
      if (
        [...declaredPaths].every((path) => fields.has(path) || fields.has(path.split(".").at(-1)!))
      ) {
        limits.push(constraint.max);
      }
    }
  }
  return limits.length ? Math.min(...limits) : undefined;
}

function minimumDefined(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function fixedResolutionFromModelId(model: SourceCatalogModel) {
  if (model.modality !== "image") return null;
  const candidates = [model.public?.id ?? "", model.id];
  for (const candidate of candidates) {
    const resolution = candidate.toLowerCase().match(/(?:^|[-_])(1k|2k|4k)(?:[-_]|$)/)?.[1];
    if (resolution === "1k" || resolution === "2k" || resolution === "4k") return resolution;
  }
  return null;
}

function hasDeclaredResolution(parameters: ModelParameter[]) {
  return parameters.some((parameter) => {
    if (["resolution", "size"].includes(parameter.name.trim().toLowerCase())) return true;
    if (parameter.name.trim().toLowerCase() !== "quality") return false;
    const values = [parameter.fixed, parameter.default, ...(parameter.options ?? [])].map(
      (value) => (typeof value === "string" ? value.toLowerCase() : ""),
    );
    return values.some((value) => value === "1k" || value === "2k" || value === "4k");
  });
}

function normalizeParameter(parameter: SourceCatalogModel["parameters"][number]): ModelParameter {
  return modelParameterSchema.parse({
    name: parameter.name,
    label: parameter.label ?? parameter.name,
    type: parameter.type,
    required: parameter.required ?? false,
    default: parameter.default,
    fixed: parameter.fixed,
    options: parameter.options,
    min: parameter.min,
    max: parameter.max,
    step: parameter.step,
    minLength: parameter.min_length,
    maxLength: parameter.max_length,
    minItems: parameter.min_items,
    maxItems: parameter.max_items,
    format: parameter.format,
    items: parameter.items,
    mutuallyExclusiveWith: parameter.mutually_exclusive_with ?? [],
  });
}

/** 内部导出：站点 overlay 的旧快照迁移复用同一路由归一化。 */
export function normalizePrivateRoute(
  model: SourceCatalogModel,
): StoredCatalogSnapshot["routes"][string] {
  const expectedPath = ENDPOINT_BY_MODALITY[model.modality as keyof typeof ENDPOINT_BY_MODALITY];
  const path = model.endpoint?.path;
  // 音频多一种端点形态：Gemini 原生 generateContent（路径含模型 id，用严格
  // 正则匹配，防任意路径注入），其余模态仍按白名单精确匹配。
  const endpointAllowed =
    model.modality === "audio" && path
      ? isAllowedAudioEndpoint(path)
      : Boolean(expectedPath && path && expectedPath.has(path));
  if (!model.endpoint || !endpointAllowed) {
    throw new CatalogValidationError(
      `Unsupported execution endpoint for public model ${model.public?.id ?? model.id}`,
    );
  }
  const modelParameter = model.parameters.find((parameter) => parameter.name === "model");
  if (!modelParameter || modelParameter.fixed !== model.id) {
    throw new CatalogValidationError(
      `Public model ${model.public?.id ?? model.id} has no fixed private model route`,
    );
  }
  return {
    sourceModelId: model.id,
    modality: model.modality,
    endpoint: {
      method: model.endpoint.method,
      path: model.endpoint.path,
      contentType: model.endpoint.content_type,
    },
    ...(model.modality === "audio"
      ? {
          audioOutput: {
            format:
              model.output.format === "inline-data" ? ("inline-data" as const) : ("url" as const),
            ...(model.output.sample_rate_hz ? { sampleRateHz: model.output.sample_rate_hz } : {}),
            ...(model.output.channels ? { channels: model.output.channels } : {}),
          },
        }
      : {}),
    parameters: model.parameters.map((parameter) => ({
      name: parameter.name,
      path: safeParameterPath(parameter.path ?? parameter.name),
      type: parameter.type,
      ...(parameter.fixed !== undefined ? { fixed: parameter.fixed } : {}),
      ...(parameter.default !== undefined ? { default: parameter.default } : {}),
      ...(parameter.format ? { format: parameter.format } : {}),
      ...(parameter.items?.format ? { itemsFormat: parameter.items.format } : {}),
    })),
  };
}

function safeParameterPath(value: string) {
  const segments = value.split(".");
  if (
    !segments.length ||
    segments.length > 8 ||
    segments.some(
      (segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || BLOCKED_PATH_SEGMENTS.has(segment),
    )
  ) {
    throw new CatalogValidationError(`Unsafe model parameter path: ${value}`);
  }
  return segments.join(".");
}

function normalizeInputCount(
  model: SourceCatalogModel,
  kind: "images" | "videos" | "audios",
): ModelInputCount | undefined {
  const source = model.input?.[kind];
  const mediaKind = kind.slice(0, -1) as "image" | "video" | "audio";
  const mediaParameters = model.parameters.filter((parameter) => {
    const binding = mediaParameterBinding(
      parameter.name,
      parameter.format ?? parameter.items?.format,
      parameter.path,
    );
    return (
      binding?.kind === mediaKind && binding.position !== "style" && binding.position !== "element"
    );
  });
  const arrayParameter = mediaParameters.find((parameter) => parameter.type === "array");
  const singleParameters = mediaParameters.filter((parameter) => parameter.type !== "array");
  if (!source && !mediaParameters.length) return undefined;
  const positionedCount = singleParameters.filter(
    (parameter) =>
      mediaParameterBinding(
        parameter.name,
        parameter.format ?? parameter.items?.format,
        parameter.path,
      )?.position !== "reference",
  ).length;
  const inferredMax = arrayParameter
    ? undefined
    : positionedCount || (singleParameters.length ? 1 : undefined);
  const max = source?.max ?? arrayParameter?.max_items ?? inferredMax;
  const minimum =
    model.modality === "image" && kind === "images"
      ? 0
      : (source?.min ?? arrayParameter?.min_items ?? 0);
  return {
    min: minimum,
    ...(max !== undefined ? { max } : {}),
    multiple: source?.multiple ?? Boolean(arrayParameter || positionedCount > 1),
  };
}

function normalizePricing(
  model: SourceCatalogModel,
  catalogCreditsPerYuan: number,
  aliases: ReadonlyMap<string, string>,
  overlay?: CatalogCompatibilityOverlay,
) {
  const pricing = model.pricing;
  const creditsPerYuan = Math.round(pricing.credits_per_yuan ?? catalogCreditsPerYuan);
  // 站点口径的单位修正（如 MiniMax H3 按秒）由 overlay 注入；缺省时上游发布
  // 的单位是唯一权威，绝不按 id 猜测改写。
  const unit = overlay?.priceUnitOverride?.(model, pricing.unit) ?? pricing.unit;
  // The upstream catalog uses `tiered_token` for token models whose rates can
  // vary by context tier.  The public contract currently has one token rate
  // pair, so expose the catalog's base rates (falling back to the first named
  // tier when a source omits the base fields) and keep the public mode stable.
  const publicMode = pricing.mode === "tiered_token" ? "token" : pricing.mode;
  const tokenTier =
    pricing.mode === "tiered_token" ? pricing.tiers?.find(isNamedTokenTier) : undefined;
  const inputCreditsPerMillion =
    pricing.input_credits_per_million ?? tokenTier?.input_credits_per_million;
  const outputCreditsPerMillion =
    pricing.output_credits_per_million ?? tokenTier?.output_credits_per_million;
  const inputYuanPerMillion = pricing.input_yuan_per_million ?? tokenTier?.input_yuan_per_million;
  const outputYuanPerMillion =
    pricing.output_yuan_per_million ?? tokenTier?.output_yuan_per_million;
  const estimatedYuanPerSecond =
    typeof pricing.estimated_yuan_per_second === "number" &&
    Number.isFinite(pricing.estimated_yuan_per_second) &&
    pricing.estimated_yuan_per_second >= 0
      ? pricing.estimated_yuan_per_second
      : undefined;
  const estimateNote =
    typeof pricing.estimate_note === "string" && pricing.estimate_note.trim()
      ? pricing.estimate_note.trim()
      : undefined;
  return modelPricingSchema.parse({
    mode: publicMode,
    unit,
    currency: "CNY",
    creditsPerYuan,
    ...(pricing.credits !== undefined ? { baseCreditMicros: toMicros(pricing.credits) } : {}),
    ...(pricing.yuan !== undefined ? { baseYuanMicros: toMicros(pricing.yuan) } : {}),
    // Named token tiers cannot be represented by the current public pricing
    // schema; their base rates above are still sufficient for token quotes.
    tiers:
      pricing.mode === "tiered_token"
        ? []
        : (pricing.tiers ?? []).filter(isConditionalTier).map((tier) => ({
            when: normalizePricingCondition(tier.when, aliases),
            creditMicros: toMicros(tier.credits),
            yuanMicros: toMicros(tier.yuan),
          })),
    ...(inputCreditsPerMillion !== undefined
      ? { inputCreditMicrosPerMillion: toMicros(inputCreditsPerMillion) }
      : {}),
    ...(outputCreditsPerMillion !== undefined
      ? { outputCreditMicrosPerMillion: toMicros(outputCreditsPerMillion) }
      : {}),
    ...(inputYuanPerMillion !== undefined
      ? { inputYuanMicrosPerMillion: toMicros(inputYuanPerMillion) }
      : {}),
    ...(outputYuanPerMillion !== undefined
      ? { outputYuanMicrosPerMillion: toMicros(outputYuanPerMillion) }
      : {}),
    // token 计价的视频模型没有可估算的浏览器侧 token 量，只能靠站点发布的
    // 元/秒参考价报价。丢掉这两个字段就等于让画布无价可报。
    ...(estimatedYuanPerSecond !== undefined
      ? { estimatedYuanMicrosPerSecond: toMicros(estimatedYuanPerSecond) }
      : {}),
    ...(estimateNote !== undefined ? { estimateNote } : {}),
  });
}

function normalizePricingCondition(
  condition: Record<string, string | number | boolean>,
  aliases: ReadonlyMap<string, string>,
) {
  const normalized: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(condition)) {
    const canonical = aliases.get(name) ?? name;
    // If a source tier contains both spellings, the documented canonical
    // field wins over its compatibility alias.
    if (Object.hasOwn(normalized, canonical) && canonical !== name) continue;
    normalized[canonical] = value;
  }
  return normalized;
}

type SourcePricingTier = NonNullable<SourceCatalogModel["pricing"]["tiers"]>[number];

function isNamedTokenTier(
  tier: SourcePricingTier,
): tier is Extract<SourcePricingTier, { name: string }> {
  return "name" in tier;
}

function isConditionalTier(
  tier: SourcePricingTier,
): tier is Extract<
  SourcePricingTier,
  { when: Record<string, unknown>; yuan: number; credits: number }
> {
  return "when" in tier && typeof tier.yuan === "number" && typeof tier.credits === "number";
}

function isMediaParameter(name: string, format?: string, path?: string) {
  return mediaParameterBinding(name, format, path) !== null;
}

function mediaParameterBinding(name: string, format?: string, path?: string): MediaBinding | null {
  const pathBinding = mediaBindingFromName(path?.split(".").at(-1));
  if (pathBinding) return pathBinding;
  const nameBinding = mediaBindingFromName(name);
  if (nameBinding) return nameBinding;
  const formatKind = /uri/i.test(format ?? "")
    ? /(image|video|audio)/i.exec(format ?? "")?.[1]?.toLowerCase()
    : undefined;
  return formatKind ? { kind: formatKind as MediaKind, position: "reference" } : null;
}

function mediaBindingFromName(value: string | undefined): MediaBinding | null {
  if (!value) return null;
  const normalizedName = value.replaceAll("_", "").toLowerCase();
  const specializedImage = SPECIALIZED_IMAGE_PARAMETER_NAME.exec(normalizedName)?.[1] as
    "style" | "element" | undefined;
  if (specializedImage) return { kind: "image", position: specializedImage };
  const positionedImage = POSITIONED_IMAGE_PARAMETER_NAME.exec(normalizedName)?.[1];
  if (positionedImage) {
    return {
      kind: "image",
      position: positionedImage === "first" || positionedImage === "start" ? "first" : "last",
    };
  }
  const inputKind = INPUT_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1] as MediaKind | undefined;
  if (inputKind) return { kind: inputKind, position: "reference" };
  const bareKind = BARE_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1] as MediaKind | undefined;
  if (bareKind) return { kind: bareKind, position: "reference" };
  const referenceKind = MEDIA_REFERENCE_PARAMETER_NAME.exec(normalizedName)?.[1] as
    MediaKind | undefined;
  if (referenceKind) return { kind: referenceKind, position: "reference" };
  return null;
}

// One malformed draft model must not invalidate an otherwise usable refresh.
// The top-level envelope remains strict; only independently invalid model rows
// are omitted before the complete catalog is parsed and normalized.
function sanitizeSourceCatalog(value: unknown, overlay?: CatalogCompatibilityOverlay) {
  const source = sanitizeCatalogAliases(value);
  if (!isRecord(source)) return source;
  const sanitizedModels = Array.isArray(source.models)
    ? source.models
        .map(sanitizeSourceModel)
        .filter((model): model is Record<string, unknown> => model !== null)
    : source.models;
  const models = Array.isArray(sanitizedModels)
    ? (overlay?.ensureRawCompatibilityModels?.(sanitizedModels) ?? sanitizedModels)
    : sanitizedModels;
  return {
    ...source,
    // Keep a valid non-empty upstream version untouched. An empty, missing, or
    // "unknown" sentinel version (any casing, with surrounding whitespace) stays
    // empty so normalization derives a content-based pricing version instead of
    // publishing a literal "unknown" that a selectable paid quote could carry.
    pricing_version: normalizeSourcePricingVersion(source.pricing_version),
    models,
  };
}

/**
 * 上游目录的书信字段各家写法不同，而这些都不影响"能不能用"——能推导的在这里推导掉，
 * 让接入方不必改成我们的格式（兼容而非特化）：
 *
 * - `models` 也接受 OpenAI 风格的 `data[]`（`/v1/models` 的返回体）；
 * - 版本/时间字段同时接受 snake_case 与 camelCase；
 * - 缺 `success` 视为成功（很多上游直接返回对象，没有信封）；
 * - 缺 `fetched_at` 用当前时间（它只表示这份快照何时取得）；
 * - 缺 `capability_version` / `version` 用内容摘要（内容变了才变，不伪造人造版本号）；
 * - 缺 `credits_per_yuan` 取 1（1 积分 = 1 元；这只是显示换算，不参与计费口径）。
 *
 * **推导的边界**：模型级价格（`pricing`）绝不猜——那是钱。缺价格的行会被跳过，
 * 具体是哪些模型、缺什么字段，由 `scripts/upstream-conformance.mjs` 明确列出。
 */
function sanitizeCatalogAliases(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const models = value.models ?? value.data;
  const version = firstNonEmptyString(value.version) ?? contentVersion(models);
  return {
    ...value,
    success: value.success ?? true,
    models,
    version,
    capability_version:
      firstNonEmptyString(value.capability_version, value.capabilityVersion) ??
      contentVersion(models),
    fetched_at: firstNonEmptyString(value.fetched_at, value.fetchedAt) ?? new Date().toISOString(),
    credits_per_yuan:
      typeof value.credits_per_yuan === "number"
        ? value.credits_per_yuan
        : typeof value.creditsPerYuan === "number"
          ? value.creditsPerYuan
          : 1,
    pricing_version: firstNonEmptyString(value.pricing_version, value.pricingVersion) ?? "",
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 内容摘要：上游没给目录版本时用它，内容变化即变化。 */
function contentVersion(models: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(models ?? null))
    .digest("hex");
  return `content:${digest.slice(0, 16)}`;
}

function normalizeSourcePricingVersion(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "unknown" ? "" : trimmed;
}

function sanitizeSourceModel(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value.pricing)) return null;
  // `tiered_token` is the source shape for token models whose per-million rates
  // vary by context tier; normalizePricing folds it into the public `token`
  // mode. Dropping it here silently removed every such model from the picker
  // (2026-09-20: all four Gemini lines plus GPT-5.6 Sol), so it must survive.
  if (!(["fixed", "tiered", "token", "tiered_token"] as unknown[]).includes(value.pricing.mode))
    return null;
  if (!(["request", "image", "second", "token"] as unknown[]).includes(value.pricing.unit))
    return null;
  const pricing = { ...value.pricing };
  if (Array.isArray(pricing.tiers)) {
    pricing.tiers = pricing.tiers.filter(
      (tier) =>
        isRecord(tier) &&
        isRecord(tier.when) &&
        typeof tier.yuan === "number" &&
        Number.isFinite(tier.yuan) &&
        typeof tier.credits === "number" &&
        Number.isFinite(tier.credits),
    );
  }
  const publicValue = isRecord(value.public)
    ? {
        ...value.public,
        description: typeof value.public.description === "string" ? value.public.description : "",
      }
    : value.public;
  const order =
    typeof value.order === "number" && Number.isFinite(value.order)
      ? Math.round(value.order)
      : value.order;
  const candidate = { ...value, pricing, public: publicValue, order };
  return sourceCatalogModelSchema.safeParse(candidate).success ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toMicros(value: number) {
  return Math.round(value * 1_000_000);
}

export function withQuoteAvailability(catalog: PublicModelCatalog, now: number) {
  return publicModelCatalogSchema.parse({
    ...catalog,
    quoteAvailable: now < Date.parse(catalog.expiresAt),
  });
}

// When the upstream omits pricing_version, derive a deterministic version from
// the price-relevant content of the normalized public catalog so a quote can
// never carry an unknown version. The hash covers each selectable model's id,
// output count contract, and normalized pricing plus the catalog credit ratio;
// any price-relevant change therefore rotates the derived version, while
// timestamps and display fields stay out of the digest.
function derivePricingVersion(models: PublicModel[], creditsPerYuan: number) {
  const priceContent = {
    creditsPerYuan,
    models: models.map((model) => ({
      id: model.id,
      output: model.output,
      pricing: model.pricing,
    })),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(priceContent))
    .digest("hex")
    .slice(0, 16);
  return `content:${digest}`;
}
