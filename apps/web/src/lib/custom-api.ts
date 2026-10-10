import {
  customApiCatalogSchema,
  customApiFormatSchema,
  customApiImageResponseSchema,
  customApiTextResponseSchema,
  customApiVideoResponseSchema,
  buildImageProtocolRequest,
  buildVideoProtocolRequest,
  modelParameterSchema,
  publicModelSchema,
  type CanvasMedia,
  type CustomApiFormat,
  type CustomApiCatalogModelSource,
  type CustomApiCatalogParameterSource,
  type GenerationJobInput,
  type ModelInputCount,
  type ModelModality,
  type ModelReferenceImageInput,
  type ModelReferenceMedia,
  type PublicModel,
  type PublicModelCatalog,
  type VideoMediaInput,
  type ImageMediaInput,
} from "@kachang/contracts";

import { storeMedia } from "./media-store";

type MediaReferenceKind = "image" | "video" | "audio";

const EXPECTED_ENDPOINTS: Partial<Record<ModelModality, string | readonly string[]>> = {
  text: "/v1/chat/completions",
  image: "/v1/images/generations",
  video: "/v1/videos",
};
const IMAGE_ENDPOINTS = ["/v1/images/generations", "/v1/midjourney/generations"] as const;
const MEDIA_REFERENCE_PARAMETER_NAME = /^(?:reference|ref)(image|video|audio)s?(?:url)?s?$/;
const BARE_MEDIA_PARAMETER_NAME = /^(image|video|audio)(?:s|urls?)?$/;
const POSITIONED_IMAGE_PARAMETER_NAME = /^(first|start|last|end)(?:(?:frame)(?:image)?|image)(?:url)?$/;
const SPECIALIZED_IMAGE_PARAMETER_NAME = /^(style|element)(?:references?|images?)(?:url)?s?$/;
const INPUT_MEDIA_PARAMETER_NAME = /^(?:input|source)(image|video|audio)(?:url)?s?$/;
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const CATALOG_REQUEST_TIMEOUT_MS = 12_000;
const CONNECTION_CHECK_TIMEOUT_MS = 12_000;
const CUSTOM_MODEL_KEY_PREFIX = "custom:";
const GROK_IMAGINE_VIDEO_MODEL_ID = "grok-imagine-video";
const GROK_IMAGINE_VIDEO_15_MODEL_ID = "grok-imagine-video-1.5";
const GROK_VIDEO_SECONDS = Array.from({ length: 15 }, (_, index) => String(index + 1));
const GROK_VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"];
const GROK_VIDEO_RESOLUTIONS = ["480p", "720p"];
const CUSTOM_VIDEO_POLL_INTERVAL_MS = 5_000;
const CUSTOM_MJ_POLL_INTERVAL_MS = 5_000;

// This is a public service origin, not a credential. Deployments can override
// it with a Vite public variable while local builds keep the documented host.
const DOCUMENTED_KACHANG_API_BASE_URL = "https://newapi.prompt-hubs.com";
export const KACHANG_API_SITE_URL = DOCUMENTED_KACHANG_API_BASE_URL;
export const DEFAULT_CUSTOM_API_BASE_URL = import.meta.env.VITE_KACHANG_API_BASE_URL?.trim() || KACHANG_API_SITE_URL;
export const DEFAULT_CUSTOM_API_FORMAT: CustomApiFormat = "openai";
export const GEMINI_CUSTOM_API_BASE_URL = "https://generativelanguage.googleapis.com";

export function normalizeCustomApiFormat(value: unknown): CustomApiFormat {
  return customApiFormatSchema.safeParse(value).success && value === "gemini" ? "gemini" : DEFAULT_CUSTOM_API_FORMAT;
}

export type CustomApiConnection = {
  baseUrl: string;
  apiKey: string;
  /** The wire protocol for this connection. Legacy profiles default to OpenAI. */
  apiFormat?: CustomApiFormat;
};

export type CustomApiRouteParameter = {
  name: string;
  path: string;
  type: CustomApiCatalogParameterSource["type"];
  fixed?: unknown;
  default?: unknown;
  format?: string;
  itemsFormat?: string;
};

export type CustomApiRoute = {
  sourceModelId: string;
  modality: ModelModality;
  endpointPath: string;
  parameters: CustomApiRouteParameter[];
};

export type CustomApiCatalog = PublicModelCatalog & {
  apiFormat?: CustomApiFormat;
  routes: Record<string, CustomApiRoute>;
  availableModelIds: string[];
  capabilitySource: "rich" | "models-only";
  catalogWarning: string | null;
};

export type ParsedCustomModelKey = {
  profileId: string;
  modality: ModelModality;
  modelId: string;
};

export type CustomGenerationResult = {
  text?: string;
  media?: CanvasMedia[];
};

export class CustomApiError extends Error {
  constructor(message: string, readonly code = "CUSTOM_API_ERROR") {
    super(message);
    this.name = "CustomApiError";
  }
}

export function customModelKey(profileId: string, modality: ModelModality, modelId: string) {
  return `${CUSTOM_MODEL_KEY_PREFIX}${encodeURIComponent(profileId)}:${modality}:${encodeURIComponent(modelId)}`;
}

export function parseCustomModelKey(value: string): ParsedCustomModelKey | null {
  if (!value.startsWith(CUSTOM_MODEL_KEY_PREFIX)) return null;
  const remainder = value.slice(CUSTOM_MODEL_KEY_PREFIX.length);
  const firstSeparator = remainder.indexOf(":");
  const secondSeparator = firstSeparator < 0 ? -1 : remainder.indexOf(":", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) return null;
  const modalityValue = remainder.slice(firstSeparator + 1, secondSeparator);
  const modality = modelModalityFromValue(modalityValue);
  if (!modality) return null;
  try {
    const profileId = decodeURIComponent(remainder.slice(0, firstSeparator));
    const modelId = decodeURIComponent(remainder.slice(secondSeparator + 1));
    return profileId && modelId ? { profileId, modality, modelId } : null;
  } catch {
    return null;
  }
}

export function isCustomModelKey(value: string) {
  return parseCustomModelKey(value) !== null;
}

export function normalizeCustomApiBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CustomApiError("服务地址格式不正确", "INVALID_API_URL");
  }
  if (url.username || url.password || url.search || url.hash) throw new CustomApiError("服务地址不能包含账号、参数或片段", "INVALID_API_URL");
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new CustomApiError("服务地址需要使用 HTTPS", "INSECURE_API_URL");
  return url.origin;
}

export async function loadCustomApiCatalog(connection: CustomApiConnection): Promise<CustomApiCatalog> {
  const origin = normalizeCustomApiBaseUrl(connection.baseUrl);
  const apiFormat = normalizeCustomApiFormat(connection.apiFormat);
  if (apiFormat === "gemini") return loadGeminiCatalog(origin, connection.apiKey);
  let response: Response;
  try {
    response = await fetch(`${origin}/api/model-catalog`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CustomApiError("无法读取模型目录，请检查地址和跨域设置", "CATALOG_UNAVAILABLE");
  }
  if (!response.ok) throw new CustomApiError(`模型目录读取失败 (${response.status})`, "CATALOG_UNAVAILABLE");
  let source;
  try {
    source = customApiCatalogSchema.parse(await response.json());
  } catch {
    throw new CustomApiError("模型目录格式不兼容", "CATALOG_INVALID");
  }
  const routes: Record<string, CustomApiRoute> = {};
  const models: PublicModel[] = [];
  const usedIds = new Set<string>();
  for (const item of source.models) {
    const expectedEndpoint = EXPECTED_ENDPOINTS[item.modality];
    const endpointAllowed = item.modality === "image"
      ? IMAGE_ENDPOINTS.includes(item.endpoint.path as (typeof IMAGE_ENDPOINTS)[number])
      : item.endpoint.path === expectedEndpoint;
    if (item.selectable === false || !expectedEndpoint || !endpointAllowed || item.output.type !== item.modality) continue;
    const id = (item.public?.id ?? item.id).trim();
    if (!id || usedIds.has(id)) continue;
    try {
      const model = normalizeCustomModel(item, id);
      const route = normalizeCustomRoute(item);
      usedIds.add(id);
      models.push(model);
      routes[id] = route;
    } catch {
      // One malformed model must not hide the rest of a valid catalog.
    }
  }
  if (!models.length) throw new CustomApiError("模型目录中没有画布可用的模型", "CATALOG_EMPTY");
  models.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label, "zh-CN"));
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    version: source.version,
    capabilityVersion: source.capability_version,
    pricingVersion: source.pricing_version.trim() || source.version,
    fetchedAt: source.fetched_at,
    expiresAt,
    quoteAvailable: false,
    models,
    routes,
    availableModelIds: uniqueStrings(Object.values(routes).map((route) => route.sourceModelId)),
    apiFormat,
    capabilitySource: "rich",
    catalogWarning: null,
  };
}

