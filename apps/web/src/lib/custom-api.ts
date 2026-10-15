import {
  customApiCatalogSchema,
  customApiFormatSchema,
  customApiImageResponseSchema,
  customApiTextResponseSchema,
  customApiVideoResponseSchema,
  buildImageProtocolRequest,
  buildVideoProtocolRequest,
  isAllowedAudioEndpoint,
  isGeminiNativeAudioPath,
  wrapPcmToWav,
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
} from "@weftcanvas/contracts";

import { storeMedia } from "./media-store";
import { inferKnowledgePlan, isGrokImagineVideoModel } from "./custom-model-knowledge";

type MediaReferenceKind = "image" | "video" | "audio";

const EXPECTED_ENDPOINTS: Partial<Record<ModelModality, string | readonly string[]>> = {
  text: "/v1/chat/completions",
  image: "/v1/images/generations",
  video: "/v1/videos",
  audio: "/v1/chat/completions",
};
const IMAGE_ENDPOINTS = ["/v1/images/generations", "/v1/midjourney/generations"] as const;
const MEDIA_REFERENCE_PARAMETER_NAME = /^(?:reference|ref)(image|video|audio)s?(?:url)?s?$/;
const BARE_MEDIA_PARAMETER_NAME = /^(image|video|audio)(?:s|urls?)?$/;
const POSITIONED_IMAGE_PARAMETER_NAME =
  /^(first|start|last|end)(?:(?:frame)(?:image)?|image)(?:url)?$/;
const SPECIALIZED_IMAGE_PARAMETER_NAME = /^(style|element)(?:references?|images?)(?:url)?s?$/;
const INPUT_MEDIA_PARAMETER_NAME = /^(?:input|source)(image|video|audio)(?:url)?s?$/;
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const CATALOG_REQUEST_TIMEOUT_MS = 12_000;
const CONNECTION_CHECK_TIMEOUT_MS = 12_000;
const CUSTOM_MODEL_KEY_PREFIX = "custom:";
// 官方模型 id / 参数形状的来源是 `custom-model-knowledge.ts`（BYOK 兼容档知识库）；
// 这里只保留约束校验要用的那一枚 id。
const GROK_IMAGINE_VIDEO_MODEL_ID = "grok-imagine-video";
const CUSTOM_VIDEO_POLL_INTERVAL_MS = 5_000;
const CUSTOM_MJ_POLL_INTERVAL_MS = 5_000;

// 服务站点 origin（非凭据）。托管部署用 VITE_WEFTCANVAS_API_BASE_URL 注入自己的
// 文档站点；公开/自托管构建没有默认站点——留空即"设置里自己填自己的网关"，
// 相应的站点链接在为空时不渲染。
const DOCUMENTED_WEFTCANVAS_API_BASE_URL =
  import.meta.env.VITE_WEFTCANVAS_API_BASE_URL?.trim() || "";
export const WEFTCANVAS_API_SITE_URL = DOCUMENTED_WEFTCANVAS_API_BASE_URL;
export const DEFAULT_CUSTOM_API_BASE_URL = DOCUMENTED_WEFTCANVAS_API_BASE_URL;
export const DEFAULT_CUSTOM_API_FORMAT: CustomApiFormat = "openai";
export const GEMINI_CUSTOM_API_BASE_URL = "https://generativelanguage.googleapis.com";

export function normalizeCustomApiFormat(value: unknown): CustomApiFormat {
  return customApiFormatSchema.safeParse(value).success && value === "gemini"
    ? "gemini"
    : DEFAULT_CUSTOM_API_FORMAT;
}

export type CustomApiConnection = {
  baseUrl: string;
  apiKey: string;
  /** The wire protocol for this connection. Legacy profiles default to OpenAI. */
  apiFormat?: CustomApiFormat;
  /**
   * 可选协议档案（P0）：只在用户显式填写时生效，用来接那些"OpenAI 兼容但字段名/
   * 端点/认证方式不同"的中转站。缺省完全走今天的默认路径，零迁移。
   */
  protocol?: CustomApiProtocolOverride;
};

export type CustomApiAuthStyle = "bearer" | "header" | "query";

export type CustomApiRequestContentType = "json" | "form" | "multipart";

/** 异步任务的轮询覆盖（P1）：任务号、状态、进度都可能在上游响应里换位置/换值。 */
export type CustomApiPollOverride = {
  /** 如 `/v1/tasks/{task_id}`；`{task_id}` 与 `{id}` 都支持。缺省 = `/v1/videos/{id}`。 */
  urlTemplate?: string;
  method?: "GET" | "POST";
  /** 取任务号的候选点路径，排在内置 `id` / `task_id` 之前。 */
  taskIdPaths?: string[];
  /** 取状态值的候选点路径，排在内置 `status` 之前。 */
  statusPaths?: string[];
  /** 命中即判定完成/失败的状态字面量（大小写不敏感）。 */
  successValues?: string[];
  failValues?: string[];
  /** 进度字段的点路径；缺省读顶层 `progress`。 */
  progressPath?: string;
};

/**
 * 协议档案：认证方式（P0）、按模态的提交端点（P0）、请求体编码（P2）、
 * 异步轮询（P1）、错误提取与结果 URL 候选点路径（P3）。全部声明式，不执行用户脚本。
 */
export type CustomApiProtocolOverride = {
  auth?: { style: CustomApiAuthStyle; name?: string };
  endpoints?: Partial<Record<ModelModality, string>>;
  request?: { contentType?: CustomApiRequestContentType };
  poll?: CustomApiPollOverride;
  /** 上游把失败原因放在哪：messagePaths 优先于内置候选，codePaths 同理。 */
  error?: { messagePaths?: string[]; codePaths?: string[] };
  resultUrlPaths?: string[];
};

const CUSTOM_API_AUTH_STYLES: readonly CustomApiAuthStyle[] = ["bearer", "header", "query"];
const CUSTOM_API_CONTENT_TYPES: readonly CustomApiRequestContentType[] = [
  "json",
  "form",
  "multipart",
];
const CUSTOM_API_RESULT_PATH_LIMIT = 20;
const CUSTOM_API_PATH_LIST_LIMIT = 12;
const CUSTOM_API_STATUS_VALUE_LIMIT = 12;
const CUSTOM_API_POLL_TEMPLATE_TOKENS = /\{(?:task_id|id)\}/g;

/**
 * 归一化用户填写的协议档案：空白、非法、危险项一律丢弃，宁可退回默认也不把坏值
 * 带进请求。永远只返回声明式数据（点路径/端点/认证样式），不接受脚本。
 */
export function normalizeProtocolOverride(value: unknown): CustomApiProtocolOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const protocol: CustomApiProtocolOverride = {};

  const auth = source.auth;
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const style = (auth as { style?: unknown }).style;
    const name = (auth as { name?: unknown }).name;
    if (typeof style === "string" && CUSTOM_API_AUTH_STYLES.includes(style as CustomApiAuthStyle)) {
      if (style === "bearer") protocol.auth = { style: "bearer" };
      else if (typeof name === "string" && isSafeAuthName(name))
        protocol.auth = { style: style as CustomApiAuthStyle, name: name.trim() };
    }
  }

  const endpoints = source.endpoints;
  if (endpoints && typeof endpoints === "object" && !Array.isArray(endpoints)) {
    const resolved: Partial<Record<ModelModality, string>> = {};
    for (const modality of ["text", "image", "video", "audio"] as const) {
      const path = (endpoints as Record<string, unknown>)[modality];
      if (typeof path === "string" && isSafeEndpointPath(path)) resolved[modality] = path.trim();
    }
    if (Object.keys(resolved).length) protocol.endpoints = resolved;
  }

  const request = source.request;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const contentType = (request as { contentType?: unknown }).contentType;
    if (
      typeof contentType === "string" &&
      CUSTOM_API_CONTENT_TYPES.includes(contentType as CustomApiRequestContentType) &&
      contentType !== "json"
    )
      protocol.request = { contentType: contentType as CustomApiRequestContentType };
  }

  const poll = normalizePollOverride(source.poll);
  if (poll) protocol.poll = poll;

  const error = normalizeErrorOverride(source.error);
  if (error) protocol.error = error;

  const paths = source.resultUrlPaths;
  if (Array.isArray(paths)) {
    const resolved = normalizePathList(paths, CUSTOM_API_RESULT_PATH_LIMIT);
    if (resolved.length) protocol.resultUrlPaths = resolved;
  }

  return Object.keys(protocol).length ? protocol : undefined;
}

function normalizeErrorOverride(value: unknown): CustomApiProtocolOverride["error"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const error: NonNullable<CustomApiProtocolOverride["error"]> = {};
  for (const key of ["messagePaths", "codePaths"] as const) {
    const raw = source[key];
    if (Array.isArray(raw) && raw.length) {
      const resolved = normalizePathList(raw, CUSTOM_API_PATH_LIST_LIMIT);
      if (resolved.length) error[key] = resolved;
    }
  }
  return Object.keys(error).length ? error : undefined;
}

function normalizePollOverride(value: unknown): CustomApiPollOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const poll: CustomApiPollOverride = {};
  if (typeof source.urlTemplate === "string" && isSafePollTemplate(source.urlTemplate))
    poll.urlTemplate = source.urlTemplate.trim();
  // GET 是内置默认：不写进档案，避免同一份配置产生不同的指纹。
  if (source.method === "POST") poll.method = "POST";
  for (const key of ["taskIdPaths", "statusPaths"] as const) {
    const raw = source[key];
    if (Array.isArray(raw) && raw.length) {
      const resolved = normalizePathList(raw, CUSTOM_API_PATH_LIST_LIMIT);
      if (resolved.length) poll[key] = resolved;
    }
  }
  for (const key of ["successValues", "failValues"] as const) {
    const raw = source[key];
    if (Array.isArray(raw) && raw.length) {
      const resolved = normalizeStatusValues(raw);
      if (resolved.length) poll[key] = resolved;
    }
  }
  if (typeof source.progressPath === "string" && isSafeResultPath(source.progressPath))
    poll.progressPath = source.progressPath.trim();
  return Object.keys(poll).length ? poll : undefined;
}

