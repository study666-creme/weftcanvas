import {
  announcementListResponseSchema,
  cloudProjectDeleteResponseSchema,
  cloudProjectPrincipalIdSchema,
  cloudProjectInvitationListResponseSchema,
  cloudProjectInvitationResponseSchema,
  cloudProjectListResponseSchema,
  cloudProjectMemberListResponseSchema,
  cloudProjectMemberResponseSchema,
  cloudProjectResponseSchema,
  cloudResourceCleanupRequestSchema,
  cloudResourceCleanupResponseSchema,
  cloudResourceListResponseSchema,
  agentConnectorIdSchema,
  agentConnectorListResponseSchema,
  agentConnectorResponseSchema,
  agentConnectorUpdateRequestSchema,
  canvasControlPendingRequestSchema,
  canvasControlPendingResponseSchema,
  canvasControlReceiptRequestSchema,
  canvasControlReceiptResponseSchema,
  connectorClientListResponseSchema,
  connectorPairingResponseSchema,
  agentConnectorIds,
  externalPollRequestSchema,
  externalPollResponseSchema,
  externalTaskResultRequestSchema,
  externalTaskResultResponseSchema,
  externalTaskRunRequestSchema,
  externalTaskRunResponseSchema,
  agentConversationDetailResponseSchema,
  agentConversationListResponseSchema,
  agentConversationResponseSchema,
  agentModelCatalogResponseSchema,
  agentSkillDeleteResponseSchema,
  agentSkillImportRequestSchema,
  agentSkillListResponseSchema,
  agentSkillResponseSchema,
  generationJobEventSchema,
  generationJobListResponseSchema,
  generationJobReconcileQuerySchema,
  generationJobResponseSchema,
  generationQuoteResponseSchema,
  mediaResponseSchema,
  mediaKindSchema,
  MEDIA_MULTIPART_THRESHOLD,
  mediaMultipartAbortRequestSchema,
  mediaMultipartAbortResponseSchema,
  mediaMultipartCompleteRequestSchema,
  mediaMultipartCompleteResponseSchema,
  mediaMultipartPartSignRequestSchema,
  mediaMultipartPartInstructionsResponseSchema,
  mediaMultipartUploadStateResponseSchema,
  mediaProjectIdSchema,
  mediaUploadIntentSchema,
  mediaUploadIntentResponseSchema,
  mediaUploadRequestSchema,
  providerMediaReferenceRequestSchema,
  providerMediaReferenceResponseSchema,
  modelCatalogResponseSchema,
  modelModalitySchema,
  type GenerationJobStatus,
  type MediaUploadIntent,
  type PublicGenerationJob,
  type PublicModel,
  type PublicModelCatalog,
} from "@weftcanvas/contracts";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { z, ZodError } from "zod";

import { AgentService, AgentServiceError, AgentExecutionError } from "./agent/service.js";
import type { AgentConnectorGateway } from "./agent/connector-gateway.js";
import type { ExternalConnectorService } from "./connectors/external-connector-service.js";
import type { CanvasCommandBroker } from "./connectors/canvas-command-broker.js";
import { handleCodexMcpMessage } from "./connectors/codex-mcp.js";
import { CatalogUnavailableError, WeftcanvasCatalogAdapter } from "./catalog/adapter.js";
import {
  modelOverridesSchema,
  type ModelOverrideStore,
  type ModelOverrides,
} from "./catalog/overrides.js";
import {
  EMPTY_ANNOUNCEMENTS,
  announcementCollectionSchema,
  publicAnnouncements,
  type AnnouncementStore,
} from "./announcements/store.js";
import { toPublicCatalogView } from "./catalog/public-view.js";
import { GenerationQuoteService, QuoteValidationError } from "./catalog/quote.js";
import type { ModelHealth, ModelHealthProvider } from "./catalog/model-health.js";
import { CANVAS_OPS_ADMIN_PAGE } from "./ops/admin-page.js";
import { ADMIN_THEME_BOOT_JS, ADMIN_THEME_CSS } from "./ops/admin-theme.js";
import type { CanvasOpsService } from "./ops/service.js";
import type { ApiReadinessProbe } from "./database/readiness.js";
import { IdentityProviderError, type IdentityProvider } from "./identity/provider.js";
import { GenerationApiGuard, GenerationApiLimitError } from "./generation/api-rate-limit.js";
import { GenerationJobServiceError } from "./generation/service.js";
import type { HostedGenerationResult } from "./generation/hosted-result.js";
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
import { AgentSkillStoreError, type AgentSkillStore } from "./skills/store.js";
import { optionalQueryInteger, type ApiErrorStatus, errorResponse } from "./http/errors.js";
import { registerMusicRoutes } from "./media/music-routes.js";
import { registerCanvasImportRoutes } from "./canvas-import/routes.js";
import { readJsonBody } from "./http/json-body.js";
import { isTrustedBrowserRequest } from "./http/browser-request.js";
import { registerAccountDomainRoutes } from "./identity/account-routes.js";
import {
  AnonymousAgentGuard,
  SensitiveActionGuard,
  anonymousAgentRateLimited,
} from "./http/rate-limit.js";
import {
  authenticateIdentity,
  clearIdentityCookie,
  identityUnavailable,
  refreshIdentityCookie,
  refreshIdentityCookieFromError,
  requireIdentitySession,
  setIdentityCookie,
} from "./identity/http-session.js";
import { CloudProjectService, CloudProjectServiceError } from "./project/service.js";
import {
  CollaborationServiceError,
  CloudProjectCollaborationService,
} from "./project/collaboration-service.js";
import type { CloudProjectEntitlementResolver } from "./project/types.js";
import {
  WalletProviderError,
  type MembershipTaskProvider,
  type WalletProvider,
} from "./wallet/provider.js";
import type { AccountRouteRegistrar } from "./account-routes/contract.js";

export type AgentApi = Pick<
  AgentService,
  | "createConversation"
  | "listConversations"
  | "getDetail"
  | "getModels"
  | "submitMessage"
  | "cancelRun"
  | "confirmProposal"
  | "dismissProposal"
  | "recordReceipt"
>;

type GenerationApi = {
  submit(
    ownerId: string,
    value: unknown,
    token?: string,
  ): Promise<PublicGenerationJob | HostedGenerationResult<PublicGenerationJob>>;
  get(
    ownerId: string,
    jobId: string,
    token?: string,
  ): Promise<PublicGenerationJob | HostedGenerationResult<PublicGenerationJob>>;
  list(
    ownerId: string,
    value: { projectId?: string; limit?: number },
    token?: string,
  ): Promise<PublicGenerationJob[] | HostedGenerationResult<PublicGenerationJob[]>>;
  /** Resolve one durable request by its existing idempotency identity (read-only). */
  resolveByIdempotency?(
    ownerId: string,
    key: string,
    token?: string,
  ): Promise<PublicGenerationJob | HostedGenerationResult<PublicGenerationJob> | null>;
  openMedia?(
    ownerId: string,
    mediaId: string,
    token?: string,
    range?: string,
    projectId?: string,
    signal?: AbortSignal,
  ): Promise<HostedGenerationResult<Response>>;
  createReferenceUpload?(
    ownerId: string,
    value: unknown,
    token?: string,
  ): Promise<HostedGenerationResult<unknown>>;
  uploadReference?(
    ownerId: string,
    mediaId: string,
    source: AsyncIterable<Uint8Array>,
    token?: string,
    contentType?: string,
    contentLength?: number | null,
    projectId?: string,
  ): Promise<HostedGenerationResult<unknown>>;
  getReference?(ownerId: string, mediaId: string): Promise<unknown>;
  createProviderReference?(
    ownerId: string,
    mediaId: string,
    kind: "image" | "video" | "audio",
    token?: string,
    projectId?: string,
  ): Promise<HostedGenerationResult<{ url: string }>>;
};

type ProjectApi = Pick<CloudProjectService, "list" | "get" | "create" | "save" | "delete"> &
  Partial<Pick<CloudProjectService, "getForActor" | "saveForActor" | "resolveMediaAccess">>;
type CollaborationApi = Pick<
  CloudProjectCollaborationService,
  | "listMembers"
  | "invite"
  | "listInvitations"
  | "acceptInvitation"
  | "removeMember"
  | "revokeInvitation"
  | "declineInvitation"
>;

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
const DEFAULT_ANONYMOUS_AGENT_COOKIE = {
  name: "weftcanvas_agent_guest",
  secure: false,
} as const;