export async function testCustomApiConnection(connection: CustomApiConnection): Promise<CustomApiCatalog> {
  const origin = normalizeCustomApiBaseUrl(connection.baseUrl);
  const apiFormat = normalizeCustomApiFormat(connection.apiFormat);
  const apiKey = connection.apiKey.trim();
  if (!apiKey) throw new CustomApiError("请输入 API Key", "API_KEY_REQUIRED");

  if (apiFormat === "gemini") {
    const availableModelIds = await fetchCustomApiModelIdsForFormat(origin, apiKey, apiFormat);
    return modelsOnlyCatalog(availableModelIds, null, apiFormat);
  }

  // Capability metadata and token-scoped availability are independent. Start
  // both reads together so one profile never pays a serial network waterfall.
  const catalogRequest = loadCustomApiCatalog({ baseUrl: origin, apiKey })
    .then((catalog) => ({ catalog, error: null as string | null }))
    .catch((cause) => ({ catalog: null, error: publicCustomApiError(cause) }));
  const [catalogResult, availableModelIds] = await Promise.all([
    catalogRequest,
    fetchCustomApiModelIdsForFormat(origin, apiKey, apiFormat),
  ]);
  if (!catalogResult.catalog) {
    return modelsOnlyCatalog(availableModelIds, catalogResult.error, apiFormat);
  }
  return retainAvailableRichModels(catalogResult.catalog, availableModelIds);
}

export async function fetchCustomApiModelIds(originValue: string, apiKeyValue: string) {
  return fetchCustomApiModelIdsForFormat(originValue, apiKeyValue, DEFAULT_CUSTOM_API_FORMAT);
}

export async function fetchCustomApiModelIdsForFormat(
  originValue: string,
  apiKeyValue: string,
  apiFormatValue: CustomApiFormat = DEFAULT_CUSTOM_API_FORMAT,
) {
  const origin = normalizeCustomApiBaseUrl(originValue);
  const apiFormat = normalizeCustomApiFormat(apiFormatValue);
  const apiKey = apiKeyValue.trim();
  if (!apiKey) throw new CustomApiError("请输入 API Key", "API_KEY_REQUIRED");
  let response: Response;
  try {
    response = await fetch(apiFormat === "gemini" ? `${origin}/v1beta/models` : `${origin}/v1/models`, {
      headers: apiFormat === "gemini"
        ? { Accept: "application/json", "x-goog-api-key": apiKey }
        : { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CONNECTION_CHECK_TIMEOUT_MS),
    });
  } catch {
    throw new CustomApiError("连接测试失败，请检查网络和跨域设置", "CONNECTION_FAILED");
  }
  if (response.status === 401 || response.status === 403) throw new CustomApiError("API Key 无效或没有读取模型权限", "API_KEY_REJECTED");
  if (!response.ok) throw new CustomApiError(`连接测试失败 (${response.status})`, "CONNECTION_FAILED");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CustomApiError("模型列表格式不兼容", "MODEL_LIST_INVALID");
  }
  if (apiFormat === "gemini") {
    if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models)) {
      throw new CustomApiError("Gemini 模型列表格式不兼容", "MODEL_LIST_INVALID");
    }
    return uniqueStrings((value as { models: unknown[] }).models.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const source = item as { name?: unknown; supportedGenerationMethods?: unknown };
      if (Array.isArray(source.supportedGenerationMethods)
        && !source.supportedGenerationMethods.includes("generateContent")) return [];
      return typeof source.name === "string" && source.name.trim()
        ? [source.name.trim().replace(/^models\//, "")]
        : [];
    })).sort((left, right) => left.localeCompare(right));
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
    throw new CustomApiError("模型列表格式不兼容", "MODEL_LIST_INVALID");
  }
  return uniqueStrings((value as { data: unknown[] }).data.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  })).sort((left, right) => left.localeCompare(right));
}

export function createSyntheticCustomModel(modelId: string, modality: ModelModality): PublicModel {
  const knownModel = createKnownCustomModel(modelId, modality);
  if (knownModel) return knownModel;
  const textParameter = modality === "text" ? {
    name: "messages",
    label: "消息",
    type: "array" as const,
    required: true,
    items: { type: "object" as const },
    mutuallyExclusiveWith: [],
  } : {
    name: "prompt",
    label: "提示词",
    type: "string" as const,
    required: true,
    mutuallyExclusiveWith: [],
  };
  return publicModelSchema.parse({
    id: modelId,
    label: modelId,
    description: modality === "audio"
      ? "已从 API 拉取；当前音频调用协议尚未配置"
      : "已从 API 拉取；使用当前模态的兼容调用协议",
    modality,
    operation: modality === "text" ? "chat" : "generate",
    order: 0,
    input: {
      textRequired: true,
      ...(modality === "image" ? { images: { min: 0, max: 16, multiple: true } } : {}),
    },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: [textParameter],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  });
}

export function createSyntheticCustomRoute(modelId: string, modality: ModelModality): CustomApiRoute | null {
  const knownRoute = createKnownCustomRoute(modelId, modality);
  if (knownRoute) return knownRoute;
  const endpointPath: string = modality === "image" ? "/v1/images/generations" : EXPECTED_ENDPOINTS[modality] as string;
  if (!endpointPath) return null;
  const inputName = modality === "text" ? "messages" : "prompt";
  return {
    sourceModelId: modelId,
    modality,
    endpointPath,
    parameters: [
      { name: "model", path: "model", type: "string", fixed: modelId },
      { name: inputName, path: inputName, type: modality === "text" ? "array" : "string" },
      ...(modality === "image" ? [{ name: "images", path: "images", type: "array" as const, itemsFormat: "uri-or-data-image" }] : []),
    ],
  };
}

function retainAvailableRichModels(catalog: CustomApiCatalog, availableModelIds: string[]): CustomApiCatalog {
  const available = new Set(availableModelIds);
  const models = catalog.models.filter((model) => {
    const route = catalog.routes[model.id];
    return Boolean(route && (available.has(route.sourceModelId) || available.has(model.id)));
  });
  const routes = Object.fromEntries(models.flatMap((model) => {
    const route = catalog.routes[model.id];
    return route ? [[model.id, route]] : [];
  }));
  return {
    ...catalog,
    models,
    routes,
    availableModelIds,
    capabilitySource: "rich",
    catalogWarning: null,
  };
}

async function loadGeminiCatalog(origin: string, apiKey: string): Promise<CustomApiCatalog> {
  const availableModelIds = await fetchCustomApiModelIdsForFormat(origin, apiKey, "gemini");
  return modelsOnlyCatalog(
    availableModelIds,
    "Gemini 原生接口没有 Canvas 专用能力目录，请在模型设置中确认每个模型的类型",
    "gemini",
  );
}

function modelsOnlyCatalog(
  availableModelIds: string[],
  warning: string | null,
  apiFormat: CustomApiFormat = DEFAULT_CUSTOM_API_FORMAT,
): CustomApiCatalog {
  const now = new Date();
  const models = availableModelIds.flatMap((modelId) => {
    const model = apiFormat === "gemini"
      ? createSyntheticCustomModel(modelId, "text")
      : createKnownCustomModel(modelId, "video");
    return model ? [model] : [];
  });
  const routes = Object.fromEntries(models.flatMap((model) => {
    const route = apiFormat === "gemini"
      ? createSyntheticCustomRoute(model.id, model.modality)
      : createKnownCustomRoute(model.id, model.modality);
    return route ? [[model.id, route]] : [];
  }));
  return {
    version: "models-only-v1",
    capabilityVersion: "models-only-v1",
    pricingVersion: "models-only-v1",
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    quoteAvailable: false,
    models,
    routes,
    availableModelIds,
    apiFormat,
    capabilitySource: "models-only",
    catalogWarning: warning ?? "API 未提供兼容的模型能力目录",
  };
}