function normalizePathList(values: readonly unknown[], limit: number) {
  return uniqueStrings(
    values.filter((path): path is string => typeof path === "string").filter(isSafeResultPath),
  ).slice(0, limit);
}

function normalizeStatusValues(values: readonly unknown[]) {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= 40),
    ),
  ].slice(0, CUSTOM_API_STATUS_VALUE_LIMIT);
}

function isSafeAuthName(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && /^[A-Za-z0-9_-]+$/.test(trimmed);
}

/** 提交端点必须是站内绝对路径：不接受协议、主机、相对路径、查询串或穿越片段。 */
function isSafeEndpointPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  if (trimmed.length > 300 || /\s/.test(trimmed) || trimmed.includes("..")) return false;
  if (trimmed.includes("?") || trimmed.includes("#")) return false;
  return trimmed.split("/").every((segment) => !BLOCKED_PATH_SEGMENTS.has(segment));
}

/** 轮询模板：站内绝对路径 + 查询串，只允许 `{task_id}` / `{id}` 两个占位符。 */
function isSafePollTemplate(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  if (trimmed.length > 300 || /\s/.test(trimmed) || trimmed.includes("..")) return false;
  const withoutTokens = trimmed.replace(CUSTOM_API_POLL_TEMPLATE_TOKENS, "x");
  if (withoutTokens.includes("{") || withoutTokens.includes("}")) return false;
  const [pathname] = withoutTokens.split("?");
  return (pathname ?? "").split("/").every((segment) => !BLOCKED_PATH_SEGMENTS.has(segment));
}

function isSafeResultPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120 || /\s/.test(trimmed)) return false;
  return trimmed
    .split(".")
    .every((segment) => segment.length > 0 && !BLOCKED_PATH_SEGMENTS.has(segment));
}

/**
 * 认证请求初始化：bearer（默认）/ 自定义头 / 查询参数三种样式共用一处，保证目录
 * 拉取、模型列表与执行三处认证永远一致。
 */
export function customApiAuthInit(connection: CustomApiConnection, path: string) {
  const origin = normalizeCustomApiBaseUrl(connection.baseUrl);
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new CustomApiError("模型调用路径无效", "ROUTE_INVALID");
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = connection.apiKey.trim();
  const auth = normalizeProtocolOverride(connection.protocol)?.auth;
  if (!apiKey) return { url, headers };
  if (auth?.style === "query" && auth.name) url.searchParams.set(auth.name, apiKey);
  else if (auth?.style === "header" && auth.name) headers[auth.name] = apiKey;
  else headers.Authorization = `Bearer ${apiKey}`;
  return { url, headers };
}

/** 该模态实际使用的提交端点：协议档案优先，其次内置默认。 */
export function protocolEndpoint(
  connection: CustomApiConnection | undefined,
  modality: ModelModality,
  fallback: string | undefined,
) {
  const override = connection
    ? normalizeProtocolOverride(connection.protocol)?.endpoints?.[modality]
    : undefined;
  return override ?? fallback;
}

/** 把协议档案的端点覆盖应用到已解析出的路由上（选择器与执行共用同一份路由）。 */
export function applyProtocolOverride(
  route: CustomApiRoute,
  connection?: CustomApiConnection,
): CustomApiRoute {
  const override = connection
    ? normalizeProtocolOverride(connection.protocol)?.endpoints?.[route.modality]
    : undefined;
  if (!override || override === route.endpointPath) return route;
  return { ...route, endpointPath: override };
}

function protocolResultPaths(connection: CustomApiConnection | undefined) {
  return connection ? normalizeProtocolOverride(connection.protocol)?.resultUrlPaths : undefined;
}

function protocolContentType(connection: CustomApiConnection): CustomApiRequestContentType {
  return normalizeProtocolOverride(connection.protocol)?.request?.contentType ?? "json";
}

/**
 * 请求体编码（P2）：默认 JSON；`form` 走 URLSearchParams（数组重复同名键、对象 JSON
 * 字符串化）；`multipart` 走 FormData，data URL 会解成文件部件（浏览器自带 boundary）。
 * 规则保守且可预期，不做任何字段名猜测。
 */
export async function buildProtocolRequestBody(
  value: Record<string, unknown>,
  contentType: CustomApiRequestContentType,
): Promise<{ body: BodyInit; headers: Record<string, string> }> {
  if (contentType === "json")
    return { body: JSON.stringify(value), headers: { "Content-Type": "application/json" } };
  if (contentType === "form") {
    const params = new URLSearchParams();
    for (const [key, item] of Object.entries(value)) appendFormValue(params, key, item);
    return {
      body: params,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    };
  }
  const form = new FormData();
  for (const [key, item] of Object.entries(value)) await appendFormDataValue(form, key, item);
  return { body: form, headers: {} };
}

function appendFormValue(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(params, key, item);
    return;
  }
  if (typeof value === "object") {
    params.append(key, JSON.stringify(value));
    return;
  }
  params.append(key, String(value));
}

async function appendFormDataValue(form: FormData, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) await appendFormDataValue(form, key, item);
    return;
  }
  if (typeof value === "string" && value.startsWith("data:")) {
    const blob = await dataUrlBlob(value);
    const extension = extensionFor(blob.type, "bin");
    form.append(
      key,
      new File([blob], `upload.${extension}`, {
        type: blob.type || "application/octet-stream",
      }),
    );
    return;
  }
  if (typeof value === "object") {
    form.append(key, JSON.stringify(value));
    return;
  }
  form.append(key, String(value));
}

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
  constructor(
    message: string,
    readonly code = "CUSTOM_API_ERROR",
  ) {
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
  if (url.username || url.password || url.search || url.hash)
    throw new CustomApiError("服务地址不能包含账号、参数或片段", "INVALID_API_URL");
  const localHttp =
    url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp)
    throw new CustomApiError("服务地址需要使用 HTTPS", "INSECURE_API_URL");
  return url.origin;
}

/**
 * 读取中转站声明的能力目录。
 *
 * 这份目录是公开的能力声明（自家托管 API 也匿名读同一份），但**带密钥的 GET 会触发
 * 浏览器跨域预检**：只给 `/v1/*` 配了 OPTIONS 的中转站会对 `/api/model-catalog` 的
 * 预检直接 404，于是浏览器整条请求失败，用户「接好 API 却只剩提示词参数、素材与时长/
 * 比例/分辨率全消失」。所以先带密钥读（尊重需要鉴权的中转站），失败再匿名重试——
 * 匿名 GET 是简单请求、不发预检，公开目录因此可读。
 */
async function readCustomApiCatalogDocument(connection: CustomApiConnection) {
  const apiKey = connection.apiKey.trim();
  try {
    return await requestCustomApiCatalogDocument(connection);
  } catch (cause) {
    if (!apiKey) throw cause;
    try {
      return await requestCustomApiCatalogDocument({ ...connection, apiKey: "" });
    } catch {
      // 保留第一次（带密钥）的失败原因：更贴近用户实际配置的那条路径。
      throw cause;
    }
  }
}

async function requestCustomApiCatalogDocument(connection: CustomApiConnection) {
  let response: Response;
  try {
    const request = customApiAuthInit(connection, "/api/model-catalog");
    response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CustomApiError(
      "无法读取模型能力目录（中转站未放行浏览器跨域预检），已退回仅模型列表",
      "CATALOG_UNAVAILABLE",
    );
  }
  if (!response.ok)
    throw new CustomApiError(`模型目录读取失败 (${response.status})`, "CATALOG_UNAVAILABLE");
  try {
    return customApiCatalogSchema.parse(await response.json());
  } catch {
    throw new CustomApiError("模型目录格式不兼容", "CATALOG_INVALID");
  }
}

