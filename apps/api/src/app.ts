import { type Context, Hono } from "hono";
import { ZodError } from "zod";

import { AgentServiceError } from "./agent/service.js";
import type { AgentConnectorGateway } from "./agent/connector-gateway.js";
import type { ExternalConnectorService } from "./connectors/external-connector-service.js";
import type { CanvasCommandBroker } from "./connectors/canvas-command-broker.js";
import { CatalogUnavailableError, WeftcanvasCatalogAdapter } from "./catalog/adapter.js";
import { type ModelOverrideStore } from "./catalog/overrides.js";
import type { AnnouncementStore } from "./announcements/store.js";
import { GenerationQuoteService, QuoteValidationError } from "./catalog/quote.js";
import type { ModelHealthProvider } from "./catalog/model-health.js";
import type { CanvasOpsService } from "./ops/service.js";
import type { ApiReadinessProbe } from "./database/readiness.js";
import { IdentityProviderError, type IdentityProvider } from "./identity/provider.js";
import { GenerationApiGuard, GenerationApiLimitError } from "./generation/api-rate-limit.js";
import { GenerationJobServiceError } from "./generation/service.js";
import { MediaService, MediaServiceError } from "./media/service.js";
import type { CloudResourceService } from "./media/cloud-resource-service.js";
import type { MediaMultipartService } from "./media/multipart-service.js";
import { SignedMediaAccess } from "./media/signed-access.js";
import {
  clientIdentifierFromRequest,
  DEFAULT_TRUSTED_PROXY_SPEC,
  TrustedProxyList,
} from "./identity/client-address.js";
import { type CanvasImportConfig } from "./canvas-import/service.js";
import type { AgentSkillStore } from "./skills/store.js";
import { type ApiErrorStatus, errorResponse } from "./http/errors.js";
import { registerMusicRoutes } from "./media/music-routes.js";
import { registerCanvasImportRoutes } from "./canvas-import/routes.js";
import { registerOperatorRoutes } from "./admin/operator-routes.js";
import { registerGenerationRoutes } from "./generation/routes.js";
import type { GenerationApi } from "./generation/api.js";
import { registerAccountDomainRoutes } from "./identity/account-routes.js";
import { AnonymousAgentGuard, SensitiveActionGuard } from "./http/rate-limit.js";
import {
  clearIdentityCookie,
  refreshIdentityCookieFromError,
  setIdentityCookie,
} from "./identity/http-session.js";
import { CloudProjectServiceError } from "./project/service.js";
import { CollaborationServiceError } from "./project/collaboration-service.js";
import type { ProjectApi, CollaborationApi } from "./project/api.js";
import { registerProjectRoutes } from "./project/routes.js";
import type { CloudProjectEntitlementResolver } from "./project/types.js";
import {
  WalletProviderError,
  type MembershipTaskProvider,
  type WalletProvider,
} from "./wallet/provider.js";
import type { AccountRouteRegistrar } from "./account-routes/contract.js";
import type { AgentApi } from "./agent/api.js";
import { registerAgentSkillRoutes } from "./agent/skills-routes.js";
import { registerAgentConversationRoutes } from "./agent/conversation-routes.js";
import { registerAgentConnectorRoutes } from "./agent/connector-routes.js";
import { registerConnectorRoutes } from "./connectors/routes.js";
import { registerMediaUploadRoutes } from "./media/upload-routes.js";
import { registerMediaContentRoutes } from "./media/content-routes.js";
import { registerMediaLibraryRoutes } from "./media/library-routes.js";

export type { AgentApi };