function modelModalityFromValue(value: string): ModelModality | null {
  return value === "text" || value === "image" || value === "video" || value === "audio" ? value : null;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function publicCustomApiError(cause: unknown) {
  return cause instanceof Error ? cause.message : "模型能力目录暂时无法读取";
}

export async function executeCustomGeneration(input: {
  connection: CustomApiConnection;
  model: PublicModel;
  route: CustomApiRoute;
  parameters: Record<string, unknown>;
  inputs: GenerationJobInput;
  onProgress?: (progress: number) => void;
}): Promise<CustomGenerationResult> {
  const origin = normalizeCustomApiBaseUrl(input.connection.baseUrl);
  const apiKey = input.connection.apiKey.trim();
  if (!apiKey) throw new CustomApiError("请先配置 API Key", "API_KEY_REQUIRED");
  assertInputCounts(input.model, input.inputs);
  if (normalizeCustomApiFormat(input.connection.apiFormat) === "gemini") {
    return executeGeminiGeneration(input, origin, apiKey);
  }
  assertRoute(input.model, input.route);
  const isMidjourney = input.model.modality === "image"
    && input.route.endpointPath === "/v1/midjourney/generations";
  const payload = isMidjourney
    ? buildRequestPayload(input.route, input.parameters, input.inputs)
    : input.model.modality === "video"
    ? buildVideoRequestPayload(input.model.id, input.route, input.parameters, input.inputs)
    : input.model.modality === "image" && input.model.protocol?.version === "image.v1"
      ? buildImageRequestPayload(input.model.id, input.route, input.parameters, input.inputs)
      : buildRequestPayload(input.route, input.parameters, input.inputs);
  assertKnownModelConstraints(input.route, payload, input.inputs);
  input.onProgress?.(8);
  const response = await requestJson(origin, apiKey, input.route.endpointPath, "POST", payload, 10 * 60_000);

  if (input.model.modality === "text") {
    const parsed = customApiTextResponseSchema.safeParse(response);
    const text = parsed.success ? messageText(parsed.data.choices[0]!.message.content).trim() : "";
    if (!text) throw new CustomApiError("文本生成没有返回可用内容", "TEXT_RESULT_EMPTY");
    input.onProgress?.(100);
    return { text };
  }
  if (input.model.modality === "image") {
    if (input.route.endpointPath === "/v1/midjourney/generations") {
      return executeCustomMidjourneyGeneration(input, origin, apiKey, response);
    }
    const parsed = customApiImageResponseSchema.safeParse(response);
    if (!parsed.success) throw new CustomApiError("图片生成返回格式不兼容", "IMAGE_RESULT_INVALID");
    const items = "outputs" in parsed.data
      ? (parsed.data.outputs as Array<{ content_url: string }>).map((output) => ({ url: output.content_url }))
      : parsed.data.data;
    const media: CanvasMedia[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const blob = await imageResultBlob(item, origin, apiKey);
      media.push(await storeMedia(new File([blob], `generated-${Date.now()}-${index + 1}.${extensionFor(blob.type, "png")}`, { type: blob.type || "image/png" }), "image"));
      input.onProgress?.(Math.min(100, 70 + Math.round(((index + 1) / items.length) * 30)));
    }
    return { media };
  }
  if (input.model.modality === "video") {
    const completed = await waitForVideo(origin, apiKey, response, input.onProgress);
    const taskId = completed.id ?? completed.task_id;
    const url = videoResultUrl(completed) ?? (taskId ? videoContentUrl(origin, taskId) : null);
    if (!url) throw new CustomApiError("视频任务完成但没有返回可用文件", "VIDEO_RESULT_MISSING");
    const blob = await downloadResult(url, origin, apiKey, "video");
    const media = await storeMedia(new File([blob], `generated-${Date.now()}.${extensionFor(blob.type, "mp4")}`, { type: blob.type || "video/mp4" }), "video");
    input.onProgress?.(100);
    return { media: [media] };
  }
  throw new CustomApiError("当前模型类型暂不支持直接生成", "MODALITY_UNAVAILABLE");
}

type GeminiPart = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { fileUri?: string; mimeType?: string };
};

async function executeGeminiGeneration(
  input: {
    model: PublicModel;
    parameters: Record<string, unknown>;
    inputs: GenerationJobInput;
    onProgress?: (progress: number) => void;
  },
  origin: string,
  apiKey: string,
): Promise<CustomGenerationResult> {
  if (input.model.modality === "video") {
    throw new CustomApiError("Gemini 原生视频需要专用异步适配器，请使用 OpenAI 兼容渠道", "GEMINI_VIDEO_UNSUPPORTED");
  }
  if (input.model.modality === "audio") {
    throw new CustomApiError("Gemini 原生音频需要专用音频适配器，请使用 OpenAI 兼容渠道", "GEMINI_AUDIO_UNSUPPORTED");
  }
  const prompt = geminiPrompt(input.parameters);
  if (!prompt) throw new CustomApiError("Gemini 模型需要非空提示词", "PROMPT_REQUIRED");
  const parts: GeminiPart[] = [{ text: prompt }];
  if (input.model.modality === "image") {
    for (const value of input.inputs.images ?? []) parts.push(await geminiInlinePart(value, "image/png"));
  }
  input.onProgress?.(12);
  const response = await requestGeminiContent(origin, apiKey, input.model.id, {
    contents: [{ role: "user", parts }],
    ...(input.model.modality === "image" ? { generationConfig: geminiImageGenerationConfig(input.parameters) } : {}),
  });
  if (input.model.modality === "text") {
    const text = geminiResponseText(response).trim();
    if (!text) throw new CustomApiError("Gemini 文本生成没有返回可用内容", "TEXT_RESULT_EMPTY");
    input.onProgress?.(100);
    return { text };
  }
  const media: CanvasMedia[] = [];
  for (const [index, part] of geminiResponseParts(response).entries()) {
    const inlineData = part.inlineData ?? (part as GeminiPart & { inline_data?: { mime_type?: string; mimeType?: string; data?: string } }).inline_data;
    if (!inlineData?.data) continue;
    const mimeType = inlineData.mimeType || "image/png";
    const blob = base64Blob(inlineData.data, mimeType);
    media.push(await storeMedia(new File([blob], `generated-${Date.now()}-${index + 1}.${extensionFor(mimeType, "png")}`, { type: mimeType }), "image"));
  }
  if (!media.length) throw new CustomApiError("Gemini 接口没有返回图片", "IMAGE_RESULT_EMPTY");
  input.onProgress?.(100);
  return { media };
}

function geminiPrompt(parameters: Record<string, unknown>) {
  if (typeof parameters.prompt === "string") return parameters.prompt.trim();
  const messages = Array.isArray(parameters.messages) ? parameters.messages : [];
  return messages
    .flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      return content.flatMap((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? [(item as { text: string }).text]
        : []);
    })
    .join("\n")
    .trim();
}

function geminiImageGenerationConfig(parameters: Record<string, unknown>) {
  const aspectRatio = typeof parameters.aspect_ratio === "string"
    ? parameters.aspect_ratio
    : typeof parameters.ratio === "string" ? parameters.ratio : undefined;
  const imageSize = typeof parameters.resolution === "string" ? parameters.resolution : undefined;
  return {
    responseModalities: ["TEXT", "IMAGE"],
    ...(aspectRatio || imageSize ? {
      imageConfig: {
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(imageSize ? { imageSize } : {}),
      },
    } : {}),
  };
}

async function geminiInlinePart(value: string, fallbackMimeType: string): Promise<GeminiPart> {
  const dataMatch = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataMatch) return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
  if (!isHttpUrl(value)) throw new CustomApiError("Gemini 参考素材必须是 data URL 或 HTTPS 地址", "REFERENCE_FORMAT_INVALID");
  let response: Response;
  try {
    response = await fetch(value, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new CustomApiError("Gemini 参考素材读取失败", "REFERENCE_DOWNLOAD_FAILED");
  }
  if (!response.ok) throw new CustomApiError(`Gemini 参考素材读取失败 (${response.status})`, "REFERENCE_DOWNLOAD_FAILED");
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { inlineData: { mimeType: response.headers.get("content-type")?.split(";", 1)[0] || fallbackMimeType, data: bytesToBase64(bytes) } };
}

async function requestGeminiContent(origin: string, apiKey: string, modelId: string, body: Record<string, unknown>) {
  const url = new URL(`/v1beta/models/${encodeURIComponent(modelId.replace(/^models\//, ""))}:generateContent`, origin);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch {
    throw new CustomApiError("Gemini 请求连接中断，请检查任务记录后重试", "NETWORK_ERROR");
  }
  if (!response.ok) {
    let detail = "";
    try {
      const value = await response.json() as { error?: { message?: unknown } };
      detail = typeof value.error?.message === "string" ? value.error.message : "";
    } catch {
      // Keep a stable fallback for non-JSON provider errors.
    }
    throw new CustomApiError(detail || `Gemini 请求失败 (${response.status})`, `HTTP_${response.status}`);
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw new CustomApiError("Gemini 返回格式不兼容", "RESPONSE_INVALID");
  }
}

function geminiResponseParts(value: unknown): GeminiPart[] {
  if (!value || typeof value !== "object") return [];
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const content = (candidate as { content?: unknown }).content;
    if (!content || typeof content !== "object") return [];
    const parts = (content as { parts?: unknown }).parts;
    return Array.isArray(parts) ? parts.filter((part): part is GeminiPart => Boolean(part && typeof part === "object")) : [];
  });
}