export async function loadCustomApiCatalog(
  connection: CustomApiConnection,
): Promise<CustomApiCatalog> {
  const origin = normalizeCustomApiBaseUrl(connection.baseUrl);
  const apiFormat = normalizeCustomApiFormat(connection.apiFormat);
  if (apiFormat === "gemini") return loadGeminiCatalog(origin, connection.apiKey);
  const source = await readCustomApiCatalogDocument(connection);
  const routes: Record<string, CustomApiRoute> = {};
  const models: PublicModel[] = [];
  const usedIds = new Set<string>();
  for (const item of source.models) {
    const overrideEndpoint = normalizeProtocolOverride(connection.protocol)?.endpoints?.[
      item.modality
    ];
    const expectedEndpoint = overrideEndpoint ?? EXPECTED_ENDPOINTS[item.modality];
    const endpointAllowed =
      overrideEndpoint !== undefined ||
      (item.modality === "image"
        ? IMAGE_ENDPOINTS.includes(item.endpoint.path as (typeof IMAGE_ENDPOINTS)[number])
        : item.modality === "audio"
          ? isAllowedAudioEndpoint(item.endpoint.path)
          : item.endpoint.path === expectedEndpoint);
    if (
      item.selectable === false ||
      !expectedEndpoint ||
      !endpointAllowed ||
      item.output.type !== item.modality
    )
      continue;
    const id = (item.public?.id ?? item.id).trim();
    if (!id || usedIds.has(id)) continue;
    try {
      const model = normalizeCustomModel(item, id);
      const route = applyProtocolOverride(normalizeCustomRoute(item), connection);
      usedIds.add(id);
      models.push(model);
      routes[id] = route;
    } catch {
      // One malformed model must not hide the rest of a valid catalog.
    }
  }
  if (!models.length) throw new CustomApiError("模型目录中没有画布可用的模型", "CATALOG_EMPTY");
  models.sort(
    (left, right) => left.order - right.order || left.label.localeCompare(right.label, "zh-CN"),
  );
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

export async function testCustomApiConnection(
  connection: CustomApiConnection,
): Promise<CustomApiCatalog> {
  const origin = normalizeCustomApiBaseUrl(connection.baseUrl);
  const apiFormat = normalizeCustomApiFormat(connection.apiFormat);
  const apiKey = connection.apiKey.trim();
  if (!apiKey) throw new CustomApiError("请输入 API Key", "API_KEY_REQUIRED");
  const protocol = connection.protocol;

  if (apiFormat === "gemini") {
    const availableModelIds = await fetchCustomApiModelIdsForFormat(origin, apiKey, apiFormat);
    return modelsOnlyCatalog(availableModelIds, null, apiFormat);
  }

  // Capability metadata and token-scoped availability are independent. Start
  // both reads together so one profile never pays a serial network waterfall.
  const catalogRequest = loadCustomApiCatalog({ baseUrl: origin, apiKey, protocol })
    .then((catalog) => ({ catalog, error: null as string | null }))
    .catch((cause) => ({ catalog: null, error: publicCustomApiError(cause) }));
  const [catalogResult, availableModelIds] = await Promise.all([
    catalogRequest,
    fetchCustomApiModelIdsForFormat(origin, apiKey, apiFormat, protocol),
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
  protocol?: CustomApiProtocolOverride,
) {
  const origin = normalizeCustomApiBaseUrl(originValue);
  const apiFormat = normalizeCustomApiFormat(apiFormatValue);
  const apiKey = apiKeyValue.trim();
  if (!apiKey) throw new CustomApiError("请输入 API Key", "API_KEY_REQUIRED");
  let response: Response;
  try {
    if (apiFormat === "gemini") {
      response = await fetch(`${origin}/v1beta/models`, {
        headers: { Accept: "application/json", "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(CONNECTION_CHECK_TIMEOUT_MS),
      });
    } else {
      // 模型列表与执行共用同一套认证样式：自定义头/查询参数的中转站也能连上。
      const request = customApiAuthInit({ baseUrl: origin, apiKey, protocol }, "/v1/models");
      response = await fetch(request.url, {
        headers: request.headers,
        signal: AbortSignal.timeout(CONNECTION_CHECK_TIMEOUT_MS),
      });
    }
  } catch {
    throw new CustomApiError("连接测试失败，请检查网络和跨域设置", "CONNECTION_FAILED");
  }
  if (response.status === 401 || response.status === 403)
    throw new CustomApiError("API Key 无效或没有读取模型权限", "API_KEY_REJECTED");
  if (!response.ok)
    throw new CustomApiError(`连接测试失败 (${response.status})`, "CONNECTION_FAILED");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CustomApiError("模型列表格式不兼容", "MODEL_LIST_INVALID");
  }
  if (apiFormat === "gemini") {
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray((value as { models?: unknown }).models)
    ) {
      throw new CustomApiError("Gemini 模型列表格式不兼容", "MODEL_LIST_INVALID");
    }
    return uniqueStrings(
      (value as { models: unknown[] }).models.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const source = item as { name?: unknown; supportedGenerationMethods?: unknown };
        if (
          Array.isArray(source.supportedGenerationMethods) &&
          !source.supportedGenerationMethods.includes("generateContent")
        )
          return [];
        return typeof source.name === "string" && source.name.trim()
          ? [source.name.trim().replace(/^models\//, "")]
          : [];
      }),
    ).sort((left, right) => left.localeCompare(right));
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
    throw new CustomApiError("模型列表格式不兼容", "MODEL_LIST_INVALID");
  }
  return uniqueStrings(
    (value as { data: unknown[] }).data.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" && id.trim() ? [id.trim()] : [];
    }),
  ).sort((left, right) => left.localeCompare(right));
}

export function createSyntheticCustomModel(modelId: string, modality: ModelModality): PublicModel {
  const knownModel = createKnownCustomModel(modelId, modality);
  if (knownModel) return knownModel;
  const textParameter =
    modality === "text" || modality === "audio"
      ? {
          name: "messages",
          label: "消息",
          type: "array" as const,
          required: true,
          items: { type: "object" as const },
          mutuallyExclusiveWith: [],
        }
      : {
          name: "prompt",
          label: "提示词",
          type: "string" as const,
          required: true,
          mutuallyExclusiveWith: [],
        };
  return publicModelSchema.parse({
    id: modelId,
    label: modelId,
    description: "未读取到中转站的能力目录：只提交提示词，其余参数按兼容协议处理",
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

export function createSyntheticCustomRoute(
  modelId: string,
  modality: ModelModality,
): CustomApiRoute | null {
  const knownRoute = createKnownCustomRoute(modelId, modality);
  if (knownRoute) return knownRoute;
  const endpointPath: string =
    modality === "image" ? "/v1/images/generations" : (EXPECTED_ENDPOINTS[modality] as string);
  if (!endpointPath) return null;
  const inputName = modality === "text" || modality === "audio" ? "messages" : "prompt";
  return {
    sourceModelId: modelId,
    modality,
    endpointPath,
    parameters: [
      { name: "model", path: "model", type: "string", fixed: modelId },
      {
        name: inputName,
        path: inputName,
        type: modality === "text" || modality === "audio" ? "array" : "string",
      },
      ...(modality === "image"
        ? [
            {
              name: "images",
              path: "images",
              type: "array" as const,
              itemsFormat: "uri-or-data-image",
            },
          ]
        : []),
    ],
  };
}

function retainAvailableRichModels(
  catalog: CustomApiCatalog,
  availableModelIds: string[],
): CustomApiCatalog {
  const available = new Set(availableModelIds);
  const models = catalog.models.filter((model) => {
    const route = catalog.routes[model.id];
    return Boolean(route && (available.has(route.sourceModelId) || available.has(model.id)));
  });
  const routes = Object.fromEntries(
    models.flatMap((model) => {
      const route = catalog.routes[model.id];
      return route ? [[model.id, route]] : [];
    }),
  );
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
    const model =
      apiFormat === "gemini"
        ? createSyntheticCustomModel(modelId, "text")
        : createKnownCustomModel(modelId, "video");
    return model ? [model] : [];
  });
  const routes = Object.fromEntries(
    models.flatMap((model) => {
      const route =
        apiFormat === "gemini"
          ? createSyntheticCustomRoute(model.id, model.modality)
          : createKnownCustomRoute(model.id, model.modality);
      return route ? [[model.id, route]] : [];
    }),
  );
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
  return value === "text" || value === "image" || value === "video" || value === "audio"
    ? value
    : null;
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
  assertRoute(input.model, input.route, input.connection);
  const isMidjourney =
    input.model.modality === "image" && input.route.endpointPath === "/v1/midjourney/generations";
  const payload = isMidjourney
    ? buildRequestPayload(input.route, input.parameters, input.inputs)
    : input.model.modality === "video"
      ? buildVideoRequestPayload(input.model.id, input.route, input.parameters, input.inputs)
      : input.model.modality === "image" && input.model.protocol?.version === "image.v1"
        ? buildImageRequestPayload(input.model.id, input.route, input.parameters, input.inputs)
        : buildRequestPayload(input.route, input.parameters, input.inputs);
  if (input.model.modality === "audio") normalizeAudioSpeechConfig(payload);
  assertKnownModelConstraints(input.route, payload, input.inputs);
  input.onProgress?.(8);
  const response = await requestJson(
    input.connection,
    input.route.endpointPath,
    "POST",
    payload,
    10 * 60_000,
  );

  if (input.model.modality === "text") {
    const parsed = customApiTextResponseSchema.safeParse(response);
    const text = parsed.success ? messageText(parsed.data.choices[0]!.message.content).trim() : "";
    if (!text) throw new CustomApiError("文本生成没有返回可用内容", "TEXT_RESULT_EMPTY");
    input.onProgress?.(100);
    return { text };
  }
  if (input.model.modality === "image") {
    if (input.route.endpointPath === "/v1/midjourney/generations") {
      return executeCustomMidjourneyGeneration(input, input.connection, response);
    }
    const parsed = customApiImageResponseSchema.safeParse(response);
    if (!parsed.success) throw new CustomApiError("图片生成返回格式不兼容", "IMAGE_RESULT_INVALID");
    const items =
      "outputs" in parsed.data
        ? (parsed.data.outputs as Array<{ content_url: string }>).map((output) => ({
            url: output.content_url,
          }))
        : parsed.data.data;
    const media: CanvasMedia[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const blob = await imageResultBlob(item, input.connection);
      media.push(
        await storeMedia(
          new File(
            [blob],
            `generated-${Date.now()}-${index + 1}.${extensionFor(blob.type, "png")}`,
            { type: blob.type || "image/png" },
          ),
          "image",
        ),
      );
      input.onProgress?.(Math.min(100, 70 + Math.round(((index + 1) / items.length) * 30)));
    }
    return { media };
  }
  if (input.model.modality === "audio") {
    const media: CanvasMedia[] = [];
    if (isGeminiNativeAudioPath(input.route.endpointPath)) {
      const blob = geminiInlineAudioBlob(response);
      media.push(await storeAudioResult(blob, 0));
    } else {
      const urls = collectAudioResultUrls(response, origin);
      for (const [index, url] of urls.entries()) {
        const blob = await downloadResult(url, input.connection, "audio");
        media.push(await storeAudioResult(blob, index));
        input.onProgress?.(Math.min(100, 60 + Math.round(((index + 1) / urls.length) * 40)));
      }
    }
    input.onProgress?.(100);
    return { media };
  }
  if (input.model.modality === "video") {
    const { payload: completed, taskId } = await waitForVideo(
      input.connection,
      response,
      input.onProgress,
    );
    const url =
      videoResultUrl(completed, protocolResultPaths(input.connection)) ??
      (taskId ? videoContentUrl(origin, taskId) : null);
    if (!url) throw new CustomApiError("视频任务完成但没有返回可用文件", "VIDEO_RESULT_MISSING");
    const blob = await downloadResult(url, input.connection, "video");
    const media = await storeMedia(
      new File([blob], `generated-${Date.now()}.${extensionFor(blob.type, "mp4")}`, {
        type: blob.type || "video/mp4",
      }),
      "video",
    );
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
    throw new CustomApiError(
      "Gemini 原生视频需要专用异步适配器，请使用 OpenAI 兼容渠道",
      "GEMINI_VIDEO_UNSUPPORTED",
    );
  }
  if (input.model.modality === "audio") {
    const prompt = geminiPrompt(input.parameters);
    if (!prompt) throw new CustomApiError("Gemini 模型需要非空提示词", "PROMPT_REQUIRED");
    input.onProgress?.(12);
    const speechConfig = geminiSpeechConfig(input.parameters);
    const response = await requestGeminiContent(origin, apiKey, input.model.id, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        ...(speechConfig ? { speechConfig } : {}),
      },
    });
    const blob = geminiInlineAudioBlob(response);
    const media = [await storeAudioResult(blob, 0)];
    input.onProgress?.(100);
    return { media };
  }
  const prompt = geminiPrompt(input.parameters);
  if (!prompt) throw new CustomApiError("Gemini 模型需要非空提示词", "PROMPT_REQUIRED");
  const parts: GeminiPart[] = [{ text: prompt }];
  if (input.model.modality === "image") {
    for (const value of input.inputs.images ?? [])
      parts.push(await geminiInlinePart(value, "image/png"));
  }
  input.onProgress?.(12);
  const response = await requestGeminiContent(origin, apiKey, input.model.id, {
    contents: [{ role: "user", parts }],
    ...(input.model.modality === "image"
      ? { generationConfig: geminiImageGenerationConfig(input.parameters) }
      : {}),
  });
  if (input.model.modality === "text") {
    const text = geminiResponseText(response).trim();
    if (!text) throw new CustomApiError("Gemini 文本生成没有返回可用内容", "TEXT_RESULT_EMPTY");
    input.onProgress?.(100);
    return { text };
  }
  const media: CanvasMedia[] = [];
  for (const [index, part] of geminiResponseParts(response).entries()) {
    const inlineData =
      part.inlineData ??
      (
        part as GeminiPart & {
          inline_data?: { mime_type?: string; mimeType?: string; data?: string };
        }
      ).inline_data;
    if (!inlineData?.data) continue;
    const mimeType = inlineData.mimeType || "image/png";
    const blob = base64Blob(inlineData.data, mimeType);
    media.push(
      await storeMedia(
        new File([blob], `generated-${Date.now()}-${index + 1}.${extensionFor(mimeType, "png")}`, {
          type: mimeType,
        }),
        "image",
      ),
    );
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
      return content.flatMap((item) =>
        item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
          ? [(item as { text: string }).text]
          : [],
      );
    })
    .join("\n")
    .trim();
}