type ApiDependencies = {
  agent?: AgentApi;
  /** 浏览器 ↔ 本机 Agent 运行时的连接器/画布通道代理（本机运行时存在时使用）。 */
  connectors?: AgentConnectorGateway;
  /**
   * 用户侧反向连接：用户的 Blender/Codex 主动连到本 API 领取任务并回传结果。
   * 托管站点上这是唯一可行的方向——服务器上没有、也不该有用户的 Blender/Codex。
   */
  externalConnectors?: ExternalConnectorService;
  /** 外部连接（Codex MCP）下发的画布指令队列；由浏览器轮询执行。 */
  canvasCommands?: CanvasCommandBroker;
  /**
   * Agent 运行时的共享令牌：运行时通过它调用 `/internal/v1/*` 派发任务。
   * 与 AGENT_RUNTIME_URL/TOKEN 是同一对凭据，方向相反。
   */
  internalRuntimeToken?: string;
  anonymousAgent?: AgentApi;
  anonymousAgentCookie?: {
    name: string;
    secure: boolean;
  };
  anonymousAgentLimits?: {
    conversationsPerMinute: number;
    submissionsPerMinute: number;
    submissionsPerDay: number;
    readsPerMinute?: number;
    globalConversationsPerMinute?: number;
    globalSubmissionsPerMinute?: number;
    globalSubmissionsPerDay?: number;
    globalReadsPerMinute?: number;
    now?: () => number;
  };
  /**
   * 第三方画布导入（LibTV / TapNow / UpDream）的来源配置。缺省时 LibTV 如实报
   * 不可用，TapNow/UpDream 是公开分享链接、不需要密钥。
   */
  canvasImport?: CanvasImportConfig;
  /**
   * 用户自导入 Agent 技能的文件存储。缺省时 /api/v1/agent/skills 整个面 404
   *（与 announcements / modelOverrides 同款）；注入后只服务调用者本人。
   */
  agentSkills?: AgentSkillStore;
  catalog: Pick<WeftcanvasCatalogAdapter, "getCatalog">;
  /** 账号侧内容库（收藏卡片/社区）的路由挂载器：私有 overlay 提供；开源构建缺省不挂载。 */
  registerAccountRoutes?: AccountRouteRegistrar;
  quotes: Pick<GenerationQuoteService, "createQuote">;
  identity?: IdentityProvider;
  identityCookie?: {
    name: string;
    secure: boolean;
  };
  allowedOrigins?: readonly string[];
  /**
   * 可信代理列表（IP / CIDR，逗号或空格分隔；`loopback` 表示回环）。
   * 只有直连对端落在这个列表里时，限流才会读 `X-Forwarded-For` / `CF-Connecting-IP`；
   * 直连访问一律用 socket 上的真实对端地址。缺省只信回环（同机反向代理）；
   * 容器内或 Cloudflare 前置部署按部署形态显式配置。
   */
  trustedProxySpec?: string;
  media?: MediaService;
  cloudResources?: CloudResourceService;
  /** 模型成功率聚合（来自真实生成任务）；缺省则目录不带 health。 */
  modelHealth?: ModelHealthProvider;
  /** 画布运营后台（只读监控）；缺 secret 时整个面不可见。 */
  ops?: CanvasOpsService;
  opsAdminSecret?: string;
  multipartMedia?: Pick<
    MediaMultipartService,
    "createUpload" | "signParts" | "getState" | "complete" | "abort"
  >;
  entitlements?: CloudProjectEntitlementResolver;
  projects?: ProjectApi;
  collaboration?: CollaborationApi;
  signedMedia?: Pick<SignedMediaAccess, "verify" | "createUrl">;
  generation?: GenerationApi;
  generationGuard?: Pick<GenerationApiGuard, "checkSubmission" | "checkRead" | "acquireStream">;
  generationUnavailableMessage?: string;
  generationStream?: {
    pollIntervalMs: number;
    heartbeatMs: number;
    maxDurationMs: number;
    now?: () => number;
  };
  readiness?: ApiReadinessProbe;
  wallet?: WalletProvider;
  membershipTasks?: MembershipTaskProvider;
  /** 每日存储清扫（systemd timer 经本机调用）：执行到期宽限配额。 */
  storageSweep?: {
    sweep(now?: number): Promise<{
      scanned: number;
      enforced: number;
      evicted: number;
      failures: Array<{ ownerId: string; error: string }>;
    }>;
  };
  storageSweepSecret?: string;
  /**
   * Operator override store for the published catalog (hide a model, set its
   * retail price). When absent, the admin endpoints 404 and the catalog is
   * served exactly as upstream publishes it.
   */
  modelOverrides?: ModelOverrideStore;
  modelOverridesAdminSecret?: string;
  /**
   * 站点公告存储（文件优先）。公开读接口匿名可用；写入走运营密钥，
   * 缺省沿用后台那把（`announcementsAdminSecret`），没配就没有管理面。
   */
  announcements?: AnnouncementStore;
  announcementsAdminSecret?: string;
};

const DEFAULT_IDENTITY_COOKIE = { name: "weftcanvas_session", secure: false } as const;