function geminiResponseText(value: unknown) {
  return geminiResponseParts(value)
    .flatMap((part) => typeof part.text === "string" ? [part.text] : [])
    .join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function normalizeCustomModel(item: CustomApiCatalogModelSource, id: string): PublicModel {
  const outputCount = item.output.count;
  const fixedCount = outputCount?.fixed;
  const parameters = item.parameters
    .filter((parameter) => parameter.name !== "model" && !isMediaParameter(parameter))
    .map((parameter) => modelParameterSchema.parse({
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
    }));
  return publicModelSchema.parse({
    id,
    label: item.public?.label ?? item.label ?? item.id,
    description: item.public?.description ?? item.description ?? "",
    modality: item.modality,
    operation: item.operation,
    order: item.order ?? 0,
    ...(item.protocol ? {
      protocol: {
        version: item.protocol.version,
        endpoint: item.protocol.endpoint,
        mediaRoles: item.protocol.media_roles,
      },
    } : {}),
    input: {
      textRequired: item.input?.text?.required === true,
      images: normalizeInputCount(item, "images"),
      videos: normalizeInputCount(item, "videos"),
      audios: normalizeInputCount(item, "audios"),
      referenceMedia: normalizeReferenceMedia(item),
    },
    output: {
      type: item.output.type,
      minCount: fixedCount ?? outputCount?.min ?? 1,
      maxCount: fixedCount ?? outputCount?.max ?? 1,
    },
    parameters,
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  });
}

function normalizeCustomRoute(item: CustomApiCatalogModelSource): CustomApiRoute {
  const modelParameter = item.parameters.find((parameter) => parameter.name === "model");
  const sourceModelId = typeof modelParameter?.fixed === "string" ? modelParameter.fixed : item.id;
  return {
    sourceModelId,
    modality: item.modality,
    endpointPath: item.endpoint.path,
    parameters: item.parameters.map((parameter) => normalizeRouteParameter(parameter)),
  };
}

function normalizeRouteParameter(parameter: CustomApiCatalogParameterSource): CustomApiRouteParameter {
  return {
    name: parameter.name,
    path: safeParameterPath(parameter.path ?? parameter.name),
      type: parameter.type,
      ...(parameter.fixed !== undefined ? { fixed: parameter.fixed } : {}),
      ...(parameter.default !== undefined ? { default: parameter.default } : {}),
      ...(parameter.format ? { format: parameter.format } : {}),
    ...(parameter.items?.format ? { itemsFormat: parameter.items.format } : {}),
  };
}

function normalizeInputCount(item: CustomApiCatalogModelSource, kind: "images" | "videos" | "audios"): ModelInputCount | undefined {
  const source = item.input?.[kind];
  const mediaKind = kind.slice(0, -1) as MediaReferenceKind;
  const mediaParameters = item.parameters.filter((parameter) => {
    const binding = mediaParameterBindingFor(parameter);
    return binding?.kind === mediaKind && binding.position !== "style" && binding.position !== "element";
  });
  const arrayParameter = mediaParameters.find((parameter) => parameter.type === "array");
  const singleParameters = mediaParameters.filter((parameter) => parameter.type !== "array");
  if (!source && !mediaParameters.length) return undefined;
  const positionedCount = singleParameters.filter((parameter) => mediaParameterBindingFor(parameter)?.position !== "reference").length;
  const inferredMax = arrayParameter ? undefined : positionedCount || (singleParameters.length ? 1 : undefined);
  const max = source?.max ?? arrayParameter?.max_items ?? inferredMax;
  const minimum = item.modality === "image" && kind === "images"
    ? imageInputMinimum(source?.min, arrayParameter)
    : source?.min ?? arrayParameter?.min_items ?? 0;
  return {
    min: minimum,
    ...(max !== undefined ? { max } : {}),
    multiple: source?.multiple ?? Boolean(arrayParameter || positionedCount > 1),
  };
}

// Image-generation models normally accept a plain image as an optional input
// for text-to-image flows, so a relay-marked generic image parameter never
// forces a reference. Only an explicitly declared capability minimum or a
// parameter with explicit reference_image/reference_images semantics keeps its
// declared required minimum.
function imageInputMinimum(
  declaredCapabilityMin: number | undefined,
  arrayParameter: CustomApiCatalogParameterSource | undefined,
): number {
  if ((declaredCapabilityMin ?? 0) > 0) return declaredCapabilityMin ?? 0;
  if (arrayParameter
    && (arrayParameter.min_items ?? 0) > 0
    && (isExplicitReferenceParameterName(arrayParameter.name) || isExplicitReferenceParameterName(arrayParameter.path?.split(".").at(-1)))) {
    return arrayParameter.min_items ?? 0;
  }
  return 0;
}

type MediaPosition = "reference" | "first" | "last" | "style" | "element";
type MediaBinding = { kind: MediaReferenceKind; position: MediaPosition };
type ReferenceCountSource = { min?: number; max?: number; multiple?: boolean; role?: string };
type BindableMediaParameter = {
  parameter: CustomApiCatalogParameterSource;
  path: string;
  binding: MediaBinding;
};

function normalizeReferenceMedia(item: CustomApiCatalogModelSource): ModelReferenceMedia | undefined {
  const mediaParameters = bindableMediaParameters(item);
  if (!mediaParameters.length) return undefined;

  const source = item.input?.reference_media;
  const images = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "image" && ["reference", "first", "last"].includes(binding.position)),
    source?.images,
    "image",
    imageReferenceMinimumOverride(item, mediaParameters, source?.images),
  );
  const styleImages = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "image" && binding.position === "style"),
    source?.style_images,
  );
  const elementImages = normalizeReferenceInputCount(
    mediaParameters.filter(({ binding }) => binding.kind === "image" && binding.position === "element"),
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
  const maxTotalItems = minimumDefined(aggregateReferenceLimit(mediaParameters), source?.max_total_items);

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
  if (!parameters.length) return undefined;

  const uniqueParameters = [...new Map(parameters.map((item) => [`${item.path}:${item.parameter.type}`, item])).values()];
  const positioned = uniqueParameters.filter(({ binding }) => binding.position === "first" || binding.position === "last");
  const arrayParameter = uniqueParameters.find(({ parameter }) => parameter.type === "array")?.parameter;
  const singleParameters = uniqueParameters.filter(({ parameter }) => parameter.type === "string");
  const usesFrames = kind === "image" && positioned.length > 0;
  const inferredMin = usesFrames
    ? positioned.filter(({ parameter }) => parameter.required === true).length
    : arrayParameter
      ? Math.max(arrayParameter.min_items ?? 0, arrayParameter.required === true ? 1 : 0)
      : singleParameters.some(({ parameter }) => parameter.required === true) ? 1 : 0;
  const inferredMax = usesFrames
    ? positioned.length
    : arrayParameter
      ? arrayParameter.max_items
      : 1;
  const max = minimumDefined(inferredMax, source?.max);
  const multiple = Boolean(
    (usesFrames ? positioned.length > 1 : arrayParameter && (inferredMax === undefined || inferredMax > 1))
    && source?.multiple !== false
    && (max === undefined || max > 1),
  );
  const role = usesFrames ? "frame" : kind === "image" ? source?.role : undefined;

  return {
    min: max === 0 ? 0 : minimumOverride ?? Math.max(inferredMin, source?.min ?? 0),
    ...(max !== undefined ? { max } : {}),
    multiple,
    ...(role ? { role } : {}),
  };
}

// A reference/first/last image slot on an image-generation model stays optional
// only when it is a generic image input with no explicit reference semantics.
// An explicit reference_image/reference_images parameter or an explicitly
// required capability (input.images or reference_media.images) keeps its min.
function imageReferenceMinimumOverride(
  item: CustomApiCatalogModelSource,
  parameters: BindableMediaParameter[],
  source: ReferenceCountSource | undefined,
): number | undefined {
  if (item.modality !== "image") return undefined;
  const referenceParameters = parameters.filter(
    ({ binding }) => binding.kind === "image" && ["reference", "first", "last"].includes(binding.position),
  );
  const explicitlyRequiredCapability = (source?.min ?? 0) > 0 || (item.input?.images?.min ?? 0) > 0;
  const hasExplicitReferenceName = referenceParameters.some(({ parameter }) =>
    isExplicitReferenceParameterName(parameter.name) || isExplicitReferenceParameterName(parameter.path?.split(".").at(-1)),
  );
  return explicitlyRequiredCapability || hasExplicitReferenceName ? undefined : 0;
}

function isExplicitReferenceParameterName(value: string | undefined) {
  return typeof value === "string"
    && value.length > 0
    && MEDIA_REFERENCE_PARAMETER_NAME.test(value.replaceAll("_", "").toLowerCase());
}