function geminiImageGenerationConfig(parameters: Record<string, unknown>) {
  const aspectRatio =
    typeof parameters.aspect_ratio === "string"
      ? parameters.aspect_ratio
      : typeof parameters.ratio === "string"
        ? parameters.ratio
        : undefined;
  const imageSize = typeof parameters.resolution === "string" ? parameters.resolution : undefined;
  return {
    responseModalities: ["TEXT", "IMAGE"],
    ...(aspectRatio || imageSize
      ? {
          imageConfig: {
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(imageSize ? { imageSize } : {}),
          },
        }
      : {}),
  };
}

/** 音色下拉发裸选项值时，包成 Gemini 要求的 speechConfig 对象形态。 */
function normalizeAudioSpeechConfig(payload: Record<string, unknown>) {
  const generationConfig =
    payload.generationConfig && typeof payload.generationConfig === "object"
      ? (payload.generationConfig as Record<string, unknown>)
      : null;
  if (generationConfig && typeof generationConfig.speechConfig === "string")
    generationConfig.speechConfig = { voiceConfig: { voice: generationConfig.speechConfig } };
}

function geminiSpeechConfig(parameters: Record<string, unknown>) {
  const value = parameters.speechConfig ?? parameters.voice;
  if (typeof value === "string" && value.trim()) return { voiceConfig: { voice: value.trim() } };
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return null;
}

/**
 * chat/completions 音频结果的链接收集（与托管执行侧同一口径的多形态兼容）：
 * message.audio / content 内嵌链接 / data[].url / outputs[].content_url /
 * 顶层 url。一个都收不到就显式失败，绝不伪造。
 */
function collectAudioResultUrls(value: unknown, origin: string): string[] {
  if (!value || typeof value !== "object") throw audioUnparseable();
  const response = value as Record<string, unknown>;
  const urls: string[] = [];
  const pushUrl = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    let resolved: string | null = null;
    try {
      const url = new URL(candidate, `${origin}/`);
      if (url.protocol === "https:" || url.protocol === "http:") resolved = url.toString();
    } catch {
      /* not a URL */
    }
    if (resolved && !urls.includes(resolved)) urls.push(resolved);
  };
  const records = (list: unknown) =>
    Array.isArray(list)
      ? list.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
      : [];
  for (const choice of records(response.choices)) {
    const message = choice.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const audio = message.audio;
    if (audio && typeof audio === "object") pushUrl((audio as { url?: unknown }).url);
    pushUrl(message.audio_url);
    if (typeof message.content === "string") {
      for (const match of message.content.matchAll(/https?:\/\/[^\s"'<>()\[\]]+/g))
        pushUrl(match[0].replace(/[.,;:!?)]+$/, ""));
    } else if (Array.isArray(message.content)) {
      for (const part of records(message.content)) {
        const partAudio = part.audio;
        if (partAudio && typeof partAudio === "object")
          pushUrl((partAudio as { url?: unknown }).url);
        pushUrl(part.url);
      }
    }
  }
  for (const item of records(response.data)) {
    pushUrl(item.url);
    pushUrl(item.audio_url);
    pushUrl(item.download_url);
    pushUrl(item.content_url);
  }
  for (const item of records(response.outputs)) {
    pushUrl(item.content_url);
    pushUrl(item.download_url);
    pushUrl(item.url);
  }
  const topAudio = response.audio;
  if (topAudio && typeof topAudio === "object") pushUrl((topAudio as { url?: unknown }).url);
  pushUrl(response.url);
  pushUrl(response.audio_url);
  const limited = urls.slice(0, 8);
  if (!limited.length) throw audioUnparseable();
  return limited;
}

/** Gemini 原生音频响应：按 parts 顺序拼接内联数据；无头 PCM 包成 WAV。 */
function geminiInlineAudioBlob(response: unknown): Blob {
  const chunks = geminiResponseParts(response)
    .map(
      (part) =>
        part.inlineData ??
        (
          part as GeminiPart & {
            inline_data?: { mime_type?: string; mimeType?: string; data?: string };
          }
        ).inline_data,
    )
    .filter((entry): entry is { mimeType?: string; mime_type?: string; data?: string } =>
      Boolean(entry && typeof entry.data === "string" && entry.data.length > 0),
    );
  if (!chunks.length) throw new CustomApiError("语音合成没有返回音频数据", "AUDIO_RESULT_EMPTY");
  const mimeType = chunks[0]?.mimeType || chunks[0]?.mime_type || "";
  // 上游实测：各 part 的 base64 段按序直接拼接即为完整流（段界 4 字符对齐）。
  const combined = chunks.map((entry) => entry.data!).join("");
  if (/l16|pcm/i.test(mimeType)) {
    const sampleRate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24_000);
    const channels = Number(/channels=(\d+)/i.exec(mimeType)?.[1] ?? 1);
    const binary = atob(combined);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([wrapPcmToWav(bytes, { sampleRate, channels }).slice().buffer], {
      type: "audio/wav",
    });
  }
  if (!mimeType.toLowerCase().startsWith("audio/")) throw audioUnparseable();
  return base64Blob(combined, mimeType);
}

async function storeAudioResult(blob: Blob, index: number): Promise<CanvasMedia> {
  const type = blob.type || "audio/mpeg";
  return storeMedia(
    new File([blob], `generated-${Date.now()}-${index + 1}.${extensionFor(type, "mp3")}`, {
      type,
    }),
    "audio",
  );
}

function audioUnparseable() {
  return new CustomApiError(
    "音频结果格式无法识别，需要确认上游响应形态",
    "AUDIO_RESULT_UNPARSEABLE",
  );
}

async function geminiInlinePart(value: string, fallbackMimeType: string): Promise<GeminiPart> {
  const dataMatch = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataMatch) return { inlineData: { mimeType: dataMatch[1], data: dataMatch[2] } };
  if (!isHttpUrl(value))
    throw new CustomApiError(
      "Gemini 参考素材必须是 data URL 或 HTTPS 地址",
      "REFERENCE_FORMAT_INVALID",
    );
  let response: Response;
  try {
    response = await fetch(value, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new CustomApiError("Gemini 参考素材读取失败", "REFERENCE_DOWNLOAD_FAILED");
  }
  if (!response.ok)
    throw new CustomApiError(
      `Gemini 参考素材读取失败 (${response.status})`,
      "REFERENCE_DOWNLOAD_FAILED",
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    inlineData: {
      mimeType: response.headers.get("content-type")?.split(";", 1)[0] || fallbackMimeType,
      data: bytesToBase64(bytes),
    },
  };
}

async function requestGeminiContent(
  origin: string,
  apiKey: string,
  modelId: string,
  body: Record<string, unknown>,
) {
  const url = new URL(
    `/v1beta/models/${encodeURIComponent(modelId.replace(/^models\//, ""))}:generateContent`,
    origin,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch {
    throw new CustomApiError("Gemini 请求连接中断，请检查任务记录后重试", "NETWORK_ERROR");
  }
  if (!response.ok) {
    let detail = "";
    try {
      const value = (await response.json()) as { error?: { message?: unknown } };
      detail = typeof value.error?.message === "string" ? value.error.message : "";
    } catch {
      // Keep a stable fallback for non-JSON provider errors.
    }
    throw new CustomApiError(
      detail || `Gemini 请求失败 (${response.status})`,
      `HTTP_${response.status}`,
    );
  }
  try {
    return (await response.json()) as unknown;
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
    return Array.isArray(parts)
      ? parts.filter((part): part is GeminiPart => Boolean(part && typeof part === "object"))
      : [];
  });
}