export function createApiApp(dependencies: ApiDependencies) {
  const app = new Hono();
  const identityCookie = dependencies.identityCookie ?? DEFAULT_IDENTITY_COOKIE;
  const anonymousAgentGuard = new AnonymousAgentGuard(dependencies.anonymousAgentLimits);
  const sensitiveActionGuard = new SensitiveActionGuard();
  const trustedProxies = new TrustedProxyList(
    dependencies.trustedProxySpec?.trim() || DEFAULT_TRUSTED_PROXY_SPEC,
  );
  // 限流用的客户端标识：仅当直连对端本身是可信代理时才读转发头。
  const clientIdentifier = (context: Context) =>
    clientIdentifierFromRequest({
      remoteAddress: remoteAddressOf(context),
      headers: context.req.raw.headers,
      trusted: trustedProxies,
    });

  // 运营控制台会把模型覆盖管理页嵌进 iframe。一刀切 X-Frame-Options: DENY 会让
  // 那个页渲染空白且无报错，所以这一条路径豁免，并改用 CSP frame-ancestors 钉死：
  // 只有环境变量点名的控制台来源可以 frame 它（部署侧配置，代码不含默认来源）。
  const MODEL_OVERRIDES_FRAME_ANCESTORS = (process.env.MODEL_OVERRIDES_FRAME_ANCESTORS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use("*", async (context, next) => {
    await next();
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    if (new URL(context.req.url).pathname === "/admin/model-overrides") {
      context.header(
        "Content-Security-Policy",
        `frame-ancestors ${MODEL_OVERRIDES_FRAME_ANCESTORS.join(" ")}`,
      );
    } else {
      context.header("X-Frame-Options", "DENY");
    }
    context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  app.use("/api/v1/auth/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  });
  app.use("/api/v1/wallet", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
  });
  app.use("/api/v1/wallet/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
  });
  app.use("/api/v1/cloud-projects", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
  });
  app.use("/api/v1/cloud-projects/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
  });
  app.use("/api/v1/cloud-project-invitations", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
  });
  app.use("/api/v1/cloud-project-invitations/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "private, no-store");
  });

  registerMusicRoutes(app, { identity: dependencies.identity, identityCookie });
  registerAccountDomainRoutes(app, {
    identity: dependencies.identity,
    wallet: dependencies.wallet,
    membershipTasks: dependencies.membershipTasks,
    allowedOrigins: dependencies.allowedOrigins,
    identityCookie,
    sensitiveActionGuard,
    clientIdentifier,
  });
  registerCanvasImportRoutes(app, {
    identity: dependencies.identity,
    identityCookie,
    canvasImport: dependencies.canvasImport,
  });

  registerOperatorRoutes(app, {
    catalogAdapter: dependencies.catalog,
    modelOverrides: dependencies.modelOverrides,
    modelOverridesAdminSecret: dependencies.modelOverridesAdminSecret,
    modelHealth: dependencies.modelHealth,
    announcements: dependencies.announcements,
    announcementsAdminSecret: dependencies.announcementsAdminSecret,
    ops: dependencies.ops,
    opsAdminSecret: dependencies.opsAdminSecret,
  });

  registerGenerationRoutes(app, {
    quotes: dependencies.quotes,
    generation: dependencies.generation,
    generationUnavailableMessage: dependencies.generationUnavailableMessage,
    generationGuard: dependencies.generationGuard,
    generationStream: dependencies.generationStream,
    allowedOrigins: dependencies.allowedOrigins,
    identity: dependencies.identity,
    identityCookie,
    storageSweep: dependencies.storageSweep,
    storageSweepSecret: dependencies.storageSweepSecret,
  });

  registerProjectRoutes(app, {
    projects: dependencies.projects,
    collaboration: dependencies.collaboration,
    cloudResources: dependencies.cloudResources,
    allowedOrigins: dependencies.allowedOrigins,
    identity: dependencies.identity,
    identityCookie,
  });

  registerAgentSkillRoutes(app, {
    agentSkills: dependencies.agentSkills,
    allowedOrigins: dependencies.allowedOrigins,
    identity: dependencies.identity,
    identityCookie,
  });

  registerAgentConversationRoutes(app, {
    agent: dependencies.agent,
    anonymousAgent: dependencies.anonymousAgent,
    identity: dependencies.identity,
    allowedOrigins: dependencies.allowedOrigins,
    identityCookie,
    anonymousAgentGuard,
  });

  registerAgentConnectorRoutes(app, {
    connectors: dependencies.connectors,
    canvasCommands: dependencies.canvasCommands,
    allowedOrigins: dependencies.allowedOrigins,
    identity: dependencies.identity,
    identityCookie,
  });

  registerConnectorRoutes(app, {
    externalConnectors: dependencies.externalConnectors,
    canvasCommands: dependencies.canvasCommands,
    internalRuntimeToken: dependencies.internalRuntimeToken,
    allowedOrigins: dependencies.allowedOrigins,
    identity: dependencies.identity,
    identityCookie,
  });

  registerMediaUploadRoutes(app, {
    media: dependencies.media,
    multipartMedia: dependencies.multipartMedia,
    generation: dependencies.generation,
    entitlements: dependencies.entitlements,
    projects: dependencies.projects,
    allowedOrigins: dependencies.allowedOrigins,
    identity: dependencies.identity,
    identityCookie,
  });

  registerMediaContentRoutes(app, {
    media: dependencies.media,
    signedMedia: dependencies.signedMedia,
    generation: dependencies.generation,
    entitlements: dependencies.entitlements,
    projects: dependencies.projects,
    allowedOrigins: dependencies.allowedOrigins,
    identity: dependencies.identity,
    identityCookie,
  });

  registerMediaLibraryRoutes(app, {
    media: dependencies.media,
    signedMedia: dependencies.signedMedia,
    cloudResources: dependencies.cloudResources,
    generation: dependencies.generation,
    entitlements: dependencies.entitlements,
    projects: dependencies.projects,
    allowedOrigins: dependencies.allowedOrigins,
    identity: dependencies.identity,
    identityCookie,
  });

  app.get("/api/health", async (context) => {
    context.header("Cache-Control", "no-store");
    // 目录新鲜度决定「能不能报价、能不能提交」：一旦过期或报价不可用，前端会直接
    // 禁用提交按钮，而服务本身仍然健康。生产已出现过这种静默失效（刷新卡死 → 目录
    // TTL 到期 → 用户无法提交，直到有人反馈才发现），所以把这两个信号放进健康响应，
    // 让看门狗/拨测能据此告警。取快照是非阻塞的：需要刷新时也只是后台触发。
    const catalog = await dependencies.catalog
      .getCatalog({ includeOverrides: false })
      .catch(() => null);
    return context.json({
      ok: true,
      service: "canvas-api",
      ...(catalog
        ? {
            catalog: {
              version: catalog.version,
              quoteAvailable: catalog.quoteAvailable,
              expiresAt: catalog.expiresAt,
            },
          }
        : {}),
    });
  });

  app.get("/api/ready", async (context) => {
    context.header("Cache-Control", "no-store");
    try {
      if (!dependencies.readiness || (await dependencies.readiness.check())) {
        return context.json({ ok: true, service: "canvas-api" });
      }
    } catch {
      // Readiness is intentionally fail-closed and does not expose dependency details.
    }
    return errorResponse(context, 503, "SERVICE_NOT_READY", "Service is not ready");
  });

  // 账号侧内容库（收藏卡片/公开社区流）的路由由私有 overlay 注入；
  // 开源构建缺省不挂载，这些端点整体不存在（不是"存在但 503"）。
  dependencies.registerAccountRoutes?.(app, {
    identity: dependencies.identity,
    identityCookie,
  });

  app.notFound((context) => errorResponse(context, 404, "NOT_FOUND", "没有找到这个接口"));

  app.onError((error, context) => {
    if (error instanceof CollaborationServiceError) {
      return errorResponse(context, error.status, error.code, error.message);
    }
    if (error instanceof CloudProjectServiceError) {
      if (error.currentRevision !== null)
        context.header("X-Canvas-Current-Revision", String(error.currentRevision));
      return errorResponse(context, error.status, error.code, error.message);
    }
    if (error instanceof AgentServiceError) {
      // 余额不足按 402 返回，前端据此提示"积分不足，请充值后重试"。
      const status: ApiErrorStatus =
        error.code === "INSUFFICIENT_CREDITS"
          ? 402
          : error.code === "PROJECT_CONTEXT_MISMATCH"
            ? 409
            : error.code === "PROJECT_CONTEXT_STALE" ||
                error.code === "PROPOSAL_NOT_AVAILABLE" ||
                error.code === "RUN_STATE_CONFLICT"
              ? 409
              : error.code === "EXECUTION_RECEIPT_INVALID"
                ? 422
                : error.code === "MODEL_NOT_AVAILABLE"
                  ? 422
                  : error.code === "MODEL_CATALOG_UNAVAILABLE" || error.code === "AGENT_UNAVAILABLE"
                    ? 503
                    : 404;
      return errorResponse(context, status, error.code, error.message);
    }
    if (error instanceof MediaServiceError) {
      refreshIdentityCookieFromError(context, identityCookie, error);
      if (error.status === 401 || error.code === "UNAUTHENTICATED")
        clearIdentityCookie(context, identityCookie);
      return errorResponse(context, error.status, error.code, error.message);
    }
    if (error instanceof GenerationApiLimitError) {
      context.header("Retry-After", String(error.retryAfterSeconds));
      return errorResponse(context, 429, error.code, error.message);
    }
    if (error instanceof GenerationJobServiceError) {
      const status = generationErrorStatus(error.code);
      refreshIdentityCookieFromError(context, identityCookie, error);
      if (status === 401 || error.code === "UNAUTHENTICATED")
        clearIdentityCookie(context, identityCookie);
      return errorResponse(context, status, error.code, error.message);
    }
    if (error instanceof IdentityProviderError) {
      if (error.retryAfterSeconds !== null)
        context.header("Retry-After", String(error.retryAfterSeconds));
      return errorResponse(context, error.status, error.code, error.message);
    }
    if (error instanceof WalletProviderError) {
      if (error.retryAfterSeconds !== null)
        context.header("Retry-After", String(error.retryAfterSeconds));
      if (error.refreshedToken && error.expiresAt && error.status !== 401) {
        setIdentityCookie(context, identityCookie, {
          token: error.refreshedToken,
          expiresAt: error.expiresAt,
        });
      }
      if (error.status === 401) clearIdentityCookie(context, identityCookie);
      return errorResponse(context, error.status, error.code, error.message);
    }
    if (error instanceof QuoteValidationError)
      return errorResponse(context, 422, error.code, error.message);
    if (error instanceof CatalogUnavailableError)
      return errorResponse(context, 503, error.code, error.message);
    if (error instanceof ZodError)
      return errorResponse(context, 400, "INVALID_REQUEST", "请求参数不完整或格式不正确");
    const hostedError = hostedGenerationError(error);
    if (hostedError) {
      refreshIdentityCookieFromError(context, identityCookie, error);
      if (hostedError.status === 401) clearIdentityCookie(context, identityCookie);
      return errorResponse(context, hostedError.status, hostedError.code, hostedError.message);
    }
    console.error("Canvas API request failed", error);
    return errorResponse(context, 500, "INTERNAL_ERROR", "服务暂时无法处理请求，请稍后重试");
  });

  return app;
}