function bindableMediaParameters(item: CustomApiCatalogModelSource): BindableMediaParameter[] {
  return item.parameters.flatMap((parameter) => {
    if ((parameter.type !== "string" && parameter.type !== "array") || parameter.fixed !== undefined) return [];
    const binding = mediaParameterBindingFor(parameter);
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
        ? { fields: parameter.aggregate_constraint.fields, max: parameter.aggregate_constraint.max_total_items }
        : undefined,
      parameter.aggregateConstraint
        ? { fields: parameter.aggregateConstraint.fields, max: parameter.aggregateConstraint.maxTotalItems }
        : undefined,
    ];
    for (const constraint of constraints) {
      if (!constraint) continue;
      const fields = new Set(constraint.fields.map((field) => field.trim()));
      if ([...declaredPaths].every((path) => fields.has(path) || fields.has(path.split(".").at(-1)!))) {
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

function assertRoute(model: PublicModel, route: CustomApiRoute) {
  const expected = EXPECTED_ENDPOINTS[model.modality];
  const endpointAllowed = model.modality === "image"
    ? IMAGE_ENDPOINTS.includes(route.endpointPath as (typeof IMAGE_ENDPOINTS)[number])
    : route.endpointPath === expected;
  if (!expected || route.modality !== model.modality || !endpointAllowed) {
    throw new CustomApiError("当前模型调用路径不兼容", "ROUTE_INVALID");
  }
}

function buildRequestPayload(route: CustomApiRoute, parameters: Record<string, unknown>, inputs: GenerationJobInput) {
  const payload: Record<string, unknown> = {};
  for (const parameter of route.parameters) {
    if (parameter.fixed !== undefined) setPath(payload, parameter.path, parameter.fixed);
    else if (!isMediaParameter(parameter) && parameters[parameter.name] !== undefined) setPath(payload, parameter.path, parameters[parameter.name]);
  }
  if (payload.model === undefined) payload.model = route.sourceModelId;
  bindImages(payload, route, inputs.images ?? []);
  bindMedia(payload, route, inputs.styleImages ?? [], "image", "style");
  bindMedia(payload, route, inputs.elementImages ?? [], "image", "element");
  bindMedia(payload, route, inputs.videos ?? [], "video", "reference");
  bindMedia(payload, route, inputs.audios ?? [], "audio", "reference");
  return payload;
}

export function buildImageRequestPayload(
  publicModelId: string,
  route: CustomApiRoute,
  parameters: Record<string, unknown>,
  inputs: GenerationJobInput,
) {
  const mediaInputs: ImageMediaInput[] = [];
  appendImageMedia(mediaInputs, route, inputs.images ?? [], "reference");
  appendImageMedia(mediaInputs, route, inputs.styleImages ?? [], "style_reference", "style");
  appendImageMedia(mediaInputs, route, inputs.elementImages ?? [], "element_reference", "element");

  const prompt = imageScalar(route, parameters, ["prompt"]);
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new CustomApiError("图片模型需要非空提示词", "PROMPT_REQUIRED");
  }
  const options: Record<string, unknown> = {};
  for (const parameter of route.parameters) {
    if (isImageCoreParameter(parameter) || isMediaParameter(parameter)) continue;
    const value = parameter.fixed ?? parameters[parameter.name] ?? parameter.default;
    if (value !== undefined) options[parameter.name] = value;
  }
  const protocol = buildImageProtocolRequest({
    model: publicModelId,
    prompt,
    ...optionalString("resolution", imageScalar(route, parameters, ["resolution"])),
    ...optionalString("aspectRatio", imageScalar(route, parameters, ["aspect_ratio", "aspectRatio", "ratio", "size"])),
    ...optionalString("quality", imageScalar(route, parameters, ["quality"])),
    ...optionalNumber("count", imageScalar(route, parameters, ["count", "n"])),
    mediaInputs,
    options,
  });
  const projectedParameters: Record<string, unknown> = { ...protocol.options, prompt: protocol.prompt };
  assignImageScalar(projectedParameters, route, ["resolution"], protocol.resolution);
  assignImageScalar(projectedParameters, route, ["aspect_ratio", "aspectRatio", "ratio", "size"], protocol.aspect_ratio);
  assignImageScalar(projectedParameters, route, ["quality"], protocol.quality);
  assignImageScalar(projectedParameters, route, ["count", "n"], protocol.count);
  const projectedInputs: GenerationJobInput = {
    images: protocol.media_inputs?.filter((item) => item.role === "reference").map((item) => item.url) ?? [],
    styleImages: protocol.media_inputs?.filter((item) => item.role === "style_reference").map((item) => item.url) ?? [],
    elementImages: protocol.media_inputs?.filter((item) => item.role === "element_reference").map((item) => item.url) ?? [],
    videos: [],
    audios: [],
  };
  const payload = buildRequestPayload(route, projectedParameters, projectedInputs);
  const mask = protocol.media_inputs?.find((item) => item.role === "mask");
  if (mask) {
    const maskParameter = route.parameters.find((parameter) => /mask|inpaint/i.test(`${parameter.name} ${parameter.path}`));
    if (!maskParameter) throw new CustomApiError("当前模型不支持编辑遮罩", "MASK_UNAVAILABLE");
    setPath(payload, maskParameter.path, requireCompatibleReference(mask.url, maskParameter));
  }
  return payload;
}

function assignImageScalar(target: Record<string, unknown>, route: CustomApiRoute, aliases: string[], value: unknown) {
  if (value === undefined) return;
  const parameter = route.parameters.find((candidate) => aliases.includes(candidate.name) || aliases.includes(candidate.path.split(".").at(-1) ?? ""));
  if (parameter && parameter.fixed === undefined) target[parameter.name] = value;
}

function appendImageMedia(
  target: ImageMediaInput[],
  route: CustomApiRoute,
  values: string[],
  role: ImageMediaInput["role"],
  position?: "style" | "element",
) {
  if (!values.length) return;
  const candidates = route.parameters.filter((parameter) => {
    const binding = mediaParameterBindingFor(parameter);
    return binding?.kind === "image" && (position ? binding.position === position : ["reference", "first", "last"].includes(binding.position));
  });
  const arrayParameter = candidates.find((parameter) => parameter.type === "array");
  const singleParameter = candidates.find((parameter) => parameter.type !== "array");
  const selected = values.length === 1 ? singleParameter ?? arrayParameter : arrayParameter;
  if (!selected) throw new CustomApiError("当前模型不支持这么多参考图", "TOO_MANY_REFERENCES");
  for (const value of values) {
    target.push({ kind: "image", role, url: requireCompatibleReference(value, selected, selected.type === "array") });
  }
}

function imageScalar(route: CustomApiRoute, values: Record<string, unknown>, aliases: string[]) {
  for (const alias of aliases) {
    const parameter = route.parameters.find((candidate) => candidate.name === alias || candidate.path.split(".").at(-1) === alias);
    if (!parameter) continue;
    if (parameter.fixed !== undefined) return parameter.fixed;
    if (values[parameter.name] !== undefined) return values[parameter.name];
    for (const valueAlias of aliases) {
      if (values[valueAlias] !== undefined) return values[valueAlias];
    }
    if (parameter.default !== undefined) return parameter.default;
  }
  return undefined;
}

function isImageCoreParameter(parameter: CustomApiRouteParameter) {
  return new Set(["version", "operation", "model", "prompt", "resolution", "size", "aspect_ratio", "aspectRatio", "ratio", "quality", "count", "n", "media_inputs", "options"]).has(parameter.name)
    || new Set(["version", "operation", "model", "prompt", "resolution", "size", "aspect_ratio", "aspectRatio", "ratio", "quality", "count", "n", "media_inputs", "options"]).has(parameter.path.split(".").at(-1) ?? "");
}

function optionalString(key: "resolution" | "aspectRatio" | "quality", value: unknown) {
  return typeof value === "string" && value.trim() ? { [key]: value } : {};
}

function optionalNumber(key: "count", value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? { [key]: number } : {};
}

const VIDEO_CORE_PARAMETER_NAMES = new Set([
  "version", "operation", "model", "prompt", "duration_seconds", "duration", "seconds", "resolution", "size",
  "aspect_ratio", "ratio", "media_inputs", "options", "async", "n",
]);

function buildVideoRequestPayload(
  publicModelId: string,
  route: CustomApiRoute,
  parameters: Record<string, unknown>,
  inputs: GenerationJobInput,
) {
  const mediaInputs: VideoMediaInput[] = [];
  appendVideoImages(mediaInputs, route, inputs.images ?? []);
  appendVideoMedia(mediaInputs, route, inputs.styleImages ?? [], "image", "style", "style_reference");
  appendVideoMedia(mediaInputs, route, inputs.elementImages ?? [], "image", "element", "element_reference");
  appendVideoMedia(mediaInputs, route, inputs.videos ?? [], "video", "reference", "reference");
  appendVideoMedia(mediaInputs, route, inputs.audios ?? [], "audio", "reference", "audio_reference");

  const prompt = videoScalar(route, parameters, ["prompt"]);
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new CustomApiError("视频模型需要非空提示词", "PROMPT_REQUIRED");
  }
  const duration = videoScalar(route, parameters, ["duration_seconds", "seconds", "duration"]);
  const resolution = videoScalar(route, parameters, ["resolution", "size"]);
  const aspectRatio = videoScalar(route, parameters, ["aspect_ratio", "ratio"]);
  const options: Record<string, unknown> = {};
  for (const parameter of route.parameters) {
    if (isVideoCoreParameter(parameter) || isMediaParameter(parameter)) continue;
    const value = parameter.fixed ?? parameters[parameter.name] ?? parameter.default;
    if (value !== undefined) options[parameter.name] = value;
  }
  return buildVideoProtocolRequest({
    model: publicModelId,
    prompt,
    ...(duration !== undefined ? { durationSeconds: Number(duration) } : {}),
    ...(resolution !== undefined ? { resolution: String(resolution) } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio: String(aspectRatio) } : {}),
    mediaInputs,
    options,
  });
}

function videoScalar(route: CustomApiRoute, values: Record<string, unknown>, aliases: string[]) {
  for (const alias of aliases) {
    const parameter = route.parameters.find((candidate) =>
      candidate.name === alias || candidate.path.split(".").at(-1) === alias,
    );
    if (!parameter) continue;
    if (parameter.fixed !== undefined) return parameter.fixed;
    if (values[parameter.name] !== undefined) return values[parameter.name];
    if (parameter.default !== undefined) return parameter.default;
  }
  return undefined;
}

function isVideoCoreParameter(parameter: CustomApiRouteParameter) {
  return VIDEO_CORE_PARAMETER_NAMES.has(parameter.name)
    || VIDEO_CORE_PARAMETER_NAMES.has(parameter.path.split(".").at(-1) ?? "");
}

function appendVideoImages(target: VideoMediaInput[], route: CustomApiRoute, values: string[]) {
  if (!values.length) return;
  const first = route.parameters.find((parameter) => mediaParameterBindingFor(parameter)?.position === "first");
  const last = route.parameters.find((parameter) => mediaParameterBindingFor(parameter)?.position === "last");
  if (!first && !last) {
    appendVideoMedia(target, route, values, "image", "reference", "reference");
    return;
  }
  const availableSlots = Number(Boolean(first)) + Number(Boolean(last));
  if (values.length > availableSlots) throw new CustomApiError("当前模型最多接收首尾两张参考图", "TOO_MANY_REFERENCES");
  if (first) target.push({ kind: "image", role: "first_frame", url: requireVideoReference(values[0]!, first, "image") });
  if (last && values[1]) target.push({ kind: "image", role: "last_frame", url: requireVideoReference(values.at(-1)!, last, "image") });
}

function appendVideoMedia(
  target: VideoMediaInput[],
  route: CustomApiRoute,
  values: string[],
  kind: MediaReferenceKind,
  position: "reference" | "style" | "element",
  role: VideoMediaInput["role"],
) {
  if (!values.length) return;
  const candidates = route.parameters.filter((parameter) => {
    const binding = mediaParameterBindingFor(parameter);
    return binding?.kind === kind && binding.position === position;
  });
  const arrayParameter = candidates.find((parameter) => parameter.type === "array");
  const singleParameter = candidates.find((parameter) => parameter.type !== "array");
  const selected = values.length === 1 ? singleParameter ?? arrayParameter : arrayParameter;
  if (!selected) throw new CustomApiError("当前模型不支持这么多参考素材", "TOO_MANY_REFERENCES");
  const semanticRole = kind === "video" && isSourceVideoParameter(selected) ? "source_video" : role;
  for (const value of values) {
    target.push({ kind, role: semanticRole, url: requireVideoReference(value, selected, kind, selected.type === "array") });
  }
}

function isSourceVideoParameter(parameter: CustomApiRouteParameter) {
  const names = [parameter.name, parameter.path.split(".").at(-1) ?? ""]
    .map((value) => value.replaceAll("_", "").toLowerCase());
  return names.some((value) => value === "inputvideo" || value === "sourcevideo");
}

function requireVideoReference(
  value: string,
  parameter: CustomApiRouteParameter,
  kind: MediaReferenceKind,
  arrayItem = false,
) {
  const reference = requireCompatibleReference(value, parameter, arrayItem);
  const format = arrayItem ? parameter.itemsFormat ?? parameter.format : parameter.format;
  if (format?.startsWith("public-http-url")) {
    if (!isHttpUrl(reference)) throw new CustomApiError("当前模型要求公网参考素材", "REFERENCE_NOT_PUBLIC");
    return reference;
  }
  if (format?.startsWith("uri-or-data-")) {
    if (!isHttpUrl(reference) && !reference.startsWith(`data:${kind}/`)) {
      throw new CustomApiError("参考素材格式不正确", "REFERENCE_FORMAT_INVALID");
    }
  }
  return reference;
}

function bindImages(payload: Record<string, unknown>, route: CustomApiRoute, values: string[]) {
  if (!values.length) return;
  const first = route.parameters.find((parameter) => mediaParameterBindingFor(parameter)?.position === "first");
  const last = route.parameters.find((parameter) => mediaParameterBindingFor(parameter)?.position === "last");
  if (first || last) {
    if (values.length > 2) throw new CustomApiError("当前模型最多接收首尾两张参考图", "TOO_MANY_REFERENCES");
    if (first) setPath(payload, first.path, requireCompatibleReference(values[0]!, first));
    if (last && values[1]) setPath(payload, last.path, requireCompatibleReference(values.at(-1)!, last));
    return;
  }
  bindMedia(payload, route, values, "image", "reference");
}

function bindMedia(
  payload: Record<string, unknown>,
  route: CustomApiRoute,
  values: string[],
  kind: MediaReferenceKind,
  position: "reference" | "style" | "element",
) {
  if (!values.length) return;
  const parameters = route.parameters.filter((parameter) => {
    const binding = mediaParameterBindingFor(parameter);
    return binding?.kind === kind && binding.position === position;
  });
  const arrayParameter = parameters.find((parameter) => parameter.type === "array");
  const singleParameter = parameters.find((parameter) => parameter.type !== "array");
  if (values.length === 1 && singleParameter) {
    setPath(payload, singleParameter.path, requireCompatibleReference(values[0]!, singleParameter));
    return;
  }
  if (!arrayParameter) throw new CustomApiError("当前模型不支持这么多参考素材", "TOO_MANY_REFERENCES");
  setPath(payload, arrayParameter.path, values.map((value) => {
    const reference = requireCompatibleReference(value, arrayParameter, true);
    return arrayParameter.itemsFormat === "public-http-url-object" ? { url: reference } : reference;
  }));
}

function requireCompatibleReference(value: string, parameter: CustomApiRouteParameter, arrayItem = false) {
  const format = arrayItem ? parameter.itemsFormat ?? parameter.format : parameter.format;
  if (format?.startsWith("public-http-url") && value.startsWith("data:")) {
    throw new CustomApiError("当前模型要求公网参考素材，本地文件暂不能直接提交", "REFERENCE_NOT_PUBLIC");
  }
  return value;
}

async function requestJson(
  origin: string,
  apiKey: string,
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  timeoutMs = 30_000,
) {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new CustomApiError("模型调用路径无效", "ROUTE_INVALID");
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new CustomApiError(method === "POST" ? "生成请求连接中断，请先检查任务记录再重试" : "暂时无法获取生成进度", "NETWORK_ERROR");
  }
  if (!response.ok) throw await customApiResponseError(response);
  try {
    return await response.json() as unknown;
  } catch {
    throw new CustomApiError("API 返回格式不兼容", "RESPONSE_INVALID");
  }
}