function geminiResponseText(value: unknown) {
  return geminiResponseParts(value)
    .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
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
    .map((parameter) =>
      modelParameterSchema.parse({
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
      }),
    );
  return publicModelSchema.parse({
    id,
    label: item.public?.label ?? item.label ?? item.id,
    description: item.public?.description ?? item.description ?? "",
    modality: item.modality,
    operation: item.operation,
    order: item.order ?? 0,
    ...(item.protocol
      ? item.protocol.version === "audio.v1"
        ? {
            protocol: {
              version: item.protocol.version,
              outputFormat: item.protocol.output_format,
            },
          }
        : {
            protocol: {
              version: item.protocol.version,
              endpoint: item.protocol.endpoint,
              mediaRoles: item.protocol.media_roles,
            },
          }
      : {}),
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

function normalizeRouteParameter(
  parameter: CustomApiCatalogParameterSource,
): CustomApiRouteParameter {
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

function normalizeInputCount(
  item: CustomApiCatalogModelSource,
  kind: "images" | "videos" | "audios",
): ModelInputCount | undefined {
  const source = item.input?.[kind];
  const mediaKind = kind.slice(0, -1) as MediaReferenceKind;
  const mediaParameters = item.parameters.filter((parameter) => {
    const binding = mediaParameterBindingFor(parameter);
    return (
      binding?.kind === mediaKind && binding.position !== "style" && binding.position !== "element"
    );
  });
  const arrayParameter = mediaParameters.find((parameter) => parameter.type === "array");
  const singleParameters = mediaParameters.filter((parameter) => parameter.type !== "array");
  if (!source && !mediaParameters.length) return undefined;
  const positionedCount = singleParameters.filter(
    (parameter) => mediaParameterBindingFor(parameter)?.position !== "reference",
  ).length;
  const inferredMax = arrayParameter
    ? undefined
    : positionedCount || (singleParameters.length ? 1 : undefined);
  const max = source?.max ?? arrayParameter?.max_items ?? inferredMax;
  const minimum =
    item.modality === "image" && kind === "images"
      ? imageInputMinimum(source?.min, arrayParameter)
      : (source?.min ?? arrayParameter?.min_items ?? 0);
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
  if (
    arrayParameter &&
    (arrayParameter.min_items ?? 0) > 0 &&
    (isExplicitReferenceParameterName(arrayParameter.name) ||
      isExplicitReferenceParameterName(arrayParameter.path?.split(".").at(-1)))
  ) {
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

function normalizeReferenceMedia(
  item: CustomApiCatalogModelSource,
): ModelReferenceMedia | undefined {
  const mediaParameters = bindableMediaParameters(item);
  if (!mediaParameters.length) return undefined;

  const source = item.input?.reference_media;
  const images = normalizeReferenceInputCount(
    mediaParameters.filter(
      ({ binding }) =>
        binding.kind === "image" && ["reference", "first", "last"].includes(binding.position),
    ),
    source?.images,
    "image",
    imageReferenceMinimumOverride(item, mediaParameters, source?.images),
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
  const maxTotalItems = minimumDefined(
    aggregateReferenceLimit(mediaParameters),
    source?.max_total_items,
  );

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
  const usesFrames = kind === "image" && positioned.length > 0;
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
    ({ binding }) =>
      binding.kind === "image" && ["reference", "first", "last"].includes(binding.position),
  );
  const explicitlyRequiredCapability = (source?.min ?? 0) > 0 || (item.input?.images?.min ?? 0) > 0;
  const hasExplicitReferenceName = referenceParameters.some(
    ({ parameter }) =>
      isExplicitReferenceParameterName(parameter.name) ||
      isExplicitReferenceParameterName(parameter.path?.split(".").at(-1)),
  );
  return explicitlyRequiredCapability || hasExplicitReferenceName ? undefined : 0;
}

function isExplicitReferenceParameterName(value: string | undefined) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    MEDIA_REFERENCE_PARAMETER_NAME.test(value.replaceAll("_", "").toLowerCase())
  );
}

function bindableMediaParameters(item: CustomApiCatalogModelSource): BindableMediaParameter[] {
  return item.parameters.flatMap((parameter) => {
    if (
      (parameter.type !== "string" && parameter.type !== "array") ||
      parameter.fixed !== undefined
    )
      return [];
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

function assertRoute(model: PublicModel, route: CustomApiRoute, connection?: CustomApiConnection) {
  const override = connection
    ? normalizeProtocolOverride(connection.protocol)?.endpoints?.[model.modality]
    : undefined;
  const expected = override ?? EXPECTED_ENDPOINTS[model.modality];
  const endpointAllowed =
    override !== undefined
      ? route.endpointPath === override
      : model.modality === "image"
        ? IMAGE_ENDPOINTS.includes(route.endpointPath as (typeof IMAGE_ENDPOINTS)[number])
        : model.modality === "audio"
          ? isAllowedAudioEndpoint(route.endpointPath)
          : route.endpointPath === expected;
  if (!expected || route.modality !== model.modality || !endpointAllowed) {
    throw new CustomApiError("当前模型调用路径不兼容", "ROUTE_INVALID");
  }
}

function buildRequestPayload(
  route: CustomApiRoute,
  parameters: Record<string, unknown>,
  inputs: GenerationJobInput,
) {
  const payload: Record<string, unknown> = {};
  for (const parameter of route.parameters) {
    if (parameter.fixed !== undefined) setPath(payload, parameter.path, parameter.fixed);
    else if (!isMediaParameter(parameter) && parameters[parameter.name] !== undefined)
      setPath(payload, parameter.path, parameters[parameter.name]);
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
    ...optionalString(
      "aspectRatio",
      imageScalar(route, parameters, ["aspect_ratio", "aspectRatio", "ratio", "size"]),
    ),
    ...optionalString("quality", imageScalar(route, parameters, ["quality"])),
    ...optionalNumber("count", imageScalar(route, parameters, ["count", "n"])),
    mediaInputs,
    options,
  });
  const projectedParameters: Record<string, unknown> = {
    ...protocol.options,
    prompt: protocol.prompt,
  };
  assignImageScalar(projectedParameters, route, ["resolution"], protocol.resolution);
  assignImageScalar(
    projectedParameters,
    route,
    ["aspect_ratio", "aspectRatio", "ratio", "size"],
    protocol.aspect_ratio,
  );
  assignImageScalar(projectedParameters, route, ["quality"], protocol.quality);
  assignImageScalar(projectedParameters, route, ["count", "n"], protocol.count);
  const projectedInputs: GenerationJobInput = {
    images:
      protocol.media_inputs?.filter((item) => item.role === "reference").map((item) => item.url) ??
      [],
    styleImages:
      protocol.media_inputs
        ?.filter((item) => item.role === "style_reference")
        .map((item) => item.url) ?? [],
    elementImages:
      protocol.media_inputs
        ?.filter((item) => item.role === "element_reference")
        .map((item) => item.url) ?? [],
    videos: [],
    audios: [],
  };
  const payload = buildRequestPayload(route, projectedParameters, projectedInputs);
  const mask = protocol.media_inputs?.find((item) => item.role === "mask");
  if (mask) {
    const maskParameter = route.parameters.find((parameter) =>
      /mask|inpaint/i.test(`${parameter.name} ${parameter.path}`),
    );
    if (!maskParameter) throw new CustomApiError("当前模型不支持编辑遮罩", "MASK_UNAVAILABLE");
    setPath(payload, maskParameter.path, requireCompatibleReference(mask.url, maskParameter));
  }
  return payload;
}

function assignImageScalar(
  target: Record<string, unknown>,
  route: CustomApiRoute,
  aliases: string[],
  value: unknown,
) {
  if (value === undefined) return;
  const parameter = route.parameters.find(
    (candidate) =>
      aliases.includes(candidate.name) || aliases.includes(candidate.path.split(".").at(-1) ?? ""),
  );
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
    return (
      binding?.kind === "image" &&
      (position
        ? binding.position === position
        : ["reference", "first", "last"].includes(binding.position))
    );
  });
  const arrayParameter = candidates.find((parameter) => parameter.type === "array");
  const singleParameter = candidates.find((parameter) => parameter.type !== "array");
  const selected = values.length === 1 ? (singleParameter ?? arrayParameter) : arrayParameter;
  if (!selected) throw new CustomApiError("当前模型不支持这么多参考图", "TOO_MANY_REFERENCES");
  for (const value of values) {
    target.push({
      kind: "image",
      role,
      url: requireCompatibleReference(value, selected, selected.type === "array"),
    });
  }
}

function imageScalar(route: CustomApiRoute, values: Record<string, unknown>, aliases: string[]) {
  for (const alias of aliases) {
    const parameter = route.parameters.find(
      (candidate) => candidate.name === alias || candidate.path.split(".").at(-1) === alias,
    );
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
  return (
    new Set([
      "version",
      "operation",
      "model",
      "prompt",
      "resolution",
      "size",
      "aspect_ratio",
      "aspectRatio",
      "ratio",
      "quality",
      "count",
      "n",
      "media_inputs",
      "options",
    ]).has(parameter.name) ||
    new Set([
      "version",
      "operation",
      "model",
      "prompt",
      "resolution",
      "size",
      "aspect_ratio",
      "aspectRatio",
      "ratio",
      "quality",
      "count",
      "n",
      "media_inputs",
      "options",
    ]).has(parameter.path.split(".").at(-1) ?? "")
  );
}

function optionalString(key: "resolution" | "aspectRatio" | "quality", value: unknown) {
  return typeof value === "string" && value.trim() ? { [key]: value } : {};
}

function optionalNumber(key: "count", value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? { [key]: number } : {};
}

const VIDEO_CORE_PARAMETER_NAMES = new Set([
  "version",
  "operation",
  "model",
  "prompt",
  "duration_seconds",
  "duration",
  "seconds",
  "resolution",
  "size",
  "aspect_ratio",
  "ratio",
  "media_inputs",
  "options",
  "async",
  "n",
]);

function buildVideoRequestPayload(
  publicModelId: string,
  route: CustomApiRoute,
  parameters: Record<string, unknown>,
  inputs: GenerationJobInput,
) {
  const mediaInputs: VideoMediaInput[] = [];
  appendVideoImages(mediaInputs, route, inputs.images ?? []);
  appendVideoMedia(
    mediaInputs,
    route,
    inputs.styleImages ?? [],
    "image",
    "style",
    "style_reference",
  );
  appendVideoMedia(
    mediaInputs,
    route,
    inputs.elementImages ?? [],
    "image",
    "element",
    "element_reference",
  );
  appendVideoMedia(mediaInputs, route, inputs.videos ?? [], "video", "reference", "reference");
  appendVideoMedia(
    mediaInputs,
    route,
    inputs.audios ?? [],
    "audio",
    "reference",
    "audio_reference",
  );

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
    const parameter = route.parameters.find(
      (candidate) => candidate.name === alias || candidate.path.split(".").at(-1) === alias,
    );
    if (!parameter) continue;
    if (parameter.fixed !== undefined) return parameter.fixed;
    if (values[parameter.name] !== undefined) return values[parameter.name];
    if (parameter.default !== undefined) return parameter.default;
  }
  return undefined;
}

function isVideoCoreParameter(parameter: CustomApiRouteParameter) {
  return (
    VIDEO_CORE_PARAMETER_NAMES.has(parameter.name) ||
    VIDEO_CORE_PARAMETER_NAMES.has(parameter.path.split(".").at(-1) ?? "")
  );
}

function appendVideoImages(target: VideoMediaInput[], route: CustomApiRoute, values: string[]) {
  if (!values.length) return;
  const first = route.parameters.find(
    (parameter) => mediaParameterBindingFor(parameter)?.position === "first",
  );
  const last = route.parameters.find(
    (parameter) => mediaParameterBindingFor(parameter)?.position === "last",
  );
  if (!first && !last) {
    appendVideoMedia(target, route, values, "image", "reference", "reference");
    return;
  }
  const availableSlots = Number(Boolean(first)) + Number(Boolean(last));
  if (values.length > availableSlots)
    throw new CustomApiError("当前模型最多接收首尾两张参考图", "TOO_MANY_REFERENCES");
  if (first)
    target.push({
      kind: "image",
      role: "first_frame",
      url: requireVideoReference(values[0]!, first, "image"),
    });
  if (last && values[1])
    target.push({
      kind: "image",
      role: "last_frame",
      url: requireVideoReference(values.at(-1)!, last, "image"),
    });
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
  const selected = values.length === 1 ? (singleParameter ?? arrayParameter) : arrayParameter;
  if (!selected) throw new CustomApiError("当前模型不支持这么多参考素材", "TOO_MANY_REFERENCES");
  const semanticRole = kind === "video" && isSourceVideoParameter(selected) ? "source_video" : role;
  for (const value of values) {
    target.push({
      kind,
      role: semanticRole,
      url: requireVideoReference(value, selected, kind, selected.type === "array"),
    });
  }
}

function isSourceVideoParameter(parameter: CustomApiRouteParameter) {
  const names = [parameter.name, parameter.path.split(".").at(-1) ?? ""].map((value) =>
    value.replaceAll("_", "").toLowerCase(),
  );
  return names.some((value) => value === "inputvideo" || value === "sourcevideo");
}

function requireVideoReference(
  value: string,
  parameter: CustomApiRouteParameter,
  kind: MediaReferenceKind,
  arrayItem = false,
) {
  const reference = requireCompatibleReference(value, parameter, arrayItem);
  const format = arrayItem ? (parameter.itemsFormat ?? parameter.format) : parameter.format;
  if (format?.startsWith("public-http-url")) {
    if (!isHttpUrl(reference))
      throw new CustomApiError("当前模型要求公网参考素材", "REFERENCE_NOT_PUBLIC");
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
  const first = route.parameters.find(
    (parameter) => mediaParameterBindingFor(parameter)?.position === "first",
  );
  const last = route.parameters.find(
    (parameter) => mediaParameterBindingFor(parameter)?.position === "last",
  );
  if (first || last) {
    if (values.length > 2)
      throw new CustomApiError("当前模型最多接收首尾两张参考图", "TOO_MANY_REFERENCES");
    if (first) setPath(payload, first.path, requireCompatibleReference(values[0]!, first));
    if (last && values[1])
      setPath(payload, last.path, requireCompatibleReference(values.at(-1)!, last));
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
  if (!arrayParameter)
    throw new CustomApiError("当前模型不支持这么多参考素材", "TOO_MANY_REFERENCES");
  setPath(
    payload,
    arrayParameter.path,
    values.map((value) => {
      const reference = requireCompatibleReference(value, arrayParameter, true);
      return arrayParameter.itemsFormat === "public-http-url-object"
        ? { url: reference }
        : reference;
    }),
  );
}

function requireCompatibleReference(
  value: string,
  parameter: CustomApiRouteParameter,
  arrayItem = false,
) {
  const format = arrayItem ? (parameter.itemsFormat ?? parameter.format) : parameter.format;
  if (format?.startsWith("public-http-url") && value.startsWith("data:")) {
    throw new CustomApiError(
      "当前模型要求公网参考素材，本地文件暂不能直接提交",
      "REFERENCE_NOT_PUBLIC",
    );
  }
  return value;
}

async function requestJson(
  connection: CustomApiConnection,
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  timeoutMs = 30_000,
) {
  const { url, headers } = customApiAuthInit(connection, path);
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body) {
    const built = await buildProtocolRequestBody(body, protocolContentType(connection));
    init.body = built.body;
    Object.assign(headers, built.headers);
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new CustomApiError(
      method === "POST" ? "生成请求连接中断，请先检查任务记录再重试" : "暂时无法获取生成进度",
      "NETWORK_ERROR",
    );
  }
  if (!response.ok)
    throw await customApiResponseError(response, normalizeProtocolOverride(connection.protocol));
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new CustomApiError("API 返回格式不兼容", "RESPONSE_INVALID");
  }
}

async function customApiResponseError(response: Response, protocol?: CustomApiProtocolOverride) {
  let detail = "";
  let code = "";
  try {
    const value: unknown = await response.json();
    // 先按协议档案的点路径取，再退回内置候选（含 `msg` 这类中转站常见字段）。
    detail = errorMessageAtPaths(value, protocol)?.value ?? "";
    code = errorCodeAtPaths(value, protocol)?.value ?? "";
  } catch {
    // Keep a stable public fallback for non-JSON errors.
  }
  const message =
    response.status === 401 || response.status === 403
      ? "API Key 无效或没有调用权限"
      : response.status === 429
        ? "请求过于频繁，请稍后重试"
        : detail.trim().slice(0, 240) ||
          (code
            ? `生成请求失败 (${response.status} · ${code})`
            : `生成请求失败 (${response.status})`);
  return new CustomApiError(message, `HTTP_${response.status}`);
}

async function imageResultBlob(
  item: { url?: string; b64_json?: string },
  connection: CustomApiConnection,
) {
  if (item.b64_json) return base64Blob(item.b64_json, "image/png");
  if (item.url?.startsWith("data:image/")) return dataUrlBlob(item.url);
  if (item.url && isHttpUrl(item.url)) return downloadResult(item.url, connection, "image");
  throw new CustomApiError("图片生成没有返回可用文件", "IMAGE_RESULT_INVALID");
}

async function executeCustomMidjourneyGeneration(
  input: {
    model: PublicModel;
    onProgress?: (progress: number) => void;
  },
  connection: CustomApiConnection,
  initial: unknown,
): Promise<{ media: CanvasMedia[] }> {
  const completed = await waitForCustomMidjourney(connection, initial, input.onProgress);
  if (!completed.length) {
    throw new CustomApiError("图片生成完成但没有返回可用文件", "IMAGE_RESULT_MISSING");
  }
  const media: CanvasMedia[] = [];
  for (let index = 0; index < completed.length; index += 1) {
    const item = completed[index]!;
    const blob = await imageResultBlob(item, connection);
    media.push(
      await storeMedia(
        new File([blob], `generated-${Date.now()}-${index + 1}.${extensionFor(blob.type, "png")}`, {
          type: blob.type || "image/png",
        }),
        "image",
      ),
    );
    input.onProgress?.(Math.min(100, 70 + Math.round(((index + 1) / completed.length) * 30)));
  }
  return { media };
}

async function waitForCustomMidjourney(
  connection: CustomApiConnection,
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
        customMidjourneyError(current)
          ? `图片生成失败：${customMidjourneyError(current)}`
          : "图片生成失败",
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
        connection,
        usedLegacyTaskPath
          ? `/v1/midjourney/${encodeURIComponent(taskId)}`
          : `/v1/tasks/${encodeURIComponent(taskId)}`,
        "GET",
      );
    } catch (error) {
      // Some older MJ relays expose task details at /v1/midjourney/:id.
      // Retry that compatibility path only for a definitive 404.
      if (!usedLegacyTaskPath && error instanceof CustomApiError && error.code === "HTTP_404") {
        usedLegacyTaskPath = true;
        current = await requestJson(
          connection,
          `/v1/midjourney/${encodeURIComponent(taskId)}`,
          "GET",
        );
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
  if (data && typeof data === "object" && !Array.isArray(data))
    return data as Record<string, unknown>;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object" && !Array.isArray(data[0])) {
    return data[0] as Record<string, unknown>;
  }
  return root;
}

function customMidjourneyStatus(value: unknown): "completed" | "failed" | "running" | "pending" {
  const record = customMidjourneyRecord(value);
  const raw =
    typeof record?.status === "string" ? record.status.trim().toLowerCase().replace(/-/g, "_") : "";
  if (["completed", "complete", "success", "succeeded", "done"].includes(raw)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled", "timeout"].includes(raw))
    return "failed";
  if (["running", "processing", "in_progress"].includes(raw)) return "running";
  return "pending";
}

function customMidjourneyProgress(value: unknown, fallback: number) {
  const record = customMidjourneyRecord(value);
  const progress =
    typeof record?.progress === "number" ? record.progress : Number(record?.progress);
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : fallback;
}

function customMidjourneyError(value: unknown) {
  const record = customMidjourneyRecord(value);
  const error = record?.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 240);
  if (
    error &&
    typeof error === "object" &&
    typeof (error as Record<string, unknown>).message === "string"
  ) {
    return String((error as Record<string, unknown>).message)
      .trim()
      .slice(0, 240);
  }
  for (const key of ["message", "error_message", "fail_reason", "failure_reason"]) {
    if (typeof record?.[key] === "string" && String(record[key]).trim())
      return String(record[key]).trim().slice(0, 240);
  }
  return "";
}

function customMidjourneyImageItems(value: unknown): Array<{ url?: string; b64_json?: string }> {
  const root =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const preferred = findCustomMidjourneyArray(root, ["image_urls", "imageUrls"]);
  const outputs = preferred.length
    ? preferred
    : findCustomMidjourneyArray(root, ["outputs", "images"]);
  const items = outputs.length ? outputs : customMidjourneySingleItems(root);
  return items
    .flatMap((item) => {
      if (typeof item === "string")
        return isHttpUrl(item) || item.startsWith("data:image/") ? [{ url: item }] : [];
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const url = [
        record.url,
        record.image_url,
        record.imageUrl,
        record.content_url,
        record.download_url,
      ].find(
        (candidate): candidate is string =>
          typeof candidate === "string" &&
          (isHttpUrl(candidate) || candidate.startsWith("data:image/")),
      );
      const b64 = typeof record.b64_json === "string" ? record.b64_json : undefined;
      return url || b64 ? [{ ...(url ? { url } : {}), ...(b64 ? { b64_json: b64 } : {}) }] : [];
    })
    .slice(0, 8);
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
  for (const key of [
    "grid_image_url",
    "gridImageUrl",
    "image_url",
    "imageUrl",
    "url",
    "content_url",
    "download_url",
  ]) {
    if (value[key] !== undefined) found.push(value[key]);
  }
  return found;
}

async function waitForVideo(
  connection: CustomApiConnection,
  initial: unknown,
  onProgress?: (progress: number) => void,
): Promise<{ payload: unknown; taskId: string }> {
  const protocol = normalizeProtocolOverride(connection.protocol);
  const poll = protocol?.poll;
  const customPoll = Boolean(poll);
  let current = acceptVideoPayload(initial, customPoll);
  const taskId = pollTaskId(current, poll);
  if (!taskId) throw new CustomApiError("视频任务没有返回任务编号", "VIDEO_TASK_MISSING");
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const status = pollStatus(current, poll);
    if (status === "failed") throw videoGenerationError(videoFailureInput(current, protocol));
    // Some OpenAI-compatible relays keep the completed response small and
    // expose the bytes only through /v1/videos/{task_id}/content.
    if (status === "completed") return { payload: current, taskId };
    onProgress?.(pollProgress(current, poll) ?? (status === "running" ? 48 : 18));
    await sleep(CUSTOM_VIDEO_POLL_INTERVAL_MS);
    current = acceptVideoPayload(
      await requestJson(connection, pollUrlFor(poll, taskId), poll?.method ?? "GET"),
      customPoll,
    );
  }
  throw new CustomApiError("视频生成等待超时，可稍后在任务记录中查看", "VIDEO_TIMEOUT");
}

function videoRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 自定义轮询下，上游响应可能不在内置形状里（状态是数字、任务号在别的字段）；解析
 * 失败时保留原始载荷交给点路径处理。没有自定义轮询时保持原有的严格校验。
 */
function acceptVideoPayload(value: unknown, customPoll: boolean): unknown {
  const parsed = customApiVideoResponseSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return customPoll ? value : customApiVideoResponseSchema.parse(value);
}

function readFirstPollValueAtPaths(value: unknown, paths: readonly string[]) {
  return firstEntryAtPaths(value, paths, true)?.value;
}

function pollTaskId(payload: unknown, poll: CustomApiPollOverride | undefined) {
  return readFirstPollValueAtPaths(payload, [...(poll?.taskIdPaths ?? []), "id", "task_id"]);
}

function pollUrlFor(poll: CustomApiPollOverride | undefined, taskId: string) {
  const encoded = encodeURIComponent(taskId);
  const template = poll?.urlTemplate;
  if (template) return template.replace(CUSTOM_API_POLL_TEMPLATE_TOKENS, encoded);
  return `/v1/videos/${encoded}`;
}

function pollStatus(
  payload: unknown,
  poll: CustomApiPollOverride | undefined,
): "queued" | "running" | "completed" | "failed" {
  const configured = Boolean(
    poll?.statusPaths?.length || poll?.successValues?.length || poll?.failValues?.length,
  );
  if (!configured) {
    const status = videoRecord(payload).status;
    return normalizeVideoStatus(typeof status === "string" ? status : undefined);
  }
  const raw = readFirstPollValueAtPaths(payload, [...(poll?.statusPaths ?? []), "status"]);
  if (!raw) return "queued";
  // 未命中的状态一律继续等：宁可等到超时给出明确错误，也不猜"完成"。
  return pollVerdict(raw, poll);
}

function pollProgress(payload: unknown, poll: CustomApiPollOverride | undefined) {
  const value = poll?.progressPath
    ? valueAtPath(payload, poll.progressPath)
    : videoRecord(payload).progress;
  if (typeof value !== "number") return undefined;
  return normalizedProgress(value);
}

/**
 * 视频失败时的错误输入：**只有用户显式声明了错误路径**才改道按路径取值；否则原样交给
 * `videoGenerationError` 的深搜逻辑（它会同时找 message 与 code，用于识别
 * Higgsfield 套餐限制、Cloudflare 验证这些已知形态）。内置候选表在这里不参与——它只覆盖
 * 顶层字段，用它会丢掉深层的错误码。
 */
function videoFailureInput(payload: unknown, protocol: CustomApiProtocolOverride | undefined) {
  const configured = protocol?.error?.messagePaths;
  if (configured?.length) {
    const found = firstEntryAtPaths(payload, configured);
    if (found) return found.value;
  }
  return videoRecord(payload).error;
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
  if (
    /upstream_verification_required|cloudflare|just a moment|enable javascript and cookies/i.test(
      normalized,
    )
  ) {
    return new CustomApiError(
      "Higgsfield 请求被 Cloudflare 验证拦截，请先完成会话验证后重试",
      "UPSTREAM_VERIFICATION_REQUIRED",
    );
  }
  return new CustomApiError(
    detail ? `视频生成失败：${detail}` : "视频生成失败",
    "VIDEO_GENERATION_FAILED",
  );
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

async function downloadResult(
  value: string,
  connection: CustomApiConnection,
  kind: "image" | "video" | "audio",
) {
  const origin = normalizeCustomApiBaseUrl(connection.baseUrl);
  const label = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
  const url = new URL(value);
  let response: Response;
  try {
    response = await fetch(url, {
      // 结果字节与站同源时才带凭据（含协议档案的认证样式）；外部 CDN 一律不带。
      headers:
        url.origin === origin ? customApiAuthInit(connection, url.pathname).headers : undefined,
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch {
    throw new CustomApiError(`${label}结果无法下载，请检查文件跨域设置`, "RESULT_DOWNLOAD_FAILED");
  }
  if (!response.ok)
    throw new CustomApiError(`${label}结果下载失败 (${response.status})`, "RESULT_DOWNLOAD_FAILED");
  try {
    return await response.blob();
  } catch {
    throw new CustomApiError(
      `${label}结果读取中断，请稍后从任务记录重试`,
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

/**
 * data URL → Blob，自己解码：不走 `fetch(dataUrl)`。后者在严格的 CSP
 * (`connect-src`) 下会被拦，而且把一次纯内存操作挂到了网络栈上。
 */
async function dataUrlBlob(value: string) {
  const match = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s.exec(value);
  if (!match) throw new CustomApiError("图片数据无法解码", "IMAGE_RESULT_INVALID");
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = /;base64/i.test(match[2] ?? "");
  const payload = match[3] ?? "";
  try {
    const bytes = isBase64
      ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload));
    return new Blob([bytes], { type: mimeType });
  } catch {
    throw new CustomApiError("图片数据无法解码", "IMAGE_RESULT_INVALID");
  }
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) =>
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "",
    )
    .join("");
}

function videoResultUrl(value: unknown, extraPaths: readonly string[] = []) {
  return videoResultUrlAtPath(value, extraPaths)?.value ?? null;
}

function videoResultUrlAtPath(
  value: unknown,
  extraPaths: readonly string[] = [],
): { value: string; path: string } | null {
  // 协议档案的结果点路径排在内置候选之前：用户对自己的上游响应更清楚。
  for (const path of [...extraPaths, ...CUSTOM_API_VIDEO_RESULT_PATHS]) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate === "string" && candidate.length <= 4096 && isHttpUrl(candidate))
      return { value: candidate, path };
  }
  return null;
}

/** 内置结果点路径候选表；协议档案（P0）的 resultUrlPaths 会排在这些之前。 */
const CUSTOM_API_VIDEO_RESULT_PATHS = [
  "outputs.0.content_url",
  "outputs.0.download_url",
  "outputs.0.url",
  "content_url",
  "video.url",
  "url",
  "video_url",
  "download_url",
  "output.url",
  "output.content_url",
  "result.url",
  "result.video_url",
  "result.content_url",
  "data.url",
  "data.video_url",
  "data.content_url",
  "data.video.url",
  "content.url",
  "content.video_url",
  "file.url",
] as const;

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
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.min(100, Math.round(value)));
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (
      current !== undefined &&
      (!current || typeof current !== "object" || Array.isArray(current))
    )
      throw new CustomApiError("模型参数路径冲突", "ROUTE_INVALID");
    if (current === undefined) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
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
  return mediaParameterBinding(
    parameter.name,
    parameter.path,
    parameter.format ?? parameter.itemsFormat,
  );
}

function mediaParameterBinding(name: string, path?: string, format?: string): MediaBinding | null {
  const pathBinding = mediaBindingFromName(path?.split(".").at(-1));
  if (pathBinding) return pathBinding;
  const nameBinding = mediaBindingFromName(name);
  if (nameBinding) return nameBinding;
  const formatKind = /uri/i.test(format ?? "")
    ? /(image|video|audio)/i.exec(format ?? "")?.[1]?.toLowerCase()
    : undefined;
  return formatKind ? { kind: formatKind as MediaReferenceKind, position: "reference" } : null;
}

function mediaBindingFromName(value: string | undefined): MediaBinding | null {
  if (!value) return null;
  const normalizedName = value.replaceAll("_", "").toLowerCase();
  const specialized = SPECIALIZED_IMAGE_PARAMETER_NAME.exec(normalizedName)?.[1] as
    "style" | "element" | undefined;
  if (specialized) return { kind: "image", position: specialized };
  const positioned = POSITIONED_IMAGE_PARAMETER_NAME.exec(normalizedName)?.[1];
  if (positioned)
    return {
      kind: "image",
      position: positioned === "first" || positioned === "start" ? "first" : "last",
    };
  const inputKind = INPUT_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1] as
    MediaReferenceKind | undefined;
  if (inputKind) return { kind: inputKind, position: "reference" };
  const bareKind = BARE_MEDIA_PARAMETER_NAME.exec(normalizedName)?.[1] as
    MediaReferenceKind | undefined;
  if (bareKind) return { kind: bareKind, position: "reference" };
  const referenceKind = MEDIA_REFERENCE_PARAMETER_NAME.exec(normalizedName)?.[1] as
    MediaReferenceKind | undefined;
  if (referenceKind) return { kind: referenceKind, position: "reference" };
  return null;
}