function generationErrorStatus(code: string): ApiErrorStatus {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "GENERATION_RATE_LIMITED") return 429;
  if (code === "JOB_NOT_FOUND" || code === "REFERENCE_NOT_FOUND") return 404;
  if (code === "INSUFFICIENT_CREDITS") return 402;
  if (["QUOTE_CHANGED", "ACTIVE_JOB_LIMIT", "JOB_CONFLICT"].includes(code)) return 409;
  if (
    [
      "MODEL_CATALOG_UNAVAILABLE",
      "REFERENCE_VALIDATION_UNAVAILABLE",
      "GENERATION_PROVIDER_UNAVAILABLE",
      "GENERATION_INVALID_RESPONSE",
      "RESULT_DOWNLOAD_FAILED",
      "RESULT_DOWNLOAD_UNAVAILABLE",
    ].includes(code)
  )
    return 503;
  return 422;
}

/**
 * 登录/注册入参由 contracts 的 schema 把关（邮箱必须是邮箱格式、注册密码至少 10 位）。
 * 让 ZodError 落到全局分支只会得到「请求参数不完整或格式不正确」，用户无从知道该改哪一项：
 * 真实反馈里有人把手机号填进邮箱框，然后在登录与注册之间反复重试。这里按字段给出可执行提示。
 * 只认凭据字段；其余（例如上游返回体形状不符）仍交给全局分支，不误报成用户输入问题。
 */