async function customApiResponseError(response: Response) {
  let detail = "";
  try {
    const value = await response.json() as { error?: { message?: unknown } | string; message?: unknown };
    detail = typeof value.error === "string"
      ? value.error
      : typeof value.error?.message === "string"
        ? value.error.message
        : typeof value.message === "string" ? value.message : "";
  } catch {
    // Keep a stable public fallback for non-JSON errors.
  }
  const message = response.status === 401 || response.status === 403
    ? "API Key 无效或没有调用权限"
    : response.status === 429
      ? "请求过于频繁，请稍后重试"
      : detail.trim().slice(0, 240) || `生成请求失败 (${response.status})`;
  return new CustomApiError(message, `HTTP_${response.status}`);
}

async function imageResultBlob(item: { url?: string; b64_json?: string }, origin: string, apiKey: string) {
  if (item.b64_json) return base64Blob(item.b64_json, "image/png");
  if (item.url?.startsWith("data:image/")) return dataUrlBlob(item.url);
  if (item.url && isHttpUrl(item.url)) return downloadResult(item.url, origin, apiKey, "image");
  throw new CustomApiError("图片生成没有返回可用文件", "IMAGE_RESULT_INVALID");
}

async function executeCustomMidjourneyGeneration(
  input: {
    model: PublicModel;
    onProgress?: (progress: number) => void;
  },
  origin: string,
  apiKey: string,
  initial: unknown,
): Promise<{ media: CanvasMedia[] }> {
  const completed = await waitForCustomMidjourney(origin, apiKey, initial, input.onProgress);
  if (!completed.length) {
    throw new CustomApiError("图片生成完成但没有返回可用文件", "IMAGE_RESULT_MISSING");
  }
  const media: CanvasMedia[] = [];
  for (let index = 0; index < completed.length; index += 1) {
    const item = completed[index]!;
    const blob = await imageResultBlob(item, origin, apiKey);
    media.push(await storeMedia(new File([blob], `generated-${Date.now()}-${index + 1}.${extensionFor(blob.type, "png")}`, { type: blob.type || "image/png" }), "image"));
    input.onProgress?.(Math.min(100, 70 + Math.round(((index + 1) / completed.length) * 30)));
  }
  return { media };
}