export function publicReferenceKinds(route: CustomApiRoute) {
  const kinds = new Set<MediaReferenceKind>();
  for (const parameter of route.parameters) {
    const binding = mediaParameterBindingFor(parameter);
    if (!binding) continue;
    if (
      parameter.format?.startsWith("public-http-url") ||
      parameter.itemsFormat?.startsWith("public-http-url")
    ) {
      kinds.add(binding.kind);
    }
  }
  return kinds;
}

function createKnownCustomModel(modelId: string, modality: ModelModality): PublicModel | null {
  const plan = inferKnowledgePlan(modelId);
  if (!plan || !plan.modalities.includes(modality)) return null;
  return publicModelSchema.parse({
    id: modelId,
    label: plan.label ?? modelId,
    description: plan.description,
    modality,
    operation: "generate",
    order: 0,
    input: {
      textRequired: plan.textRequired,
      ...(plan.imageInput === undefined ? {} : { images: plan.imageInput }),
    },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: plan.uiParameters,
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
  const plan = inferKnowledgePlan(modelId);
  if (!plan || !plan.modalities.includes(modality)) return null;
  return {
    sourceModelId: modelId,
    modality,
    endpointPath: plan.endpointPath,
    parameters: [
      { name: "model", path: "model", type: "string", fixed: modelId },
      ...plan.wireParameters,
    ],
  };
}

function isKnownGrokVideoModel(modelId: string) {
  return isGrokImagineVideoModel(modelId);
}

function assertInputCounts(model: PublicModel, inputs: GenerationJobInput) {
  const images = inputs.images ?? [];
  const styleImages = inputs.styleImages ?? [];
  const elementImages = inputs.elementImages ?? [];
  const videos = inputs.videos ?? [];
  const audios = inputs.audios ?? [];
  const referenceMedia = model.input.referenceMedia;
  const hasDeclaredImagePurpose =
    referenceMedia?.images !== undefined ||
    referenceMedia?.styleImages !== undefined ||
    referenceMedia?.elementImages !== undefined;
  const entries = [
    [
      "图片",
      images,
      referenceMedia?.images ?? (hasDeclaredImagePurpose ? undefined : model.input.images),
      32,
    ],
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
        ? (capability.max ?? requestLimit)
        : Math.min(1, capability.max ?? 1);
    const max = Math.min(capabilityMax, requestLimit);
    if (values.length < min)
      throw new CustomApiError(`当前模型至少需要 ${min} 个${label}参考`, "REFERENCE_REQUIRED");
    if (values.length > max)
      throw new CustomApiError(`当前模型最多支持 ${max} 个${label}参考`, "TOO_MANY_REFERENCES");
  }
  const total =
    images.length + styleImages.length + elementImages.length + videos.length + audios.length;
  if (referenceMedia?.maxTotalItems !== undefined && total > referenceMedia.maxTotalItems) {
    throw new CustomApiError(
      `当前模型合计最多支持 ${referenceMedia.maxTotalItems} 个参考素材`,
      "TOO_MANY_REFERENCES",
    );
  }
}

function assertKnownModelConstraints(
  route: CustomApiRoute,
  payload: Record<string, unknown>,
  inputs: GenerationJobInput,
) {
  if (!isKnownGrokVideoModel(route.sourceModelId)) return;
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) throw new CustomApiError("Grok 视频模型需要非空提示词", "PROMPT_REQUIRED");
  if (route.sourceModelId !== GROK_IMAGINE_VIDEO_MODEL_ID || inputs.images.length < 2) return;
  const seconds = Number(payload.duration_seconds ?? 6);
  if (Number.isFinite(seconds) && seconds > 10) {
    throw new CustomApiError("Grok 多参考图模式最长支持 10 秒", "DURATION_OUT_OF_RANGE");
  }
}

/**
 * 协议自检（P3）：拿一段真实的上游响应，告诉你"按当前协议档案会解析出什么"——
 * 任务号、状态判定、进度、结果 URL，并指出各自命中的点路径。纯本地计算，不发请求、
 * 不产生任何费用；用户对着真实响应调点路径靠它。
 */
export type CustomApiProtocolProbe = {
  taskId: { value: string; path: string } | null;
  status: {
    raw: string;
    path: string;
    verdict: "queued" | "running" | "completed" | "failed";
  } | null;
  progress: { value: number; path: string } | null;
  resultUrl: { value: string; path: string } | null;
  errorMessage: { value: string; path: string } | null;
  errorCode: { value: string; path: string } | null;
};

export function probeCustomApiResponse(
  rawJson: string,
  protocol: unknown,
): { ok: true; probe: CustomApiProtocolProbe } | { ok: false; message: string } {
  const trimmed = rawJson.trim();
  if (!trimmed) return { ok: false, message: "先粘贴一段上游返回的 JSON" };
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "这段内容不是合法 JSON" };
  }
  const override = normalizeProtocolOverride(protocol);
  const poll = override?.poll;

  const taskIdEntry = firstEntryAtPaths(
    parsedValue,
    [...(poll?.taskIdPaths ?? []), "id", "task_id"],
    true,
  );
  const statusEntry = firstEntryAtPaths(
    parsedValue,
    [...(poll?.statusPaths ?? []), "status"],
    true,
  );
  const progressPath = poll?.progressPath ?? "progress";
  const progressValue = valueAtPath(parsedValue, progressPath);
  const resultEntry = videoResultUrlAtPath(parsedValue, override?.resultUrlPaths);

  return {
    ok: true,
    probe: {
      taskId: taskIdEntry,
      status: statusEntry
        ? {
            raw: statusEntry.value,
            path: statusEntry.path,
            verdict: pollVerdict(statusEntry.value, poll),
          }
        : null,
      progress:
        typeof progressValue === "number" && Number.isFinite(progressValue)
          ? { value: progressValue, path: progressPath }
          : null,
      resultUrl: resultEntry,
      errorMessage: errorMessageAtPaths(parsedValue, override),
      errorCode: errorCodeAtPaths(parsedValue, override),
    },
  };
}