/** 取客户端标识：按部署的代理链依次看 CF / XFF / X-Real-IP，全部缺失时回落 anonymous。 */
/** socket 上的直连对端地址；没有 socket 的运行环境（测试直调 app.request）返回 undefined。 */
function remoteAddressOf(context: Context): string | undefined {
  const env = context.env as unknown as
    { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function hostedGenerationError(
  error: unknown,
): { status: ApiErrorStatus; code: string; message: string } | null {
  if (!(error instanceof Error) || error.name !== "PromptHubRequestError") return null;
  const value = error as Error & { code?: unknown };
  if (typeof value.code !== "string" || !value.code.trim()) return null;
  const code = value.code.trim().slice(0, 80);
  const status: ApiErrorStatus =
    code === "UNAUTHENTICATED"
      ? 401
      : code === "GENERATION_RATE_LIMITED"
        ? 429
        : code === "INSUFFICIENT_CREDITS"
          ? 402
          : code === "GENERATION_PROVIDER_UNAVAILABLE" || code === "GENERATION_INVALID_RESPONSE"
            ? 503
            : 422;
  return { status, code, message: error.message.slice(0, 240) || "生成请求没有完成" };
}

// 既有导入路径保持不变：身份会话的 HTTP 门仍然从 app.ts 可用。
export { refreshIdentityCookie, requireIdentitySession } from "./identity/http-session.js";