async function waitForCustomMidjourney(
  origin: string,
  apiKey: string,
  initial: unknown,
  onProgress?: (progress: number) => void,
) {
  let current = initial;
  let taskId = customMidjourneyTaskId(current);
  let usedLegacyTaskPath = false;
  const immediate = customMidjourneyImageItems(current);
  if (!taskId && immediate.length) return immediate;
  if (!taskId) throw new CustomApiError("图片任务没有返回任务编号", "IMAGE_TASK_MISSING");
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const status = customMidjourneyStatus(current);
    if (status === "failed") {
      throw new CustomApiError(
        customMidjourneyError(current) ? `图片生成失败：${customMidjourneyError(current)}` : "图片生成失败",
        "IMAGE_GENERATION_FAILED",
      );
    }
    const images = customMidjourneyImageItems(current);
    if (status === "completed") return images;
    if (images.length && !taskId) return images;
    onProgress?.(customMidjourneyProgress(current, status === "running" ? 48 : 18));
    await sleep(CUSTOM_MJ_POLL_INTERVAL_MS);
    try {
      current = await requestJson(
        origin,
        apiKey,
        usedLegacyTaskPath ? `/v1/midjourney/${encodeURIComponent(taskId)}` : `/v1/tasks/${encodeURIComponent(taskId)}`,
        "GET",
      );
    } catch (error) {
      // Some older MJ relays expose task details at /v1/midjourney/:id.
      // Retry that compatibility path only for a definitive 404.
      if (!usedLegacyTaskPath && error instanceof CustomApiError && error.code === "HTTP_404") {
        usedLegacyTaskPath = true;
        current = await requestJson(origin, apiKey, `/v1/midjourney/${encodeURIComponent(taskId)}`, "GET");
      } else {
        throw error;
      }
    }
    taskId = customMidjourneyTaskId(current) ?? taskId;
  }
  throw new CustomApiError("图片生成等待超时，可稍后在任务记录中查看", "IMAGE_TIMEOUT");
}

function customMidjourneyTaskId(value: unknown): string | null {
  const record = customMidjourneyRecord(value);
  for (const key of ["task_id", "taskId", "job_id", "jobId", "id"]) {
    const candidate = record?.[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function customMidjourneyRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const data = root.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object" && !Array.isArray(data[0])) {
    return data[0] as Record<string, unknown>;
  }
  return root;
}

function customMidjourneyStatus(value: unknown): "completed" | "failed" | "running" | "pending" {
  const record = customMidjourneyRecord(value);
  const raw = typeof record?.status === "string" ? record.status.trim().toLowerCase().replace(/-/g, "_") : "";
  if (["completed", "complete", "success", "succeeded", "done"].includes(raw)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled", "timeout"].includes(raw)) return "failed";
  if (["running", "processing", "in_progress"].includes(raw)) return "running";
  return "pending";
}

function customMidjourneyProgress(value: unknown, fallback: number) {
  const record = customMidjourneyRecord(value);
  const progress = typeof record?.progress === "number" ? record.progress : Number(record?.progress);
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : fallback;
}

function customMidjourneyError(value: unknown) {
  const record = customMidjourneyRecord(value);
  const error = record?.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 240);
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return String((error as Record<string, unknown>).message).trim().slice(0, 240);
  }
  for (const key of ["message", "error_message", "fail_reason", "failure_reason"]) {
    if (typeof record?.[key] === "string" && String(record[key]).trim()) return String(record[key]).trim().slice(0, 240);
  }
  return "";
}

function customMidjourneyImageItems(value: unknown): Array<{ url?: string; b64_json?: string }> {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const preferred = findCustomMidjourneyArray(root, ["image_urls", "imageUrls"]);
  const outputs = preferred.length ? preferred : findCustomMidjourneyArray(root, ["outputs", "images"]);
  const items = outputs.length ? outputs : customMidjourneySingleItems(root);
  return items.flatMap((item) => {
    if (typeof item === "string") return isHttpUrl(item) || item.startsWith("data:image/") ? [{ url: item }] : [];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const url = [record.url, record.image_url, record.imageUrl, record.content_url, record.download_url]
      .find((candidate): candidate is string => typeof candidate === "string" && (isHttpUrl(candidate) || candidate.startsWith("data:image/")));
    const b64 = typeof record.b64_json === "string" ? record.b64_json : undefined;
    return url || b64 ? [{ ...(url ? { url } : {}), ...(b64 ? { b64_json: b64 } : {}) }] : [];
  }).slice(0, 8);
}

function findCustomMidjourneyArray(value: unknown, keys: readonly string[], depth = 0): unknown[] {
  if (depth > 5 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  for (const child of Object.values(record)) {
    const found = findCustomMidjourneyArray(child, keys, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function customMidjourneySingleItems(value: Record<string, unknown>) {
  const found: unknown[] = [];
  for (const key of ["grid_image_url", "gridImageUrl", "image_url", "imageUrl", "url", "content_url", "download_url"]) {
    if (value[key] !== undefined) found.push(value[key]);
  }
  return found;
}

async function waitForVideo(origin: string, apiKey: string, initial: unknown, onProgress?: (progress: number) => void) {
  let current = customApiVideoResponseSchema.parse(initial);
  const taskId = current.id ?? current.task_id;
  if (!taskId) throw new CustomApiError("视频任务没有返回任务编号", "VIDEO_TASK_MISSING");
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const status = normalizeVideoStatus(current.status);
    if (status === "failed") throw videoGenerationError(current.error);
    // Some OpenAI-compatible relays keep the completed response small and
    // expose the bytes only through /v1/videos/{task_id}/content.
    if (status === "completed") return current;
    onProgress?.(normalizedProgress(current.progress) ?? (status === "running" ? 48 : 18));
    await sleep(CUSTOM_VIDEO_POLL_INTERVAL_MS);
    current = customApiVideoResponseSchema.parse(await requestJson(origin, apiKey, `/v1/videos/${encodeURIComponent(taskId)}`, "GET"));
  }
  throw new CustomApiError("视频生成等待超时，可稍后在任务记录中查看", "VIDEO_TIMEOUT");
}

function videoGenerationError(value: unknown) {
  const detail = videoErrorDetail(value);
  const code = videoErrorCode(value);
  const normalized = `${code} ${detail}`;
  if (/job_minimum_pro_plan_required/i.test(normalized)) {
    return new CustomApiError(
      "当前 Higgsfield 账号需要 Pro 套餐（job_minimum_pro_plan_required）",
      "JOB_MINIMUM_PRO_PLAN_REQUIRED",
    );
  }
  if (/upstream_verification_required|cloudflare|just a moment|enable javascript and cookies/i.test(normalized)) {
    return new CustomApiError(
      "Higgsfield 请求被 Cloudflare 验证拦截，请先完成会话验证后重试",
      "UPSTREAM_VERIFICATION_REQUIRED",
    );
  }
  return new CustomApiError(detail ? `视频生成失败：${detail}` : "视频生成失败", "VIDEO_GENERATION_FAILED");
}

function videoErrorCode(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code.trim().slice(0, 120) : "";
}

function videoErrorDetail(value: unknown, depth = 0): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || /<\/?(?:html|body|script|style)\b/i.test(normalized)) return "";
    return normalized.slice(0, 240);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || depth >= 2) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "error", "code"] as const) {
    const detail = videoErrorDetail(record[key], depth + 1);
    if (detail) return detail;
  }
  return "";
}

async function downloadResult(value: string, origin: string, apiKey: string, kind: "image" | "video") {
  const url = new URL(value);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: url.origin === origin ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch {
    throw new CustomApiError(`${kind === "image" ? "图片" : "视频"}结果无法下载，请检查文件跨域设置`, "RESULT_DOWNLOAD_FAILED");
  }
  if (!response.ok) throw new CustomApiError(`${kind === "image" ? "图片" : "视频"}结果下载失败 (${response.status})`, "RESULT_DOWNLOAD_FAILED");
  try {
    return await response.blob();
  } catch {
    throw new CustomApiError(
      `${kind === "image" ? "图片" : "视频"}结果读取中断，请稍后从任务记录重试`,
      "RESULT_READ_INTERRUPTED",
    );
  }
}

function base64Blob(value: string, mimeType: string) {
  try {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  } catch {
    throw new CustomApiError("图片数据无法解码", "IMAGE_RESULT_INVALID");
  }
}

async function dataUrlBlob(value: string) {
  try {
    return await (await fetch(value)).blob();
  } catch {
    throw new CustomApiError("图片数据无法解码", "IMAGE_RESULT_INVALID");
  }
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
    ? (item as { text: string }).text
    : "").join("");
}

function videoResultUrl(value: unknown) {
  for (const path of ["outputs.0.content_url", "outputs.0.download_url", "outputs.0.url", "content_url", "video.url", "url", "video_url", "download_url", "output.url", "output.content_url", "result.url", "result.video_url", "result.content_url", "data.url", "data.video_url", "data.content_url", "data.video.url", "content.url", "content.video_url", "file.url"]) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate === "string" && candidate.length <= 4096 && isHttpUrl(candidate)) return candidate;
  }
  return null;
}

function videoContentUrl(origin: string, taskId: string) {
  return new URL(`/v1/videos/${encodeURIComponent(taskId)}/content`, origin).toString();
}

function valueAtPath(value: unknown, path: string) {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function normalizeVideoStatus(value: string | undefined) {
  const status = value?.trim().toLowerCase().replace(/-/g, "_");
  if (["completed", "succeeded", "success", "done"].includes(status ?? "")) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(status ?? "")) return "failed";
  if (["in_progress", "processing", "running"].includes(status ?? "")) return "running";
  return "queued";
}