function firstEntryAtPaths(
  value: unknown,
  paths: readonly string[],
  allowNumber = false,
): { value: string; path: string } | null {
  for (const path of paths) {
    const found = valueAtPath(value, path);
    if (typeof found === "string" && found.trim()) return { value: found.trim(), path };
    // Protocol profiles may name numeric task IDs or status codes. Do not coerce
    // objects, booleans, or non-finite numbers into a pollable value.
    if (allowNumber && typeof found === "number" && Number.isFinite(found))
      return { value: String(found), path };
  }
  return null;
}

function pollVerdict(
  raw: string,
  poll: CustomApiPollOverride | undefined,
): "queued" | "running" | "completed" | "failed" {
  const configured = Boolean(poll?.successValues?.length || poll?.failValues?.length);
  const value = raw.toLowerCase();
  if (configured) {
    if ((poll?.successValues ?? []).some((candidate) => candidate.toLowerCase() === value))
      return "completed";
    if ((poll?.failValues ?? []).some((candidate) => candidate.toLowerCase() === value))
      return "failed";
    return "running";
  }
  return normalizeVideoStatus(raw);
}

/**
 * 测试请求（P3）：向上游发一条**真实的、极便宜的文本请求**，验证认证方式、提交端点与
 * 请求体编码整条链路。图片/视频不在这里发——那些会产生真实费用，作者用「解析自检」
 * 对着已有响应调点路径即可。请求由浏览器直发，Key 不出本机（与 BYOK 的既有约定一致）。
 */