export function createApiApp(dependencies: ApiDependencies) {
  const app = new Hono();
  const identityCookie = dependencies.identityCookie ?? DEFAULT_IDENTITY_COOKIE;
  const anonymousAgentCookie = dependencies.anonymousAgentCookie ?? DEFAULT_ANONYMOUS_AGENT_COOKIE;
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

  // —— 音乐链接（画布音乐节点）———————————————————————————————————————————
  // 音乐平台没有对个人开放的歌曲/歌单 API，媒体域也不开 CORS：链接解析与
  // 音频代拉全部收在服务端，重定向逐跳重新过 SSRF 守卫；浏览器只接触
  // 同源代理路径，节点里不落任何第三方媒体直链。

  app.get("/api/v1/model-catalog", async (context) => {
    const forceRefresh = context.req.query("refresh") === "1";
    const requestedModality = context.req.query("modality");
    const modality = requestedModality ? modelModalitySchema.safeParse(requestedModality) : null;
    if (modality && !modality.success)
      return errorResponse(context, 400, "INVALID_MODALITY", "不支持这个模型类型");
    const catalog = toPublicCatalogView(
      await dependencies.catalog.getCatalog({
        forceRefresh,
        awaitRefresh: forceRefresh,
        // The canvas hydrates every modality from the unfiltered response.
        awaitVideoAvailability: modality?.success ? modality.data === "video" : true,
      }),
    );
    const health = await dependencies.modelHealth?.get();
    const data = modality?.success
      ? {
          ...catalog,
          models: withModelHealth(catalog.models, health).filter(
            (model) => model.modality === modality.data,
          ),
        }
      : { ...catalog, models: withModelHealth(catalog.models, health) };
    const catalogViewVersion = modelCatalogViewVersion(data);
    const etag = `"${data.version}:${data.capabilityVersion}:${data.pricingVersion}:${catalogViewVersion}:${data.quoteAvailable ? "fresh" : "stale"}:${data.expiresAt}:${modality?.success ? modality.data : "all"}"`;
    context.header("ETag", etag);
    context.header(
      "Cache-Control",
      forceRefresh ? "private, no-store" : "private, max-age=60, stale-while-revalidate=300",
    );
    if (context.req.header("If-None-Match") === etag) return context.body(null, 304);
    return context.json(modelCatalogResponseSchema.parse({ ok: true, data }));
  });

  app.get("/api/v1/model-catalog/version", async (context) => {
    const catalog = toPublicCatalogView(await dependencies.catalog.getCatalog());
    const viewVersion = modelCatalogViewVersion(catalog);
    const etag = `"${catalog.version}:${catalog.capabilityVersion}:${catalog.pricingVersion}:${viewVersion}:${catalog.quoteAvailable ? "fresh" : "stale"}"`;
    context.header("ETag", etag);
    context.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
    if (context.req.header("If-None-Match") === etag) return context.body(null, 304);
    return context.json({
      ok: true,
      data: {
        version: catalog.version,
        capabilityVersion: catalog.capabilityVersion,
        pricingVersion: catalog.pricingVersion,
        viewVersion,
        quoteAvailable: catalog.quoteAvailable,
      },
    });
  });

  // Operator model overrides. The API is the source of the fields Canvas
  // actually bills against, so hiding a model or repricing it here takes effect
  // for the picker, quotes, and new jobs without touching the upstream catalog.
  // A strong per-deployment secret guards both reads and writes; when the
  // secret is not configured the whole surface is invisible.
  app.get("/api/v1/admin/model-overrides", async (context) => {
    const secret = dependencies.modelOverridesAdminSecret;
    if (
      !dependencies.modelOverrides ||
      !secret ||
      context.req.header("x-model-overrides-secret") !== secret
    ) {
      return context.notFound();
    }
    const [overrides, catalog] = await Promise.all([
      dependencies.modelOverrides.load(),
      dependencies.catalog.getCatalog({ includeOverrides: false }),
    ]);
    const health = await dependencies.modelHealth?.get();
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      data: {
        overrides,
        models: modelOverrideAdminRows(withModelHealth(catalog.models, health), overrides),
      },
    });
  });

  app.put("/api/v1/admin/model-overrides", async (context) => {
    const secret = dependencies.modelOverridesAdminSecret;
    if (
      !dependencies.modelOverrides ||
      !secret ||
      context.req.header("x-model-overrides-secret") !== secret
    ) {
      return context.notFound();
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const parsed = modelOverridesSchema.safeParse(body);
    if (!parsed.success)
      return errorResponse(context, 422, "INVALID_MODEL_OVERRIDES", "模型覆盖配置格式不正确");
    await dependencies.modelOverrides.save(parsed.data);
    const catalog = await dependencies.catalog.getCatalog({ includeOverrides: false });
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      data: { overrides: parsed.data, models: modelOverrideAdminRows(catalog.models, parsed.data) },
    });
  });

  app.get("/admin/model-overrides", (context) => {
    context.header("Content-Type", "text/html; charset=utf-8");
    context.header("Cache-Control", "no-store");
    context.header("X-Robots-Tag", "noindex, nofollow");
    return context.body(MODEL_OVERRIDES_ADMIN_PAGE);
  });

  // 站点公告：运营在后台维护，画布前端匿名读取。启用 / 定时发布 / 过期都在
  // 读取时现算，保存即生效，不需要定时任务；写用运营密钥（与后台同一把，
  // 缺省已回落到模型密钥），没配密钥时管理面整体 404。
  const requireAnnouncementAdmin = (context: {
    req: { header(name: string): string | undefined };
  }) =>
    Boolean(dependencies.announcements && dependencies.announcementsAdminSecret) &&
    context.req.header("x-canvas-ops-secret") === dependencies.announcementsAdminSecret;

  app.get("/api/v1/announcements", async (context) => {
    const collection = dependencies.announcements
      ? await dependencies.announcements.load()
      : EMPTY_ANNOUNCEMENTS;
    context.header("Cache-Control", "no-store");
    return context.json(
      announcementListResponseSchema.parse({
        ok: true,
        data: { items: publicAnnouncements(collection) },
      }),
    );
  });

  app.get("/api/v1/admin/announcements", async (context) => {
    if (!requireAnnouncementAdmin(context)) return context.notFound();
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: await dependencies.announcements!.load() });
  });

  app.put("/api/v1/admin/announcements", async (context) => {
    if (!requireAnnouncementAdmin(context)) return context.notFound();
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const parsed = announcementCollectionSchema.safeParse(body);
    if (!parsed.success)
      return errorResponse(context, 422, "INVALID_ANNOUNCEMENTS", "公告格式不正确");
    await dependencies.announcements!.save(parsed.data);
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: parsed.data });
  });

  // 画布运营后台（只读监控）。独立密钥，缺省回落到模型后台那把，少配一个变量。
  const requireOpsAdmin = (context: { req: { header(name: string): string | undefined } }) =>
    Boolean(dependencies.ops && dependencies.opsAdminSecret) &&
    context.req.header("x-canvas-ops-secret") === dependencies.opsAdminSecret;

  app.get("/api/v1/admin/ops/overview", async (context) => {
    if (!requireOpsAdmin(context)) return context.notFound();
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: await dependencies.ops!.overview() });
  });

  app.get("/api/v1/admin/ops/jobs", async (context) => {
    if (!requireOpsAdmin(context)) return context.notFound();
    const status = context.req.query("status") === "all" ? "all" : "failed";
    const limit = Number(context.req.query("limit") ?? 50);
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      data: { jobs: await dependencies.ops!.recentJobs(status, limit) },
    });
  });

  app.get("/api/v1/admin/ops/users", async (context) => {
    if (!requireOpsAdmin(context)) return context.notFound();
    const query = context.req.query("query") ?? "";
    const limit = Number(context.req.query("limit") ?? 50);
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: await dependencies.ops!.users(query, limit) });
  });

  app.get("/admin/ops", (context) => {
    context.header("Content-Type", "text/html; charset=utf-8");
    context.header("Cache-Control", "no-store");
    context.header("X-Robots-Tag", "noindex, nofollow");
    return context.body(CANVAS_OPS_ADMIN_PAGE);
  });

  app.post("/api/v1/generation-quotes", async (context) => {
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const quote = await dependencies.quotes.createQuote(body);
    context.header("Cache-Control", "no-store");
    return context.json(generationQuoteResponseSchema.parse({ ok: true, data: quote }));
  });

  app.post("/api/v1/generation-jobs", async (context) => {
    if (!dependencies.generation)
      return generationUnavailable(context, dependencies.generationUnavailableMessage);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交生成任务",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    await dependencies.generationGuard?.checkSubmission(session.user.id);
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const result = await dependencies.generation.submit(
      session.user.id,
      body,
      getCookie(context, identityCookie.name),
    );
    const job = unwrapGenerationResult(result);
    refreshIdentityCookie(context, identityCookie, generationRefresh(result));
    context.header("Cache-Control", "no-store");
    return context.json(generationJobResponseSchema.parse({ ok: true, data: job }), 202);
  });

  app.get("/api/v1/generation-jobs", async (context) => {
    if (!dependencies.generation)
      return generationUnavailable(context, dependencies.generationUnavailableMessage);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    await dependencies.generationGuard?.checkRead(session.user.id);
    const limit = optionalQueryInteger(context, context.req.query("limit"), 50);
    if (limit instanceof Response) return limit;
    const result = await dependencies.generation.list(
      session.user.id,
      {
        ...(context.req.query("projectId") !== undefined
          ? { projectId: context.req.query("projectId") }
          : {}),
        limit,
      },
      getCookie(context, identityCookie.name),
    );
    const jobs = unwrapGenerationResult(result);
    refreshIdentityCookie(context, identityCookie, generationRefresh(result));
    context.header("Cache-Control", "private, no-store");
    return context.json(generationJobListResponseSchema.parse({ ok: true, data: jobs }));
  });

  // 本机专用：每日存储清扫（systemd timer 调用）。防线：强随机 secret 头 +
  // 拒绝一切带代理痕迹的请求（x-forwarded-for 存在即说明经 Tunnel/代理到达，
  // timer 直连 127.0.0.1 不会带该头；原生 Headers.get 对缺失头返回 null）。
  app.post("/api/v1/internal/storage-sweep", async (context) => {
    if (!dependencies.storageSweep || !dependencies.storageSweepSecret) {
      return context.notFound();
    }
    if (
      context.req.header("x-forwarded-for") !== undefined ||
      context.req.header("x-storage-sweep-secret") !== dependencies.storageSweepSecret
    ) {
      return context.notFound();
    }
    const result = await dependencies.storageSweep.sweep();
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: result });
  });

  // Read-only reconciliation by the exact durable idempotency identity. This
  // route resolves a persisted optimistic request that the newest-100 list
  // recovery cannot authoritatively cover. It is owner-scoped, rate-limited
  // through the normal generation read guard, and never submits, retries,
  // replays, mutates a job, or contacts a provider. A 404 is the unambiguous
  // authoritative miss the browser uses to settle an expired request.
  app.get("/api/v1/generation-jobs/reconcile", async (context) => {
    if (!dependencies.generation)
      return generationUnavailable(context, dependencies.generationUnavailableMessage);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    await dependencies.generationGuard?.checkRead(session.user.id);
    const parsed = generationJobReconcileQuerySchema.safeParse({
      key: context.req.query("key") ?? "",
    });
    if (!parsed.success) {
      return errorResponse(context, 422, "INVALID_IDEMPOTENCY_KEY", "任务标识格式不正确");
    }
    if (!dependencies.generation.resolveByIdempotency) {
      return errorResponse(
        context,
        503,
        "GENERATION_RECONCILE_UNAVAILABLE",
        "任务核对服务暂不可用",
      );
    }
    const result = await dependencies.generation.resolveByIdempotency(
      session.user.id,
      parsed.data.key,
      getCookie(context, identityCookie.name),
    );
    if (result === null || result === undefined) {
      context.header("Cache-Control", "private, no-store");
      return errorResponse(context, 404, "GENERATION_JOB_NOT_FOUND", "没有找到这个生成任务");
    }
    const job = unwrapGenerationResult(result);
    refreshIdentityCookie(context, identityCookie, generationRefresh(result));
    context.header("Cache-Control", "private, no-store");
    return context.json(generationJobResponseSchema.parse({ ok: true, data: job }));
  });

  app.get("/api/v1/generation-jobs/:jobId", async (context) => {
    if (!dependencies.generation)
      return generationUnavailable(context, dependencies.generationUnavailableMessage);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    await dependencies.generationGuard?.checkRead(session.user.id);
    const result = await dependencies.generation.get(
      session.user.id,
      context.req.param("jobId"),
      getCookie(context, identityCookie.name),
    );
    const job = unwrapGenerationResult(result);
    refreshIdentityCookie(context, identityCookie, generationRefresh(result));
    context.header("Cache-Control", "private, no-store");
    return context.json(generationJobResponseSchema.parse({ ok: true, data: job }));
  });

  app.get("/api/v1/generation-jobs/:jobId/events", async (context) => {
    if (!dependencies.generation)
      return generationUnavailable(context, dependencies.generationUnavailableMessage);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const release = dependencies.generationGuard
      ? await dependencies.generationGuard.acquireStream(session.user.id)
      : () => undefined;
    const sessionToken = getCookie(context, identityCookie.name);
    let initial;
    try {
      const initialResult = await dependencies.generation.get(
        session.user.id,
        context.req.param("jobId"),
        sessionToken,
      );
      // The first hosted status read happens before the SSE response starts,
      // so a rotated Prompt Hub session can still be written to the browser.
      refreshIdentityCookie(context, identityCookie, generationRefresh(initialResult));
      initial = unwrapGenerationResult(initialResult);
    } catch (error) {
      release();
      throw error;
    }
    const settings = dependencies.generationStream ?? {
      pollIntervalMs: 1_000,
      heartbeatMs: 15_000,
      maxDurationMs: 10 * 60_000,
    };
    const now = settings.now ?? Date.now;
    const lastVersion = lastEventVersion(
      context.req.header("Last-Event-ID"),
      initial.id,
      initial.version,
    );
    context.header("Cache-Control", "private, no-cache, no-transform");
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      let current = initial;
      let emittedVersion = isGenerationObservationTerminal(current.status) ? -1 : lastVersion;
      let heartbeatAt = now() + settings.heartbeatMs;
      const deadline = now() + settings.maxDurationMs;
      try {
        while (!aborted && now() < deadline) {
          if (current.version !== emittedVersion) {
            const event = generationJobEventSchema.parse({ type: "job", job: current });
            await stream.writeSSE({
              id: generationEventId(current.id, current.version),
              event: "job",
              data: JSON.stringify(event),
              retry: 2_000,
            });
            emittedVersion = current.version;
          }
          if (isGenerationObservationTerminal(current.status)) return;
          if (now() >= heartbeatAt) {
            await stream.write(": heartbeat\n\n");
            heartbeatAt = now() + settings.heartbeatMs;
          }
          await stream.sleep(settings.pollIntervalMs);
          if (aborted) return;
          const nextResult = await dependencies.generation!.get(
            session.user.id,
            current.id,
            sessionToken,
          );
          current = unwrapGenerationResult(nextResult);
          if (generationRefresh(nextResult).refreshedToken) {
            // Set-Cookie cannot be changed reliably after an SSE body starts.
            // Move observation to the normal polling route, whose response can
            // persist the rotated HttpOnly session before continuing.
            await stream.writeSSE({
              event: "status-error",
              data: JSON.stringify({
                code: "SESSION_REFRESH_REQUIRED",
                message: "正在更新登录状态",
              }),
              retry: 1_000,
            });
            return;
          }
        }
      } catch {
        if (!aborted) {
          await stream
            .writeSSE({
              event: "status-error",
              data: JSON.stringify({
                code: "GENERATION_STATUS_UNAVAILABLE",
                message: "任务状态暂时无法更新",
              }),
              retry: 2_000,
            })
            .catch(() => undefined);
        }
      } finally {
        release();
      }
    });
  });

  app.get("/api/v1/cloud-projects", async (context) => {
    if (!dependencies.projects) return cloudProjectsUnavailable(context);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await dependencies.projects.list(
      session.user.id,
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(cloudProjectListResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/cloud-projects", async (context) => {
    if (!dependencies.projects) return cloudProjectsUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Cloud projects cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const result = await dependencies.projects.create(
      session.user.id,
      body,
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    setCloudProjectEtag(context, result.data.id, result.data.revision);
    return context.json(cloudProjectResponseSchema.parse({ ok: true, data: result.data }), 201);
  });

  app.get("/api/v1/cloud-projects/:projectId", async (context) => {
    if (!dependencies.projects) return cloudProjectsUnavailable(context);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectOwnerId = optionalProjectOwnerId(context.req.query("ownerId"));
    const result = dependencies.projects.getForActor
      ? await dependencies.projects.getForActor(
          session.user.id,
          context.req.param("projectId"),
          getCookie(context, identityCookie.name),
          projectOwnerId,
        )
      : await dependencies.projects.get(
          session.user.id,
          context.req.param("projectId"),
          getCookie(context, identityCookie.name),
        );
    refreshIdentityCookie(context, identityCookie, result);
    setCloudProjectEtag(context, result.data.id, result.data.revision);
    return context.json(cloudProjectResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.put("/api/v1/cloud-projects/:projectId", async (context) => {
    if (!dependencies.projects) return cloudProjectsUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Cloud projects cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const projectOwnerId = optionalProjectOwnerId(context.req.query("ownerId"));
    const result = dependencies.projects.saveForActor
      ? await dependencies.projects.saveForActor(
          session.user.id,
          context.req.param("projectId"),
          body,
          getCookie(context, identityCookie.name),
          projectOwnerId,
        )
      : await dependencies.projects.save(
          session.user.id,
          context.req.param("projectId"),
          body,
          getCookie(context, identityCookie.name),
        );
    refreshIdentityCookie(context, identityCookie, result);
    setCloudProjectEtag(context, result.data.id, result.data.revision);
    return context.json(cloudProjectResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.delete("/api/v1/cloud-projects/:projectId", async (context) => {
    if (!dependencies.projects) return cloudProjectsUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Cloud projects cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const baseRevision = z.coerce
      .number()
      .int()
      .positive()
      .parse(context.req.query("baseRevision"));
    // 项目删除会级联移除绑定关系，但不会删除 canvas_media 记录本身；删除前采集
    // 被该项目绑定的素材，删除后释放其中已无任何项目引用的独占素材（含对象字节），
    // 否则账号存储配额会一直被“已删除画布”的素材占满。
    const boundMediaIds = dependencies.cloudResources
      ? await dependencies.cloudResources
          .listProjectBoundMediaIds(session.user.id, context.req.param("projectId"))
          .catch(() => [] as string[])
      : [];
    const result = await dependencies.projects.delete(
      session.user.id,
      context.req.param("projectId"),
      { baseRevision },
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    if (dependencies.cloudResources && boundMediaIds.length) {
      await dependencies.cloudResources
        .releaseUnbound(session.user.id, boundMediaIds)
        .catch((error) => {
          console.error("Failed to release deleted project media", error);
        });
    }
    return context.json(cloudProjectDeleteResponseSchema.parse(result.data));
  });

  app.get("/api/v1/cloud-projects/:projectId/members", async (context) => {
    if (!dependencies.collaboration) return collaborationUnavailable(context);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectOwnerId = optionalProjectOwnerId(context.req.query("ownerId"));
    const result = await dependencies.collaboration.listMembers(
      session.user.id,
      context.req.param("projectId"),
      getCookie(context, identityCookie.name),
      projectOwnerId,
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      cloudProjectMemberListResponseSchema.parse({ ok: true, data: result.data }),
    );
  });

  app.post("/api/v1/cloud-projects/:projectId/members/invitations", async (context) => {
    if (!dependencies.collaboration) return collaborationUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Project invitations cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const result = await dependencies.collaboration.invite(
      session.user.id,
      context.req.param("projectId"),
      body,
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      cloudProjectInvitationResponseSchema.parse({ ok: true, data: result.data }),
      201,
    );
  });

  app.delete(
    "/api/v1/cloud-projects/:projectId/members/invitations/:invitationId",
    async (context) => {
      if (!dependencies.collaboration) return collaborationUnavailable(context);
      if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
        return errorResponse(
          context,
          403,
          "CROSS_SITE_REQUEST_REJECTED",
          "Project invitations cannot be changed from another site",
        );
      }
      const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
      if (session instanceof Response) return session;
      const result = await dependencies.collaboration.revokeInvitation(
        session.user.id,
        context.req.param("projectId"),
        context.req.param("invitationId"),
      );
      return context.json(cloudProjectDeleteResponseSchema.parse(result.data));
    },
  );

  app.delete("/api/v1/cloud-projects/:projectId/members/:memberId", async (context) => {
    if (!dependencies.collaboration) return collaborationUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Project members cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await dependencies.collaboration.removeMember(
      session.user.id,
      context.req.param("projectId"),
      context.req.param("memberId"),
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(cloudProjectDeleteResponseSchema.parse(result.data));
  });

  app.get("/api/v1/cloud-project-invitations", async (context) => {
    if (!dependencies.collaboration) return collaborationUnavailable(context);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await dependencies.collaboration.listInvitations(
      session.user.id,
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      cloudProjectInvitationListResponseSchema.parse({ ok: true, data: result.data }),
    );
  });

  app.post("/api/v1/cloud-project-invitations/:invitationId/accept", async (context) => {
    if (!dependencies.collaboration) return collaborationUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Project invitations cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await dependencies.collaboration.acceptInvitation(
      session.user.id,
      context.req.param("invitationId"),
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(cloudProjectMemberResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.delete("/api/v1/cloud-project-invitations/:invitationId", async (context) => {
    if (!dependencies.collaboration) return collaborationUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "Project invitations cannot be changed from another site",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const result = await dependencies.collaboration.declineInvitation(
      session.user.id,
      context.req.param("invitationId"),
    );
    return context.json(cloudProjectDeleteResponseSchema.parse(result.data));
  });

  // —— 用户自导入的 Agent 技能 ——————————————————————————————————————————
  // 只有本会话拥有者能看到、导入、删除自己的技能：技能正文会直接进模型上下文，
  // 这里不做任何跨账号读取。存储未注入时整个面 404（与公告/模型覆盖同款）。
  app.get("/api/v1/agent/skills", async (context) => {
    if (!dependencies.agentSkills) return context.notFound();
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const skills = await dependencies.agentSkills.list(session.user.id);
    context.header("Cache-Control", "no-store");
    return context.json(agentSkillListResponseSchema.parse({ ok: true, data: skills }));
  });

  app.post("/api/v1/agent/skills", async (context) => {
    if (!dependencies.agentSkills) return context.notFound();
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点导入 Agent 技能",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const parsed = agentSkillImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(context, 422, "INVALID_SKILL", "技能内容格式不正确");
    }
    try {
      const skill = await dependencies.agentSkills.save(session.user.id, parsed.data.content);
      context.header("Cache-Control", "no-store");
      return context.json(agentSkillResponseSchema.parse({ ok: true, data: skill }), 201);
    } catch (error) {
      if (error instanceof AgentSkillStoreError) {
        const status = error.code === "SKILL_LIMIT_EXCEEDED" ? 409 : 422;
        return errorResponse(context, status, error.code, error.message);
      }
      throw error;
    }
  });

  app.delete("/api/v1/agent/skills/:skillId", async (context) => {
    if (!dependencies.agentSkills) return context.notFound();
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点删除 Agent 技能",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const deleted = await dependencies.agentSkills.remove(
      session.user.id,
      context.req.param("skillId"),
    );
    if (!deleted) {
      context.header("Cache-Control", "no-store");
      return errorResponse(context, 404, "SKILL_NOT_FOUND", "没有找到这个技能");
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      agentSkillDeleteResponseSchema.parse({
        ok: true,
        data: { id: context.req.param("skillId"), deleted: true },
      }),
    );
  });

  app.get("/api/v1/agent/models", async (context) => {
    if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取 Agent 模型",
      );
    }
    const access = await resolveAgentAccess(
      context,
      dependencies,
      identityCookie,
      anonymousAgentCookie,
    );
    if (access instanceof Response) return access;
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeRead(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    const catalog = await access.agent.getModels(access.ownerId);
    context.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
    return context.json(agentModelCatalogResponseSchema.parse({ ok: true, data: catalog }));
  });

  app.get("/api/v1/agent/conversations", async (context) => {
    if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取 Agent 对话",
      );
    }
    const access = await resolveAgentAccess(
      context,
      dependencies,
      identityCookie,
      anonymousAgentCookie,
    );
    if (access instanceof Response) return access;
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeRead(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    const projectId = context.req.query("projectId");
    if (!projectId) return errorResponse(context, 400, "PROJECT_ID_REQUIRED", "缺少画布项目信息");
    const limit = optionalQueryInteger(context, context.req.query("limit"), 30);
    if (limit instanceof Response) return limit;
    const conversations = await access.agent.listConversations(access.ownerId, projectId, limit);
    context.header("Cache-Control", "private, no-store");
    return context.json(
      agentConversationListResponseSchema.parse({ ok: true, data: conversations }),
    );
  });

  app.post("/api/v1/agent/conversations", async (context) => {
    if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点创建 Agent 对话",
      );
    }
    const access = await resolveAgentAccess(
      context,
      dependencies,
      identityCookie,
      anonymousAgentCookie,
    );
    if (access instanceof Response) return access;
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeRead(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeConversation(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const conversation = await access.agent.createConversation(access.ownerId, body);
    context.header("Cache-Control", "no-store");
    return context.json(
      agentConversationResponseSchema.parse({ ok: true, data: conversation }),
      201,
    );
  });

  app.get("/api/v1/agent/conversations/:conversationId", async (context) => {
    if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取 Agent 对话",
      );
    }
    const access = await resolveAgentAccess(
      context,
      dependencies,
      identityCookie,
      anonymousAgentCookie,
    );
    if (access instanceof Response) return access;
    const detail = await access.agent.getDetail(
      access.ownerId,
      context.req.param("conversationId"),
    );
    context.header("Cache-Control", "private, no-store");
    return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
  });

  app.post("/api/v1/agent/conversations/:conversationId/messages", async (context) => {
    if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交 Agent 任务",
      );
    }
    const access = await resolveAgentAccess(
      context,
      dependencies,
      identityCookie,
      anonymousAgentCookie,
    );
    if (access instanceof Response) return access;
    if (access.anonymous) {
      const limited = anonymousAgentGuard.consumeSubmission(access.ownerId);
      if (limited) return anonymousAgentRateLimited(context, limited);
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const detail = await access.agent.submitMessage(
      access.ownerId,
      context.req.param("conversationId"),
      body,
      getCookie(context, identityCookie.name),
    );
    context.header("Cache-Control", "no-store");
    return context.json(
      agentConversationDetailResponseSchema.parse({ ok: true, data: detail }),
      202,
    );
  });

  app.post("/api/v1/agent/conversations/:conversationId/runs/:runId/cancel", async (context) => {
    if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点取消 Agent 任务",
      );
    }
    const access = await resolveAgentAccess(
      context,
      dependencies,
      identityCookie,
      anonymousAgentCookie,
    );
    if (access instanceof Response) return access;
    await access.agent.cancelRun(
      access.ownerId,
      context.req.param("runId"),
      getCookie(context, identityCookie.name),
    );
    const detail = await access.agent.getDetail(
      access.ownerId,
      context.req.param("conversationId"),
    );
    context.header("Cache-Control", "no-store");
    return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
  });

  app.post(
    "/api/v1/agent/conversations/:conversationId/runs/:runId/proposal/confirm",
    async (context) => {
      if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
      if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
        return errorResponse(
          context,
          403,
          "CROSS_SITE_REQUEST_REJECTED",
          "无法从其他站点确认 Agent 提案",
        );
      }
      const access = await resolveAgentAccess(
        context,
        dependencies,
        identityCookie,
        anonymousAgentCookie,
      );
      if (access instanceof Response) return access;
      const body = await readJsonBody(context);
      if (body instanceof Response) return body;
      const detail = await access.agent.confirmProposal(
        access.ownerId,
        context.req.param("conversationId"),
        context.req.param("runId"),
        body,
      );
      context.header("Cache-Control", "no-store");
      return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
    },
  );

  app.post(
    "/api/v1/agent/conversations/:conversationId/runs/:runId/proposal/dismiss",
    async (context) => {
      if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
      if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
        return errorResponse(
          context,
          403,
          "CROSS_SITE_REQUEST_REJECTED",
          "无法从其他站点取消 Agent 提案",
        );
      }
      const access = await resolveAgentAccess(
        context,
        dependencies,
        identityCookie,
        anonymousAgentCookie,
      );
      if (access instanceof Response) return access;
      const detail = await access.agent.dismissProposal(
        access.ownerId,
        context.req.param("conversationId"),
        context.req.param("runId"),
      );
      context.header("Cache-Control", "no-store");
      return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
    },
  );

  app.post("/api/v1/agent/conversations/:conversationId/runs/:runId/receipt", async (context) => {
    if (!dependencies.agent && !dependencies.anonymousAgent) return agentUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交 Agent 执行回执",
      );
    }
    const access = await resolveAgentAccess(
      context,
      dependencies,
      identityCookie,
      anonymousAgentCookie,
    );
    if (access instanceof Response) return access;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const detail = await access.agent.recordReceipt(
      access.ownerId,
      context.req.param("conversationId"),
      context.req.param("runId"),
      body,
    );
    context.header("Cache-Control", "no-store");
    return context.json(agentConversationDetailResponseSchema.parse({ ok: true, data: detail }));
  });

  app.get("/api/v1/agent/connectors", async (context) => {
    const gateway = dependencies.connectors;
    if (!gateway) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取本机连接",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    try {
      const connectors = await gateway.list(context.req.raw.signal);
      context.header("Cache-Control", "private, no-store");
      return context.json(agentConnectorListResponseSchema.parse({ ok: true, data: connectors }));
    } catch (error) {
      return connectorFailure(context, error);
    }
  });

  app.put("/api/v1/agent/connectors/:connectorId", async (context) => {
    const gateway = dependencies.connectors;
    if (!gateway) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点修改本机连接",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const connectorId = agentConnectorIdSchema.safeParse(context.req.param("connectorId"));
    if (!connectorId.success)
      return errorResponse(context, 404, "CONNECTOR_NOT_FOUND", "没有这个连接");
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const patch = agentConnectorUpdateRequestSchema.safeParse(body);
    if (!patch.success) return errorResponse(context, 400, "INVALID_REQUEST", "连接设置无效");
    try {
      const connector = await gateway.update(connectorId.data, patch.data, context.req.raw.signal);
      context.header("Cache-Control", "private, no-store");
      return context.json(agentConnectorResponseSchema.parse({ ok: true, data: connector }));
    } catch (error) {
      return connectorFailure(context, error);
    }
  });

  app.post("/api/v1/agent/connectors/:connectorId/connect", async (context) => {
    const gateway = dependencies.connectors;
    if (!gateway) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点接入本机连接",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const connectorId = agentConnectorIdSchema.safeParse(context.req.param("connectorId"));
    if (!connectorId.success)
      return errorResponse(context, 404, "CONNECTOR_NOT_FOUND", "没有这个连接");
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = connectorConnectRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "接入参数无效");
    try {
      const connector = await gateway.connect(connectorId.data, input.data, context.req.raw.signal);
      context.header("Cache-Control", "private, no-store");
      return context.json(agentConnectorResponseSchema.parse({ ok: true, data: connector }));
    } catch (error) {
      return connectorFailure(context, error);
    }
  });

  /**
   * 画布页面轮询：上报当前画布摘要并取回外部连接下发的指令。
   * 指令由浏览器用与 Agent 相同的 applyAgentActions 执行，再回执。
   */
  app.post("/api/v1/agent/canvas-control/pending", async (context) => {
    const gateway = dependencies.connectors;
    const broker = dependencies.canvasCommands;
    if (!gateway && !broker) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取画布指令",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = canvasControlPendingRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "缺少画布项目");

    const ownerId = session.user.id;
    // 浏览器上报的画布摘要：托管站点上 Codex 的 canvas_read 靠它读到真实节点 id。
    broker?.rememberContext(ownerId, input.data.projectId, input.data.context);

    const commands = (broker?.pendingFor(ownerId) ?? []).filter(
      (command) => command.projectId === input.data.projectId,
    );
    if (gateway) {
      try {
        commands.push(
          ...(await gateway.pending(
            input.data.projectId,
            input.data.context,
            context.req.raw.signal,
          )),
        );
      } catch {
        // 本机运行时不可达不该影响托管站点的外部连接通道。
      }
    }
    context.header("Cache-Control", "private, no-store");
    return context.json(canvasControlPendingResponseSchema.parse({ ok: true, data: { commands } }));
  });

  app.post("/api/v1/agent/canvas-control/receipts", async (context) => {
    const gateway = dependencies.connectors;
    const broker = dependencies.canvasCommands;
    if (!gateway && !broker) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交画布回执",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const receipt = canvasControlReceiptRequestSchema.safeParse(body);
    if (!receipt.success) return errorResponse(context, 400, "INVALID_REQUEST", "回执无效");
    // 先结算托管队列；不是它的指令再转给本机运行时。
    const accepted = broker?.submitReceipt(session.user.id, receipt.data) ?? false;
    if (!accepted && gateway) {
      try {
        const forwarded = await gateway.recordReceipt(receipt.data, context.req.raw.signal);
        context.header("Cache-Control", "no-store");
        return context.json(
          canvasControlReceiptResponseSchema.parse({ ok: true, data: { accepted: forwarded } }),
        );
      } catch (error) {
        return connectorFailure(context, error);
      }
    }
    context.header("Cache-Control", "no-store");
    return context.json(canvasControlReceiptResponseSchema.parse({ ok: true, data: { accepted } }));
  });

  /* ---------------- 用户侧反向连接：会话侧（浏览器） ---------------- */

  app.get("/api/v1/agent/connectors/clients", async (context) => {
    const service = dependencies.externalConnectors;
    if (!service) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点读取连接状态",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    context.header("Cache-Control", "private, no-store");
    return context.json(
      connectorClientListResponseSchema.parse({
        ok: true,
        data: service.listStatus(session.user.id, agentConnectorIds),
      }),
    );
  });

  app.post("/api/v1/agent/connectors/pairing", async (context) => {
    const service = dependencies.externalConnectors;
    if (!service) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点创建配对");
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = connectorPairingRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "配对参数无效");
    context.header("Cache-Control", "no-store");
    return context.json(
      connectorPairingResponseSchema.parse({
        ok: true,
        data: service.createPairing(session.user.id, input.data.connectorId),
      }),
    );
  });

  app.delete("/api/v1/agent/connectors/pairing/:connectorId", async (context) => {
    const service = dependencies.externalConnectors;
    if (!service) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点撤销配对");
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const connectorId = agentConnectorIdSchema.safeParse(context.req.param("connectorId"));
    if (!connectorId.success)
      return errorResponse(context, 404, "CONNECTOR_NOT_FOUND", "没有这个连接");
    const revoked = service.revokePairing(session.user.id, connectorId.data);
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: { revoked } });
  });

  /** 在用户自己的机器上跑一条任务并等结果（面板「测试连接」用）。 */
  app.post("/api/v1/agent/connectors/tasks", async (context) => {
    const service = dependencies.externalConnectors;
    if (!service) return connectorUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点派发任务");
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = externalTaskRunRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "任务参数无效");
    const outcome = await service.runTask(session.user.id, input.data);
    context.header("Cache-Control", "no-store");
    return context.json(externalTaskRunResponseSchema.parse({ ok: true, data: outcome }));
  });

  /* ------------- 用户侧反向连接：令牌侧（用户机器上的客户端） ------------- */

  app.post("/api/external/v1/connectors/poll", async (context) => {
    const service = dependencies.externalConnectors;
    if (!service) return connectorUnavailable(context);
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = externalPollRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "轮询参数无效");
    const token = readBearerToken(context.req.header("authorization"));
    const polled = token ? service.poll({ token, connectorId: input.data.connectorId }) : null;
    if (!polled) {
      return errorResponse(context, 401, "UNAUTHORIZED", "配对令牌无效、已撤销，或与连接不匹配");
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      externalPollResponseSchema.parse({
        ok: true,
        data: { tasks: polled.tasks, pollAfterMs: service.pollAfterMs() },
      }),
    );
  });

  app.post("/api/external/v1/connectors/results", async (context) => {
    const service = dependencies.externalConnectors;
    if (!service) return connectorUnavailable(context);
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = externalTaskResultRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "回执参数无效");
    const token = readBearerToken(context.req.header("authorization"));
    const accepted = token ? service.submitResult(token, input.data) : false;
    if (!accepted) {
      return errorResponse(
        context,
        401,
        "UNAUTHORIZED",
        "配对令牌无效、已撤销，或任务不属于这个连接",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      externalTaskResultResponseSchema.parse({ ok: true, data: { accepted: true } }),
    );
  });

  /**
   * 运行时 → API：把一段 Python 派发到**用户自己机器**上的 Blender（配对通道）。
   * 用与 Agent 运行时共享的令牌鉴权；服务器上没有也不该有 Blender。
   */
  app.post("/internal/v1/connectors/blender/run", async (context) => {
    const service = dependencies.externalConnectors;
    const expected = dependencies.internalRuntimeToken;
    if (!service || !expected) return connectorUnavailable(context);
    const token = readBearerToken(context.req.header("authorization"));
    if (!token || !constantTimeEquals(token, expected)) {
      return errorResponse(context, 401, "UNAUTHORIZED", "Unauthorized");
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = blenderDispatchRequestSchema.safeParse(body);
    if (!input.success) return errorResponse(context, 400, "INVALID_REQUEST", "派发参数无效");
    const outcome = await service.runTask(input.data.ownerId, {
      connectorId: "blender",
      method: "run_python",
      params: { code: input.data.code },
      waitMs: 45_000,
    });
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: outcome });
  });

  /**
   * Codex 的远程 MCP 入口。Codex 带自己的配对令牌连到这里，工具调用经队列交给
   * **用户浏览器**执行；服务端不持有画布状态，令牌也只能影响该用户自己的画布。
   */
  app.post("/api/external/v1/mcp", async (context) => {
    const broker = dependencies.canvasCommands;
    const connectors = dependencies.externalConnectors;
    if (!broker || !connectors) return connectorUnavailable(context);
    const token = readBearerToken(context.req.header("authorization"));
    const owner = token ? connectors.authenticate(token) : null;
    if (!owner || owner.connectorId !== "codex") {
      return errorResponse(context, 401, "UNAUTHORIZED", "配对令牌无效、已撤销，或不是 Codex 连接");
    }
    // 与全站其它路由一致：强制 JSON Content-Type、1MB 上限、拒绝压缩编码，
    // 避免持令牌客户端用超大 / 非 JSON 请求体消耗服务端资源。
    const message = await readJsonBody(context);
    if (message instanceof Response) return message;
    const response = await handleCodexMcpMessage(message as Record<string, unknown>, {
      ownerId: owner.ownerId,
      broker,
      signal: context.req.raw.signal,
    });
    context.header("Cache-Control", "no-store");
    // 通知没有响应体（MCP 约定 202 + 空体）。
    if (response === null) return context.body(null, 202);
    return context.json(response);
  });

  app.post("/api/v1/media/uploads", async (context) => {
    const mediaService = dependencies.media;
    if (!mediaService && !dependencies.generation?.createReferenceUpload)
      return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点上传素材");
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = mediaUploadRequestSchema.parse(body);
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      input.projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    if (!mediaService && dependencies.generation?.createReferenceUpload) {
      const result = await dependencies.generation.createReferenceUpload(
        mediaAccess.ownerId,
        input,
        mediaAccess.token,
      );
      refreshIdentityCookie(context, identityCookie, result);
      context.header("Cache-Control", "no-store");
      return context.json(
        mediaUploadIntentResponseSchema.parse({
          ok: true,
          data: scopeMediaUploadIntent(mediaUploadIntentSchema.parse(result.data), input.projectId),
        }),
      );
    }
    const resolvedEntitlements = input.projectId
      ? undefined
      : await dependencies.entitlements?.resolve(mediaAccess.ownerId, mediaAccess.token, {
          allowStale: false,
        });
    if (resolvedEntitlements) refreshIdentityCookie(context, identityCookie, resolvedEntitlements);
    const created = await mediaService!.createUpload(
      mediaAccess.ownerId,
      input,
      mediaAccess.mediaStorageBytes ?? resolvedEntitlements?.data.mediaStorageBytes,
    );
    const multipartUpload =
      created.uploadRequired && created.media.size >= MEDIA_MULTIPART_THRESHOLD
        ? ((await dependencies.multipartMedia?.createUpload(
            mediaAccess.ownerId,
            created.media.id,
            input.projectId,
          )) ?? null)
        : null;
    const directUpload =
      created.uploadRequired && !multipartUpload
        ? await mediaService!.createDirectUploadInstruction(
            mediaAccess.ownerId,
            created.media.id,
            input.projectId,
          )
        : null;
    const upload = created.uploadRequired
      ? (multipartUpload ??
        (directUpload
          ? {
              ...directUpload,
              completeUrl: mediaProjectUrl(
                `/api/v1/media/${created.media.id}/complete`,
                input.projectId,
              ),
            }
          : {
              method: "PUT" as const,
              url: mediaProjectUrl(`/api/v1/media/${created.media.id}/content`, input.projectId),
              headers: { "Content-Type": created.contentType },
              expiresAt: created.uploadExpiresAt,
              completeUrl: null,
            }))
      : null;
    context.header("Cache-Control", "no-store");
    return context.json(
      mediaUploadIntentResponseSchema.parse({
        ok: true,
        data: scopeMediaUploadIntent({ media: created.media, upload }, input.projectId),
      }),
    );
  });

  app.put("/api/v1/media/:mediaId/content", async (context) => {
    const mediaService = dependencies.media;
    if (!mediaService && !dependencies.generation?.uploadReference)
      return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点上传素材");
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const source = context.req.raw.body;
    if (!source) return errorResponse(context, 400, "MEDIA_BODY_REQUIRED", "上传内容为空");
    if (!mediaService && dependencies.generation?.uploadReference) {
      const result = await dependencies.generation.uploadReference(
        mediaAccess.ownerId,
        context.req.param("mediaId"),
        source as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
        mediaAccess.token,
        context.req.header("Content-Type"),
        readContentLength(context.req.header("Content-Length")),
        projectId,
      );
      refreshIdentityCookie(context, identityCookie, result);
      context.header("Cache-Control", "no-store");
      return context.json(mediaResponseSchema.parse({ ok: true, data: result.data }));
    }
    const media = await mediaService!.upload(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      source as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
      {
        contentType: context.req.header("Content-Type"),
        contentLength: readContentLength(context.req.header("Content-Length")),
      },
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaResponseSchema.parse({ ok: true, data: media }));
  });

  app.post("/api/v1/media/:mediaId/complete", async (context) => {
    if (!dependencies.media) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点确认素材");
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const media = await dependencies.media.completeDirectUpload(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaResponseSchema.parse({ ok: true, data: media }));
  });

  app.post("/api/v1/media/:mediaId/multipart/:sessionId/parts", async (context) => {
    if (!dependencies.multipartMedia) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点签发上传分片",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = mediaMultipartPartSignRequestSchema.parse(body);
    const result = await dependencies.multipartMedia.signParts(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      context.req.param("sessionId"),
      input.partNumbers,
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaMultipartPartInstructionsResponseSchema.parse(result));
  });

  app.get("/api/v1/media/:mediaId/multipart/:sessionId", async (context) => {
    if (!dependencies.multipartMedia) return mediaUnavailable(context);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const state = await dependencies.multipartMedia.getState(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      context.req.param("sessionId"),
      projectId,
    );
    context.header("Cache-Control", "private, no-store");
    return context.json(mediaMultipartUploadStateResponseSchema.parse({ ok: true, data: state }));
  });

  app.post("/api/v1/media/:mediaId/multipart/:sessionId/complete", async (context) => {
    if (!dependencies.multipartMedia) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点确认上传分片",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    mediaMultipartCompleteRequestSchema.parse(body);
    const state = await dependencies.multipartMedia.complete(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      context.req.param("sessionId"),
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaMultipartCompleteResponseSchema.parse({ ok: true, data: state }));
  });

  app.delete("/api/v1/media/:mediaId/multipart/:sessionId", async (context) => {
    if (!dependencies.multipartMedia) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点取消上传分片",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    mediaMultipartAbortRequestSchema.parse(body);
    const state = await dependencies.multipartMedia.abort(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      context.req.param("sessionId"),
      projectId,
    );
    context.header("Cache-Control", "no-store");
    return context.json(mediaMultipartAbortResponseSchema.parse({ ok: true, data: state }));
  });

  app.post("/api/v1/media/:mediaId/provider-reference", async (context) => {
    if (
      !dependencies.generation?.createProviderReference &&
      (!dependencies.media || !dependencies.signedMedia)
    ) {
      return mediaUnavailable(context);
    }
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点创建素材引用",
      );
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = providerMediaReferenceRequestSchema.parse(body);
    const mediaId = context.req.param("mediaId");
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      input.projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;

    if (dependencies.generation?.createProviderReference) {
      const result = await dependencies.generation.createProviderReference(
        mediaAccess.ownerId,
        mediaId,
        input.kind,
        mediaAccess.token,
        input.projectId,
      );
      refreshIdentityCookie(context, identityCookie, result);
      context.header("Cache-Control", "private, no-store");
      return context.json(
        providerMediaReferenceResponseSchema.parse({ ok: true, data: result.data }),
      );
    }

    const media = await dependencies.media!.get(mediaAccess.ownerId, mediaId, input.projectId);
    if (media.status !== "ready" || media.kind !== input.kind) {
      return errorResponse(context, 409, "MEDIA_NOT_READY", "素材尚未准备完成或类型不匹配");
    }
    let url: string;
    try {
      url = dependencies.signedMedia!.createUrl(media.id, input.kind);
    } catch {
      return errorResponse(
        context,
        503,
        "REFERENCE_PUBLIC_URL_UNAVAILABLE",
        "公网素材地址尚未配置",
      );
    }
    context.header("Cache-Control", "private, no-store");
    return context.json(providerMediaReferenceResponseSchema.parse({ ok: true, data: { url } }));
  });

  app.get("/api/v1/media", async (context) => {
    if (!dependencies.cloudResources) return mediaUnavailable(context);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const quotaBytes = await resolveMediaQuotaBytes(
      context,
      dependencies,
      session.user.id,
      getCookie(context, identityCookie.name),
      identityCookie,
    );
    const result = await dependencies.cloudResources.list(session.user.id, quotaBytes);
    context.header("Cache-Control", "private, no-store");
    return context.json(cloudResourceListResponseSchema.parse({ ok: true, data: result }));
  });

  app.post("/api/v1/media/cleanup", async (context) => {
    if (!dependencies.cloudResources) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点清理素材");
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = cloudResourceCleanupRequestSchema.parse(body);
    const quotaBytes = await resolveMediaQuotaBytes(
      context,
      dependencies,
      session.user.id,
      getCookie(context, identityCookie.name),
      identityCookie,
    );
    const result = await dependencies.cloudResources.cleanup(
      session.user.id,
      input.mediaIds,
      quotaBytes,
      { forceUnbound: input.forceUnbound === true },
    );
    return context.json(cloudResourceCleanupResponseSchema.parse({ ok: true, data: result }));
  });

  app.delete("/api/v1/media/:mediaId", async (context) => {
    if (!dependencies.media) return mediaUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点删除素材");
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    try {
      const deleted = await dependencies.media.delete(
        mediaAccess.ownerId,
        context.req.param("mediaId"),
      );
      return context.json(mediaResponseSchema.parse({ ok: true, data: deleted }));
    } catch (error) {
      if (error instanceof MediaServiceError) {
        return errorResponse(context, error.status, error.code, error.message);
      }
      throw error;
    }
  });

  app.get("/api/v1/media/:mediaId", async (context) => {
    if (!dependencies.media) return mediaUnavailable(context);
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const media = await dependencies.media.get(
      mediaAccess.ownerId,
      context.req.param("mediaId"),
      projectId,
    );
    context.header("Cache-Control", "private, no-store");
    return context.json(mediaResponseSchema.parse({ ok: true, data: media }));
  });

  app.get("/api/v1/media/:mediaId/content", async (context) => {
    const mediaId = context.req.param("mediaId");
    if (
      !dependencies.media &&
      !(mediaId.startsWith("phm_") && dependencies.generation?.openMedia)
    ) {
      return mediaUnavailable(context);
    }
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const projectId = mediaProjectIdSchema.optional().parse(context.req.query("projectId"));
    const mediaAccess = await resolveProjectMediaAccess(
      context,
      dependencies,
      identityCookie,
      session.user.id,
      projectId,
    );
    if (mediaAccess instanceof Response) return mediaAccess;
    const download = context.req.query("download") === "1";
    // 画布节点内的展示图请求缩略变体；全屏预览、下载、离线落盘都不带此参数，仍取原图。
    const wantsThumb = context.req.query("variant") === "thumb";
    if (mediaId.startsWith("phm_") && dependencies.generation?.openMedia) {
      const result = await dependencies.generation.openMedia(
        mediaAccess.ownerId,
        mediaId,
        mediaAccess.token,
        context.req.header("Range"),
        projectId,
        context.req.raw.signal,
      );
      refreshIdentityCookie(context, identityCookie, result);
      return hostedMediaResponse(result.data);
    }
    if (!dependencies.media) return mediaUnavailable(context);
    const media = await dependencies.media.get(mediaAccess.ownerId, mediaId, projectId);
    if (media.status !== "ready")
      return errorResponse(context, 409, "MEDIA_NOT_READY", "素材尚未处理完成");
    if (wantsThumb && !download && media.kind === "image") {
      const thumb = await dependencies.media.openThumb(mediaAccess.ownerId, media.id, projectId);
      // 缩略响应附原始宽高：前端节点尺寸记录必须用原图宽高（缩略图是等比
      // 缩小，比例相同但绝对值不同，直接写入会让全屏缩放/元数据失真）。
      if (media.width && media.height) {
        context.header("X-Media-Original-Width", String(media.width));
        context.header("X-Media-Original-Height", String(media.height));
      }
      return mediaContentResponse(thumb, false);
    }
    let range: { start: number; end: number } | undefined;
    try {
      range = parseByteRange(context.req.header("Range"), media.size);
    } catch {
      context.header("Content-Range", `bytes */${media.size}`);
      return errorResponse(context, 416, "MEDIA_RANGE_INVALID", "请求的素材范围无效");
    }
    const direct = await dependencies.media.createPrivateDownload(
      mediaAccess.ownerId,
      media.id,
      projectId,
    );
    if (direct && !download) {
      context.header("Cache-Control", "private, no-store");
      return context.redirect(direct.url, 307);
    }
    const content = await dependencies.media.open(
      mediaAccess.ownerId,
      media.id,
      range,
      projectId,
      context.req.raw.signal,
    );
    return mediaContentResponse(content, range !== undefined, download);
  });

  app.get("/api/v1/provider-media/:mediaId/content", async (context) => {
    if (!dependencies.media || !dependencies.signedMedia)
      return errorResponse(context, 404, "NOT_FOUND", "没有找到这个接口");
    const parsedKind = mediaKindSchema.safeParse(context.req.query("kind"));
    if (
      !parsedKind.success ||
      !dependencies.signedMedia.verify(
        context.req.param("mediaId"),
        parsedKind.data,
        context.req.query("expires"),
        context.req.query("signature"),
      )
    )
      return errorResponse(context, 404, "MEDIA_NOT_FOUND", "没有找到这个素材");
    const media = await dependencies.media.getForSignedDelivery(
      context.req.param("mediaId"),
      parsedKind.data,
    );
    let range: { start: number; end: number } | undefined;
    try {
      range = parseByteRange(context.req.header("Range"), media.size);
    } catch {
      context.header("Content-Range", `bytes */${media.size}`);
      return errorResponse(context, 416, "MEDIA_RANGE_INVALID", "请求的素材范围无效");
    }
    const content = await dependencies.media.openForSignedDelivery(
      media.id,
      parsedKind.data,
      range,
    );
    return mediaContentResponse(content, range !== undefined);
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

function agentUnavailable(context: Context) {
  return errorResponse(context, 503, "AGENT_UNAVAILABLE", "Agent 服务暂未配置");
}

function connectorUnavailable(context: Context) {
  return errorResponse(context, 503, "CONNECTORS_UNAVAILABLE", "本机连接服务暂未配置");
}

const connectorConnectRequestSchema = z
  .object({
    /** Blender 接入时是否顺手把 Blender 启动起来。 */
    launch: z.boolean().optional(),
  })
  .strict();

const connectorPairingRequestSchema = z
  .object({
    connectorId: agentConnectorIdSchema,
  })
  .strict();

/** 运行时 → API：把一段 Python 派发到用户自己机器上的 Blender。 */
const blenderDispatchRequestSchema = z
  .object({
    ownerId: z.string().trim().min(1).max(128),
    code: z.string().trim().min(1).max(20_000),
  })
  .strict();

/** 定长比较，避免用字符串相等泄漏令牌。 */
function constantTimeEquals(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 外部客户端用 `Authorization: Bearer <配对令牌>` 鉴权。 */
function readBearerToken(header: string | undefined) {
  const value = header?.trim();
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function connectorFailure(context: Context, error: unknown) {
  if (error instanceof AgentExecutionError) {
    const status: ApiErrorStatus =
      error.code === "CONNECTOR_RUNTIME_UNAVAILABLE"
        ? 503
        : error.code === "CONNECTOR_INVALID_RESPONSE"
          ? 503
          : 422;
    return errorResponse(context, status, error.code, error.message);
  }
  return errorResponse(context, 503, "CONNECTORS_UNAVAILABLE", "本机连接服务暂时不可用");
}

function mediaUnavailable(context: Context) {
  return errorResponse(context, 503, "MEDIA_UNAVAILABLE", "素材服务暂未配置");
}

type ProjectMediaAccess = {
  ownerId: string;
  mediaStorageBytes?: number;
  token?: string;
};

async function resolveMediaQuotaBytes(
  context: Context,
  dependencies: ApiDependencies,
  ownerId: string,
  token: string | undefined,
  cookie: NonNullable<ApiDependencies["identityCookie"]>,
) {
  if (!dependencies.entitlements) return 0;
  const resolved = await dependencies.entitlements.resolve(ownerId, token);
  refreshIdentityCookie(context, cookie, resolved);
  return resolved.data.mediaStorageBytes;
}

async function resolveProjectMediaAccess(
  context: Context,
  dependencies: ApiDependencies,
  cookie: NonNullable<ApiDependencies["identityCookie"]>,
  actorId: string,
  projectId?: string,
): Promise<ProjectMediaAccess | Response> {
  const token = getCookie(context, cookie.name);
  if (!projectId) return { ownerId: actorId, token };
  if (!dependencies.projects?.resolveMediaAccess) return cloudProjectsUnavailable(context);

  const resolved = await dependencies.projects.resolveMediaAccess(actorId, projectId, token);
  refreshIdentityCookie(context, cookie, resolved);
  return {
    ...resolved.data,
    token: resolved.refreshedToken ?? token,
  };
}

function scopeMediaUploadIntent(intent: MediaUploadIntent, projectId?: string): MediaUploadIntent {
  if (!projectId || !intent.upload) return intent;
  if (intent.upload.strategy === "multipart") {
    return {
      ...intent,
      upload: {
        ...intent.upload,
        signPartsUrl: mediaProjectUrl(intent.upload.signPartsUrl, projectId),
        reconcileUrl: mediaProjectUrl(intent.upload.reconcileUrl, projectId),
        completeUrl: mediaProjectUrl(intent.upload.completeUrl, projectId),
        abortUrl: mediaProjectUrl(intent.upload.abortUrl, projectId),
      },
    };
  }
  return {
    ...intent,
    upload: {
      ...intent.upload,
      url: mediaProjectUrl(intent.upload.url, projectId),
      completeUrl: intent.upload.completeUrl
        ? mediaProjectUrl(intent.upload.completeUrl, projectId)
        : null,
    },
  };
}

function mediaProjectUrl(value: string, projectId?: string) {
  if (!projectId) return value;
  const internalOrigin = "http://canvas.internal";
  const url = new URL(value, internalOrigin);
  if (url.origin !== internalOrigin) return value;
  url.searchParams.set("projectId", projectId);
  return `${url.pathname}${url.search}${url.hash}`;
}

function cloudProjectsUnavailable(context: Context) {
  return errorResponse(
    context,
    503,
    "CLOUD_PROJECTS_UNAVAILABLE",
    "Cloud project storage is not configured",
  );
}

function collaborationUnavailable(context: Context) {
  return errorResponse(
    context,
    503,
    "COLLABORATION_UNAVAILABLE",
    "Project collaboration is not configured",
  );
}

function generationUnavailable(context: Context, message?: string) {
  return errorResponse(context, 503, "GENERATION_UNAVAILABLE", message || "生成服务暂未配置");
}

function setCloudProjectEtag(context: Context, projectId: string, revision: number) {
  context.header("ETag", `\"${projectId}:${revision}\"`);
}

function optionalProjectOwnerId(value: string | undefined) {
  return value === undefined ? undefined : cloudProjectPrincipalIdSchema.parse(value);
}

function generationEventId(jobId: string, version: number) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jobId) || !Number.isSafeInteger(version) || version < 0) {
    throw new Error("Generation event identity is invalid");
  }
  return `generation:${jobId}:${version}`;
}

function lastEventVersion(value: string | undefined, jobId: string, currentVersion: number) {
  if (!value) return -1;
  const prefix = `generation:${jobId}:`;
  if (!value.startsWith(prefix)) return -1;
  const version = Number(value.slice(prefix.length));
  return Number.isSafeInteger(version) && version >= 0 && version <= currentVersion ? version : -1;
}

type AgentAccess = {
  agent: AgentApi;
  ownerId: string;
  anonymous: boolean;
};

async function resolveAgentAccess(
  context: Context,
  dependencies: ApiDependencies,
  identityCookie: NonNullable<ApiDependencies["identityCookie"]>,
  _anonymousCookie: NonNullable<ApiDependencies["anonymousAgentCookie"]>,
): Promise<AgentAccess | Response> {
  const session = dependencies.identity
    ? await authenticateIdentity(context, dependencies.identity, identityCookie)
    : null;

  if (session && dependencies.agent) {
    return { agent: dependencies.agent, ownerId: session.user.id, anonymous: false };
  }
  if (session && dependencies.anonymousAgent) {
    return {
      agent: dependencies.anonymousAgent,
      ownerId: `account:${session.user.id}`,
      anonymous: false,
    };
  }
  // Agent 是付费能力：必须有登录会话，游客一律 401（不再签发匿名访客身份）。
  if (!dependencies.identity) return identityUnavailable(context);
  return errorResponse(context, 401, "UNAUTHENTICATED", "请先登录");
}

/** 取客户端标识：按部署的代理链依次看 CF / XFF / X-Real-IP，全部缺失时回落 anonymous。 */
/** socket 上的直连对端地址；没有 socket 的运行环境（测试直调 app.request）返回 undefined。 */
function remoteAddressOf(context: Context): string | undefined {
  const env = context.env as unknown as
    { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function isGenerationObservationTerminal(status: GenerationJobStatus) {
  return status === "completed" || status === "failed" || status === "submission_unknown";
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

function unwrapGenerationResult<T>(result: T | HostedGenerationResult<T>): T {
  return result && typeof result === "object" && !Array.isArray(result) && "data" in result
    ? (result as HostedGenerationResult<T>).data
    : (result as T);
}

function generationRefresh(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const value = result as { refreshedToken?: unknown; expiresAt?: unknown };
  return {
    ...(typeof value.refreshedToken === "string" ? { refreshedToken: value.refreshedToken } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
  };
}

function modelCatalogViewVersion(catalog: Pick<PublicModelCatalog, "models">) {
  return createHash("sha256")
    .update(JSON.stringify(catalog.models))
    .digest("base64url")
    .slice(0, 16);
}

/** 把聚合出的成功率合并进公共目录模型；无数据模型保持缺省 health。 */
function withModelHealth(models: PublicModel[], health: Map<string, ModelHealth> | undefined) {
  if (!health?.size) return models;
  return models.map((model) => {
    const stats = health.get(model.id);
    return stats ? { ...model, health: stats } : model;
  });
}

type ModelOverrideAdminRow = {
  id: string;
  label: string;
  description: string;
  modality: string;
  unit: string;
  pricingMode: string;
  creditsPerYuan: number;
  baseYuan: number | null;
  /** 当前 token 费率（元 / 百万 token）。 */
  inputYuanPerMillion: number | null;
  outputYuanPerMillion: number | null;
  resolutions: string[];
  /** false = 本地兼容占位（老项目可报价），不是 API 站上架模型。 */
  listed: boolean;
  hidden: boolean;
  yuan: number | null;
  byResolution: Record<string, number> | null;
  /** 自定义 token 费率（元 / 百万 token）。 */
  tokenInputYuanPerMillion: number | null;
  tokenOutputYuanPerMillion: number | null;
  /** 覆盖：站内显示名 / 简介 / 运营分区。 */
  displayName: string | null;
  overrideDescription: string | null;
  zone: "stable" | "promo" | null;
  /** 近 7 天真实成功率（0..1）与样本数；样本不足或无数据库为 null。 */
  healthSuccessRate: number | null;
  healthSamples: number | null;
};

export function modelOverrideAdminRows(
  models: readonly PublicModel[],
  overrides: ModelOverrides,
): ModelOverrideAdminRow[] {
  return models.map((model) => {
    const override = overrides.models[model.id];
    const resolutionParameter = model.parameters.find(
      (parameter) => parameter.name === "resolution",
    );
    const resolutions = resolutionParameter
      ? Array.isArray(resolutionParameter.options)
        ? resolutionParameter.options.filter(
            (option): option is string => typeof option === "string",
          )
        : typeof resolutionParameter.fixed === "string"
          ? [resolutionParameter.fixed]
          : []
      : [];
    return {
      id: model.id,
      label: model.label,
      description: model.description,
      modality: model.modality,
      unit: model.pricing.unit,
      pricingMode: model.pricing.mode,
      creditsPerYuan: model.pricing.creditsPerYuan,
      baseYuan:
        model.pricing.baseYuanMicros !== undefined
          ? model.pricing.baseYuanMicros / 1_000_000
          : null,
      inputYuanPerMillion:
        model.pricing.inputYuanMicrosPerMillion !== undefined
          ? model.pricing.inputYuanMicrosPerMillion / 1_000_000
          : null,
      outputYuanPerMillion:
        model.pricing.outputYuanMicrosPerMillion !== undefined
          ? model.pricing.outputYuanMicrosPerMillion / 1_000_000
          : null,
      resolutions,
      listed: model.listed !== false,
      hidden: override?.hidden === true,
      yuan: override?.price?.yuan ?? null,
      byResolution: override?.price?.byResolution ?? null,
      tokenInputYuanPerMillion: override?.price?.inputYuanPerMillion ?? null,
      tokenOutputYuanPerMillion: override?.price?.outputYuanPerMillion ?? null,
      displayName: override?.displayName ?? null,
      overrideDescription: override?.description ?? null,
      zone: override?.zone ?? null,
      healthSuccessRate: model.health?.successRate ?? null,
      healthSamples: model.health?.sampleCount ?? null,
    };
  });
}

/**
 * Self-contained operator page for the override API. It is served by the API
 * itself so an operator does not need a separate deploy; the shared secret is
 * held in sessionStorage and sent as the `x-model-overrides-secret` header.
 */
const MODEL_OVERRIDES_ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>画布模型上架与定价</title>
<style>
${ADMIN_THEME_CSS}
/* 本页专属：沿用本页既有类名，观感全部走共享 token（与 /admin/ops 同源）。 */
header.wc-model-header {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 9px 18px;
  background: var(--wc-surface);
  border-bottom: 1px solid var(--wc-border);
}
header.wc-model-header h1 { font-size: 15px; margin: 0 auto 0 0; font-weight: 600; }
main { padding: 14px 18px 64px; max-width: 1280px; margin: 0 auto; }
#status { font-size: 12px; color: var(--wc-text-tertiary); }
#msg { margin: 12px 0 0; font-size: 13px; min-height: 20px; color: var(--wc-text-tertiary); }
#msg.ok { color: var(--wc-success); }
#msg.err { color: var(--wc-danger); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--wc-border); vertical-align: middle; }
th { position: sticky; top: 52px; z-index: 1; background: var(--wc-surface); font-size: 11px; color: var(--wc-text-tertiary); font-weight: 500; }
td { font-variant-numeric: tabular-nums; }
td.id code { font-size: 11.5px; color: var(--wc-text-secondary); font-family: ui-monospace, "SF Mono", Consolas, monospace; }
td .label { display: block; font-size: 12px; color: var(--wc-text-tertiary); }
.muted { color: var(--wc-text-tertiary); font-size: 12px; }
.price-input { width: 94px; }
.hidden-row td { opacity: .5; }
.badge {
  display: inline-block; padding: 0 6px; margin-left: 4px; border-radius: 3px; font-size: 11px;
  line-height: 16px; border: 1px solid var(--wc-border-strong); color: var(--wc-text-secondary);
}
.badge.badge-promo { background: var(--wc-amber-soft); border-color: transparent; color: var(--wc-amber); }
#filters { display: flex; gap: 8px; margin: 14px 0 10px; flex-wrap: wrap; align-items: center; }
#filters input[type=text] { flex: 1; min-width: 180px; }
#filters label { color: var(--wc-text-tertiary); font-size: 12px; }
.token-inputs { display: flex; gap: 4px; }
.token-inputs .price-input { width: 84px; }
.hint { color: var(--wc-text-tertiary); font-size: 12px; margin: 12px 0 0; max-width: 980px; }
.zone-input { width: 108px; }
.name-input { width: 100%; margin-bottom: 4px; }
.desc-input { width: 100%; font-size: 12px; }
.health-good { color: var(--wc-success); font-weight: 600; }
.health-mid { color: var(--wc-amber); font-weight: 600; }
.health-low { color: var(--wc-danger); font-weight: 600; }
@media (max-width: 720px) {
  header.wc-model-header { padding: 8px 14px; }
  main { padding: 12px 14px 48px; }
}
</style>
<script>${ADMIN_THEME_BOOT_JS}</script>
</head>
<body>
<header class="wc-model-header">
  <h1>画布模型上架与定价</h1>
  <input id="secret" type="password" placeholder="管理密钥" style="width:200px">
  <button id="load" class="wc-btn wc-btn-primary">加载</button>
  <button id="save" class="wc-btn wc-btn-primary" disabled>保存</button>
  <span id="status"></span>
  <div class="wc-seg" role="group" aria-label="配色">
    <button type="button" data-wc-theme-set="light" title="石墨（亮色）">石墨</button>
    <button type="button" data-wc-theme-set="dark" title="墨黑（暗色）">墨黑</button>
  </div>
</header>
<main>
  <div id="msg"></div>
  <p class="hint">列表来自上游目录（含所有可接模型）。<b>展示</b>取消勾选 = 下架，画布与 Agent 都不再出现；<b>自定义价</b>留空则沿用上游价，Token 模型按「元 / 百万 token」填输入与输出费率，其余模型按每条/张/秒填单个价格。<b>分区</b>决定模型出现在「稳定主推」还是「特惠」选择区：特惠区模型面向用户时明确标注「随时可能下架、不保证可用性与成功率」，只放中转渠道等不稳定模型，主推与默认选中始终是稳定区。<b>显示名/简介</b>只改站内文案（对外不出现上游原始模型名），不影响路由与计费。</p>
  <div id="filters">
    <input id="search" placeholder="筛选模型 id / 名称">
    <select id="modality">
      <option value="">全部类型</option>
      <option value="text">文本</option>
      <option value="image">图片</option>
      <option value="video">视频</option>
      <option value="audio">音频</option>
    </select>
    <label class="muted"><input type="checkbox" id="onlyHidden"> 只看已下架</label>
    <label class="muted"><input type="checkbox" id="onlyPromo"> 只看特惠区</label>
  </div>
  <table>
    <thead><tr>
      <th style="width:24%">模型</th><th>类型</th><th style="width:96px">成功率(7天)</th><th>分辨率</th><th style="width:180px">当前价</th><th style="width:170px">自定义价（元）</th><th style="width:110px">分区</th><th style="width:200px">显示名 / 简介</th><th style="width:64px">展示</th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="9" class="muted">输入密钥后点「加载」</td></tr></tbody>
  </table>
</main>
<script>
(function () {
  var SECRET_KEY = 'canvas_model_overrides_secret_v1';
  var state = { models: [], overrides: { models: {} } };
  var $ = function (id) { return document.getElementById(id); };
  function setMsg(text, ok) { var el = $('msg'); el.textContent = text || ''; el.className = text ? (ok ? 'ok' : 'err') : ''; }
  function secret() { return $('secret').value.trim(); }
  function headers() { return { 'Content-Type': 'application/json', 'x-model-overrides-secret': secret() }; }
  function parse(v) { var n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }
  function fmtYuan(v) { return v === null || v === undefined ? '—' : String(Number(Number(v).toFixed(4))); }
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function unitSuffix(unit) { return unit === 'image' ? '张' : unit === 'second' ? '秒' : '次'; }
  function healthCell(m) {
    if (m.healthSuccessRate === null || m.healthSuccessRate === undefined) return '<span class="muted">—</span>';
    var pct = Math.round(m.healthSuccessRate * 100);
    var cls = pct >= 90 ? 'health-good' : pct >= 70 ? 'health-mid' : 'health-low';
    return '<span class="' + cls + '">' + pct + '%</span> <span class="muted">(' + m.healthSamples + ')</span>';
  }
  function currentPrice(row) {
    if (row.pricingMode === 'token') {
      return '入 ¥' + fmtYuan(row.inputYuanPerMillion) + '/M · 出 ¥' + fmtYuan(row.outputYuanPerMillion) + '/M';
    }
    if (row.byResolution) return Object.keys(row.byResolution).sort().map(function (r) { return esc(r.toUpperCase()) + ' ' + row.byResolution[r]; }).join(' / ');
    if (row.yuan !== null) return String(row.yuan) + ' 元/' + unitSuffix(row.unit);
    if (row.baseYuan !== null) return fmtYuan(row.baseYuan) + ' 元/' + unitSuffix(row.unit);
    return '—';
  }
  function render() {
    var q = $('search').value.trim().toLowerCase();
    var modality = $('modality').value;
    var onlyHidden = $('onlyHidden').checked;
    var onlyPromo = $('onlyPromo').checked;
    var body = $('rows');
    var list = state.models.filter(function (m) {
      if (modality && m.modality !== modality) return false;
      var isPromo = state.overrides.models[m.id] && state.overrides.models[m.id].zone === 'promo';
      if (onlyHidden && !(state.overrides.models[m.id] && state.overrides.models[m.id].hidden === true)) return false;
      if (onlyPromo && !isPromo) return false;
      if (!q) return true;
      return (m.id + ' ' + m.label).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) { body.innerHTML = '<tr><td colspan="9" class="muted">没有匹配的模型</td></tr>'; return; }
    body.innerHTML = list.map(function (m) {
      var o = state.overrides.models[m.id] || {};
      var hidden = o.hidden === true;
      var isPromo = o.zone === 'promo';
      var tokenPrice = o.price || {};
      var res = (m.resolutions && m.resolutions.length ? m.resolutions.map(function (r) { return esc(r); }).join(' / ') : '—');
      var priceCell;
      if (m.pricingMode === 'token') {
        priceCell = '<div class="token-inputs">' +
          '<input class="price-input" data-field="tokenIn" type="number" min="0" step="0.01" placeholder="入 元/M" value="' + (tokenPrice.inputYuanPerMillion !== undefined && tokenPrice.inputYuanPerMillion !== null ? String(tokenPrice.inputYuanPerMillion) : '') + '">' +
          '<input class="price-input" data-field="tokenOut" type="number" min="0" step="0.01" placeholder="出 元/M" value="' + (tokenPrice.outputYuanPerMillion !== undefined && tokenPrice.outputYuanPerMillion !== null ? String(tokenPrice.outputYuanPerMillion) : '') + '">' +
          '</div>';
      } else {
        var custom = o.price && o.price.yuan !== undefined && o.price.yuan !== null ? String(o.price.yuan) : (o.price && o.price.byResolution ? '' : '');
        priceCell = '<input class="price-input" data-field="price" type="number" min="0" step="0.001" placeholder="不改" value="' + custom + '">';
      }
      var shownLabel = o.displayName || m.label;
      return '<tr data-id="' + esc(m.id) + '"' + (hidden ? ' class="hidden-row"' : '') + '>' +
        '<td class="id"><code>' + esc(m.id) + '</code><span class="label">' + esc(shownLabel) + (isPromo ? ' <span class="badge badge-promo">特惠</span>' : '') + '</span></td>' +
        '<td>' + m.modality + ' · ' + m.unit + (m.listed === false ? ' <span class="badge">兼容项</span>' : '') + '</td>' +
        '<td>' + healthCell(m) + '</td>' +
        '<td class="muted">' + res + '</td>' +
        '<td>' + currentPrice(m) + (o.price && o.price.byResolution ? ' <span class="badge">分档</span>' : '') + (tokenPrice.inputYuanPerMillion !== undefined || tokenPrice.outputYuanPerMillion !== undefined ? ' <span class="badge">已改</span>' : '') + '</td>' +
        '<td>' + priceCell + '</td>' +
        '<td><select class="zone-input" data-field="zone" title="特惠区：随时可能下架、不保证可用性与成功率">' +
          '<option value=""' + (!isPromo ? ' selected' : '') + '>稳定主推</option>' +
          '<option value="promo"' + (isPromo ? ' selected' : '') + '>特惠</option>' +
        '</select></td>' +
        '<td><input class="name-input" data-field="displayName" type="text" maxlength="60" placeholder="不改名（' + esc(shownLabel) + '）" title="站内显示名；留空沿用上游名称" value="' + esc(o.displayName || '') + '">' +
          '<input class="desc-input" data-field="description" type="text" maxlength="400" placeholder="不改简介" title="站内简介文案；留空沿用上游描述" value="' + esc(o.description || '') + '"></td>' +
        '<td><input data-field="visible" type="checkbox"' + (hidden ? '' : ' checked') + '></td>' +
      '</tr>';
    }).join('');
  }
  function collect() {
    var models = {};
    state.models.forEach(function (m) {
      // data-id 在 render() 里经过 esc()，这里必须用同一转义才能选回同一行。
      var tr = $('rows').querySelector('tr[data-id="' + esc(m.id) + '"]');
      var existing = state.overrides.models[m.id] || {};
      var entry = {};
      var visible;
      var price = null;
      if (tr) {
        visible = tr.querySelector('[data-field=visible]').checked;
        if (m.pricingMode === 'token') {
          var tokenIn = tr.querySelector('[data-field=tokenIn]');
          var tokenOut = tr.querySelector('[data-field=tokenOut]');
          var inValue = tokenIn ? parse(tokenIn.value.trim()) : null;
          var outValue = tokenOut ? parse(tokenOut.value.trim()) : null;
          if (inValue !== null || outValue !== null) {
            price = {};
            if (inValue !== null) price.inputYuanPerMillion = inValue;
            if (outValue !== null) price.outputYuanPerMillion = outValue;
          }
        } else {
          var priceInput = tr.querySelector('[data-field=price]');
          price = priceInput ? parse(priceInput.value.trim()) : null;
        }
        var zoneSelect = tr.querySelector('[data-field=zone]');
        var zone = zoneSelect ? zoneSelect.value : '';
        var displayName = tr.querySelector('[data-field=displayName]');
        var nameValue = displayName ? displayName.value.trim() : '';
        var descriptionInput = tr.querySelector('[data-field=description]');
        var descriptionValue = descriptionInput ? descriptionInput.value.trim() : '';
      } else {
        visible = existing.hidden !== true;
        if (m.pricingMode === 'token') {
          price = existing.price && (existing.price.inputYuanPerMillion !== undefined || existing.price.outputYuanPerMillion !== undefined) ? existing.price : null;
        } else {
          price = existing.price && existing.price.yuan !== undefined ? existing.price.yuan : null;
        }
        var zone = existing.zone === 'promo' ? 'promo' : '';
        var nameValue = existing.displayName || '';
        var descriptionValue = existing.description || '';
      }
      if (!visible) entry.hidden = true;
      if (price !== null) entry.price = m.pricingMode === 'token' ? price : { yuan: price };
      else if (existing.price && existing.price.byResolution) entry.price = { byResolution: existing.price.byResolution };
      if (existing.sortOrder !== undefined) entry.sortOrder = existing.sortOrder;
      if (zone === 'promo') entry.zone = 'promo';
      if (nameValue) entry.displayName = nameValue;
      if (descriptionValue) entry.description = descriptionValue;
      if (Object.keys(entry).length) models[m.id] = entry;
    });
    return { models: models };
  }
  function load() {
    if (!secret()) { setMsg('请先填写管理密钥', false); return; }
    setMsg('加载中…', true);
    fetch('/api/v1/admin/model-overrides', { headers: headers(), cache: 'no-store' }).then(function (res) {
      return res.json().then(function (json) { if (!res.ok || !json.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status)); return json.data; });
    }).then(function (data) {
      sessionStorage.setItem(SECRET_KEY, secret());
      state = data;
      $('save').disabled = false;
      setMsg('已加载 ' + data.models.length + ' 个模型' + (Object.keys(data.overrides.models || {}).length ? '（' + Object.keys(data.overrides.models).length + ' 条覆盖）' : ''), true);
      render();
    }).catch(function (e) { setMsg('加载失败：' + e.message, false); });
  }
  function save() {
    if (!secret()) { setMsg('请先填写管理密钥', false); return; }
    setMsg('保存中…', true);
    fetch('/api/v1/admin/model-overrides', { method: 'PUT', headers: headers(), body: JSON.stringify(collect()) }).then(function (res) {
      return res.json().then(function (json) { if (!res.ok || !json.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status)); return json.data; });
    }).then(function (data) {
      state = data;
      setMsg('已保存，画布模型面板将在下次目录刷新后生效', true);
      render();
    }).catch(function (e) { setMsg('保存失败：' + e.message, false); });
  }
  $('secret').value = sessionStorage.getItem(SECRET_KEY) || '';
  $('load').addEventListener('click', load);
  $('save').addEventListener('click', save);
  $('search').addEventListener('input', render);
  $('modality').addEventListener('change', render);
  $('onlyHidden').addEventListener('change', render);
  $('onlyPromo').addEventListener('change', render);
})();
</script>
</body>
</html>`;

function hostedMediaResponse(upstream: Response) {
  const headers = new Headers({
    "Cache-Control": "private, no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of ["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

function readContentLength(value: string | undefined) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value))
    throw new MediaServiceError("MEDIA_SIZE_INVALID", "上传内容大小无效", 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new MediaServiceError("MEDIA_SIZE_INVALID", "上传内容大小无效", 400);
  return parsed;
}

function parseByteRange(value: string | undefined, size: number) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new RangeError("Invalid byte range");
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError("Invalid byte range");
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    throw new RangeError("Invalid byte range");
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function mediaContentResponse(
  content: Awaited<ReturnType<MediaService["open"]>>,
  partial: boolean,
  download = false,
) {
  const { object } = content;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store, no-transform",
    "Content-Length": String(object.end - object.start + 1),
    "Content-Type": content.media.mimeType,
    "X-Content-Type-Options": "nosniff",
  });
  if (partial)
    headers.set("Content-Range", `bytes ${object.start}-${object.end}/${object.totalSize}`);
  if (download) headers.set("Content-Disposition", downloadContentDisposition(content.media.name));
  return new Response(Readable.toWeb(object.stream) as ReadableStream<Uint8Array>, {
    status: partial ? 206 : 200,
    headers,
  });
}

function downloadContentDisposition(name: string) {
  const value = name.trim() || "download";
  const fallback = value.replace(/[^\x20-\x7e]|[\\\"]/g, "_");
  if (fallback === value) return `attachment; filename="${fallback}"`;
  return `attachment; filename="${fallback || "download"}"; filename*=UTF-8''${encodeURIComponent(value)}`;
}

// 既有导入路径保持不变：身份会话的 HTTP 门仍然从 app.ts 可用。
export { refreshIdentityCookie, requireIdentitySession } from "./identity/http-session.js";
