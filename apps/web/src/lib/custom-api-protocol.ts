import type { ModelModality } from "@weftcanvas/contracts";

/**
 * 协议档案层（从 `custom-api.ts` 抽出，纯搬移）：用户声明的"OpenAI 兼容但字段名/
 * 端点/认证方式不同"的上游如何解析。这里只有**声明式**数据——点路径、端点路径、
 * 认证样式与状态字面量——不接受脚本，也不做任何网络访问。
 *
 * 边界：本模块不反向导入 `custom-api.ts`。连接形状（`CustomApiConnection`）、
 * 请求装配与执行都留在调用方，保证依赖单向。
 */
export const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

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
export const CUSTOM_API_POLL_TEMPLATE_TOKENS = /\{(?:task_id|id)\}/g;

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
  const paths = values
    .filter((path): path is string => typeof path === "string")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .filter(isSafeResultPath);
  return [...new Set(paths)].slice(0, limit);
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