export async function sendCustomApiTestRequest(
  connection: CustomApiConnection,
  modelId: string,
): Promise<{ path: string; contentType: CustomApiRequestContentType; response: unknown }> {
  const target = modelId.trim();
  if (!target) throw new CustomApiError("先填一个用于测试的模型 id", "MODEL_REQUIRED");
  const path =
    protocolEndpoint(connection, "text", "/v1/chat/completions") ?? "/v1/chat/completions";
  const contentType = protocolContentType(connection);
  const response = await requestJson(
    connection,
    path,
    "POST",
    {
      model: target,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    },
    60_000,
  );
  return { path, contentType, response };
}

/** 内置错误提取候选：覆盖 OpenAI 形状与国内外中转站最常见的几种字段名。 */
const CUSTOM_API_ERROR_MESSAGE_PATHS = [
  "error.message",
  "message",
  "msg",
  "error_msg",
  "detail",
  "error",
] as const;
const CUSTOM_API_ERROR_CODE_PATHS = ["error.code", "code", "error_code", "status_code"] as const;

function errorMessageAtPaths(value: unknown, protocol: CustomApiProtocolOverride | undefined) {
  return (
    firstEntryAtPaths(value, [
      ...(protocol?.error?.messagePaths ?? []),
      ...CUSTOM_API_ERROR_MESSAGE_PATHS,
    ]) ?? null
  );
}

function errorCodeAtPaths(value: unknown, protocol: CustomApiProtocolOverride | undefined) {
  // 错误码常常是数字（`{"code": 4001}`），所以这里比消息宽松：接受字符串与数字。
  return (
    firstScalarAtPaths(value, [
      ...(protocol?.error?.codePaths ?? []),
      ...CUSTOM_API_ERROR_CODE_PATHS,
    ]) ?? null
  );
}

function firstScalarAtPaths(
  value: unknown,
  paths: readonly string[],
): { value: string; path: string } | null {
  for (const path of paths) {
    const found = valueAtPath(value, path);
    if (typeof found === "string" && found.trim()) return { value: found.trim(), path };
    if (typeof found === "number" && Number.isFinite(found)) return { value: String(found), path };
  }
  return null;
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
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  return known[mimeType.toLowerCase()] ?? fallback;
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}