function normalizedProgress(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.min(100, Math.round(value)));
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new CustomApiError("模型参数路径冲突", "ROUTE_INVALID");
    if (current === undefined) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
}

function safeParameterPath(value: string) {
  const segments = value.split(".");
  if (!segments.length || segments.length > 8 || segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || BLOCKED_PATH_SEGMENTS.has(segment))) {
    throw new CustomApiError("模型参数路径不安全", "ROUTE_INVALID");
  }
  return segments.join(".");
}

type MediaParameterDescriptor = {
  name: string;
  path?: string;
  format?: string;
  itemsFormat?: string;
};

function isMediaParameter(parameter: MediaParameterDescriptor) {
  return mediaParameterBindingFor(parameter) !== null;
}

function mediaParameterBindingFor(parameter: MediaParameterDescriptor) {
  return mediaParameterBinding(parameter.name, parameter.path, parameter.format ?? parameter.itemsFormat);
}

function mediaParameterBinding(name: string, path?: string, format?: string): MediaBinding | null {
  const pathBinding = mediaBindingFromName(path?.split(".").at(-1));
  if (pathBinding) return pathBinding;
  const nameBinding = mediaBindingFromName(name);
  if (nameBinding) return nameBinding;
  const formatKind = /uri/i.test(format ?? "") ? /(image|video|audio)/i.exec(format ?? "")?.[1]?.toLowerCase() : undefined;
  return formatKind ? { kind: formatKind as MediaReferenceKind, position: "reference" } : null;
}

function mediaBindingFromName(value: string | undefined): MediaBinding | null {
  if (!value) return null;
  const normalizedName = value.replaceAll("_", "").toLowerCase();
  const specialized = SPECIALIZED_IMAGE_PARAMETER_NAME.exec(normalizedName)?.[1] as "style" | "element" | undefined;
  if (specialized) return { kind: "image", position: specialized };
  const positioned = POSITIONED_IMAGE_PARAMETER_NAME.exec(normalizedName)?.[1];
  if (positioned) return { kind: "image", position: positioned === "first" || positioned === "start" ? "first" : "last" };
  const inputKind = INPUT_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1] as MediaReferenceKind | undefined;
  if (inputKind) return { kind: inputKind, position: "reference" };
  const bareKind = BARE_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1] as MediaReferenceKind | undefined;
  if (bareKind) return { kind: bareKind, position: "reference" };
  const referenceKind = MEDIA_REFERENCE_PARAMETER_NAME.exec(normalizedName)?.[1] as MediaReferenceKind | undefined;
  if (referenceKind) return { kind: referenceKind, position: "reference" };
  return null;
}

export function publicReferenceKinds(route: CustomApiRoute) {
  const kinds = new Set<MediaReferenceKind>();
  for (const parameter of route.parameters) {
    const binding = mediaParameterBindingFor(parameter);
    if (!binding) continue;
    if (parameter.format?.startsWith("public-http-url") || parameter.itemsFormat?.startsWith("public-http-url")) {
      kinds.add(binding.kind);
    }
  }
  return kinds;
}

function createKnownCustomModel(modelId: string, modality: ModelModality): PublicModel | null {
  if (modality !== "video" || !isKnownGrokVideoModel(modelId)) return null;
  const imageRequired = modelId === GROK_IMAGINE_VIDEO_15_MODEL_ID;
  const resolutions = imageRequired ? [...GROK_VIDEO_RESOLUTIONS, "1080p"] : GROK_VIDEO_RESOLUTIONS;
  return publicModelSchema.parse({
    id: modelId,
    label: imageRequired ? "Grok Imagine Video 1.5" : "Grok Imagine Video",
    description: imageRequired
      ? "Grok 1.5 首帧图生视频，必须且只能提供 1 张公网可访问的参考图。"
      : "Grok 视频生成，支持文生、单首帧和最多 7 张多图参考。",
    modality: "video",
    operation: "generate",
    order: 0,
    input: {
      textRequired: true,
      images: imageRequired
        ? { min: 1, max: 1, multiple: false }
        : { min: 0, max: 7, multiple: true },
    },
    output: { type: "video", minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        minLength: 1,
        mutuallyExclusiveWith: [],
      },
      {
        name: "seconds",
        label: "时长（秒）",
        type: "string",
        required: false,
        default: "6",
        options: GROK_VIDEO_SECONDS,
        mutuallyExclusiveWith: [],
      },
      {
        name: "aspect_ratio",
        label: "画面比例",
        type: "string",
        required: false,
        default: "16:9",
        options: GROK_VIDEO_ASPECT_RATIOS,
        mutuallyExclusiveWith: [],
      },
      {
        name: "resolution",
        label: "分辨率",
        type: "string",
        required: false,
        default: "720p",
        options: resolutions,
        mutuallyExclusiveWith: [],
      },
    ],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  });
}

function createKnownCustomRoute(modelId: string, modality: ModelModality): CustomApiRoute | null {
  if (modality !== "video" || !isKnownGrokVideoModel(modelId)) return null;
  const imageRequired = modelId === GROK_IMAGINE_VIDEO_15_MODEL_ID;
  return {
    sourceModelId: modelId,
    modality: "video",
    endpointPath: "/v1/videos",
    parameters: [
      { name: "model", path: "model", type: "string", fixed: modelId },
      { name: "prompt", path: "prompt", type: "string" },
      { name: "seconds", path: "seconds", type: "string" },
      { name: "aspect_ratio", path: "aspect_ratio", type: "string" },
      { name: "resolution", path: "resolution", type: "string" },
      { name: imageRequired ? "first_frame_image" : "image", path: imageRequired ? "first_frame_image" : "image", type: "string", format: "public-http-url" },
      ...(!imageRequired ? [{
        name: "reference_images",
        path: "reference_images",
        type: "array" as const,
        itemsFormat: "public-http-url-object",
      }] : []),
    ],
  };
}

function isKnownGrokVideoModel(modelId: string) {
  return modelId === GROK_IMAGINE_VIDEO_MODEL_ID || modelId === GROK_IMAGINE_VIDEO_15_MODEL_ID;
}

function assertInputCounts(model: PublicModel, inputs: GenerationJobInput) {
  const images = inputs.images ?? [];
  const styleImages = inputs.styleImages ?? [];
  const elementImages = inputs.elementImages ?? [];
  const videos = inputs.videos ?? [];
  const audios = inputs.audios ?? [];
  const referenceMedia = model.input.referenceMedia;
  const hasDeclaredImagePurpose = referenceMedia?.images !== undefined
    || referenceMedia?.styleImages !== undefined
    || referenceMedia?.elementImages !== undefined;
  const entries = [
    ["图片", images, referenceMedia?.images ?? (hasDeclaredImagePurpose ? undefined : model.input.images), 32],
    ["风格图", styleImages, referenceMedia?.styleImages, 32],
    ["元素图", elementImages, referenceMedia?.elementImages, 32],
    ["视频", videos, referenceMedia?.videos ?? model.input.videos, 10],
    ["音频", audios, referenceMedia?.audios ?? model.input.audios, 10],
  ] as const;
  for (const [label, values, capability, requestLimit] of entries) {
    const min = capability?.min ?? 0;
    const capabilityMax = !capability
      ? 0
      : capability.multiple
        ? capability.max ?? requestLimit
        : Math.min(1, capability.max ?? 1);
    const max = Math.min(capabilityMax, requestLimit);
    if (values.length < min) throw new CustomApiError(`当前模型至少需要 ${min} 个${label}参考`, "REFERENCE_REQUIRED");
    if (values.length > max) throw new CustomApiError(`当前模型最多支持 ${max} 个${label}参考`, "TOO_MANY_REFERENCES");
  }
  const total = images.length + styleImages.length + elementImages.length + videos.length + audios.length;
  if (referenceMedia?.maxTotalItems !== undefined && total > referenceMedia.maxTotalItems) {
    throw new CustomApiError(`当前模型合计最多支持 ${referenceMedia.maxTotalItems} 个参考素材`, "TOO_MANY_REFERENCES");
  }
}

function assertKnownModelConstraints(route: CustomApiRoute, payload: Record<string, unknown>, inputs: GenerationJobInput) {
  if (!isKnownGrokVideoModel(route.sourceModelId)) return;
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) throw new CustomApiError("Grok 视频模型需要非空提示词", "PROMPT_REQUIRED");
  if (route.sourceModelId !== GROK_IMAGINE_VIDEO_MODEL_ID || inputs.images.length < 2) return;
  const seconds = Number(payload.duration_seconds ?? 6);
  if (Number.isFinite(seconds) && seconds > 10) {
    throw new CustomApiError("Grok 多参考图模式最长支持 10 秒", "DURATION_OUT_OF_RANGE");
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function extensionFor(mimeType: string, fallback: string) {
  const known: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };
  return known[mimeType.toLowerCase()] ?? fallback;
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}
