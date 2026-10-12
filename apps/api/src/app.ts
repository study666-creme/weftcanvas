import {
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
  apiErrorSchema,
  generationJobEventSchema,
  generationJobListResponseSchema,
  generationJobReconcileQuerySchema,
  generationJobResponseSchema,
  generationQuoteResponseSchema,
  identityLogoutResponseSchema,
  identityRegistrationResponseSchema,
  identitySessionResponseSchema,
  identitySessionStateResponseSchema,
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
  membershipTaskActionResponseSchema,
  membershipTaskCenterResponseSchema,
  membershipTaskKeySchema,
  musicLinkResolveResponseSchema,
  providerMediaReferenceRequestSchema,
  providerMediaReferenceResponseSchema,
  modelCatalogResponseSchema,
  modelModalitySchema,
  walletCheckoutRequestSchema,
  walletCheckoutResponseSchema,
  walletLedgerResponseSchema,
  walletOrderResponseSchema,
  walletProductsResponseSchema,
  walletRedeemRequestSchema,
  walletRedeemResponseSchema,
  walletResponseSchema,
  type GenerationJobStatus,
  type MediaUploadIntent,
  type MusicLinkResolveData,
  type MusicLinkSource,
  type PublicGenerationJob,
  type PublicModel,
  type PublicModelCatalog,
} from "@weftcanvas/contracts";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
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
import { toPublicCatalogView } from "./catalog/public-view.js";
import { GenerationQuoteService, QuoteValidationError } from "./catalog/quote.js";
import type { ApiReadinessProbe } from "./database/readiness.js";
import {
  IdentityProviderError,
  type IdentityProvider,
  type IdentityRegistrationResult,
  type IssuedIdentitySession,
} from "./identity/provider.js";
import { GenerationApiGuard, GenerationApiLimitError } from "./generation/api-rate-limit.js";
import { GenerationJobServiceError } from "./generation/service.js";
import type { HostedGenerationResult } from "./generation/hosted-result.js";
import { MediaService, MediaServiceError } from "./media/service.js";
import type { CloudResourceService } from "./media/cloud-resource-service.js";
import type { MediaMultipartService } from "./media/multipart-service.js";
import { SignedMediaAccess } from "./media/signed-access.js";
import { isBlockedTargetUrl } from "./identity/safe-host.js";
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
  media?: MediaService;
  cloudResources?: CloudResourceService;
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
};

const DEFAULT_IDENTITY_COOKIE = { name: "weftcanvas_session", secure: false } as const;
const DEFAULT_ANONYMOUS_AGENT_COOKIE = {
  name: "weftcanvas_agent_guest",
  secure: false,
} as const;
const MEDIA_PROXY_MAX_REDIRECT_HOPS = 5;
// 音乐链接代拉：流式播放不能整段限时（一首歌 3-5 分钟），超时只管连接与取头；
// 大小上限与本地上传音频一致（100MB）。
const MUSIC_RESOLVE_TIMEOUT_MS = 15_000;
const MUSIC_COVER_TIMEOUT_MS = 30_000;
const MUSIC_PAGE_MAX_BYTES = 512 * 1024;
const MUSIC_STREAM_MAX_BYTES = 100 * 1024 * 1024;
const MUSIC_COVER_MAX_BYTES = 10 * 1024 * 1024;
const MUSIC_AUDIO_URL_PATTERN = /\.(mp3|flac|wav|wave|ogg|oga|m4a|aac|opus|weba)$/i;
const MUSIC_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function createApiApp(dependencies: ApiDependencies) {
  const app = new Hono();
  const identityCookie = dependencies.identityCookie ?? DEFAULT_IDENTITY_COOKIE;
  const anonymousAgentCookie = dependencies.anonymousAgentCookie ?? DEFAULT_ANONYMOUS_AGENT_COOKIE;
  const anonymousAgentGuard = new AnonymousAgentGuard(dependencies.anonymousAgentLimits);
  const sensitiveActionGuard = new SensitiveActionGuard();

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

  app.get("/api/health", (context) => context.json({ ok: true, service: "canvas-api" }));

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
  app.get("/api/v1/music/resolve", async (context) => {
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const input = z.object({ url: z.string().trim().min(1).max(2_048) }).parse(context.req.query());
    let target: URL;
    try {
      target = normalizeMusicInputUrl(input.url);
    } catch {
      return errorResponse(
        context,
        400,
        "INVALID_MUSIC_URL",
        "链接格式不对，请粘贴完整的网页或音频地址",
      );
    }
    const blocked = await isBlockedTargetUrl(target.toString());
    if (blocked) return errorResponse(context, 400, "MUSIC_URL_BLOCKED", "该链接不可用");
    const source = detectMusicSource(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MUSIC_RESOLVE_TIMEOUT_MS);
    try {
      const data = await resolveMusicLink({ target, source, signal: controller.signal });
      return context.json(musicLinkResolveResponseSchema.parse({ ok: true, data }));
    } catch (error) {
      if (error instanceof MusicProxyError)
        return errorResponse(context, error.status, error.code, error.message);
      if (error instanceof Error && error.name === "AbortError") {
        return errorResponse(context, 503, "MUSIC_RESOLVE_TIMEOUT", "链接解析超时，请稍后再试");
      }
      return errorResponse(context, 503, "MUSIC_RESOLVE_FAILED", "暂时无法读取这个链接");
    } finally {
      clearTimeout(timer);
    }
  });

  // 音频流代理：逐跳 SSRF 守卫 + 内容类型门槛 + 非分片请求做音频魔数嗅探；
  // Range 透传（<audio> 的拖动进度条依赖 206），响应头只保留必要字段。
  app.get("/api/v1/music/stream", async (context) => {
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const input = z.object({ u: z.string().url().max(2_048) }).parse(context.req.query());
    const range = context.req.header("range");
    // 连接/取头限时；头回来即解除（流式播放不能整段限时），客户端断开由
    // 流包装的 cancel() 传播给上游，不悬挂连接。
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), MUSIC_RESOLVE_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await musicGuardedFetch(input.u, {
        accept: "audio/*,*/*;q=0.5",
        signal: controller.signal,
        range,
      });
    } catch (error) {
      if (error instanceof MusicProxyError)
        return errorResponse(context, error.status, error.code, error.message);
      if (error instanceof Error && error.name === "AbortError") {
        return errorResponse(context, 503, "MUSIC_STREAM_TIMEOUT", "音频源连接超时");
      }
      return errorResponse(context, 503, "MUSIC_STREAM_FAILED", "音频暂时无法读取");
    } finally {
      clearTimeout(connectTimer);
    }
    if (!upstream.ok && upstream.status !== 206) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(context, 503, "MUSIC_STREAM_UNAVAILABLE", "音频源没有返回内容");
    }
    const declaredType =
      (upstream.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";
    let audioExtension = false;
    try {
      audioExtension = MUSIC_AUDIO_URL_PATTERN.test(new URL(input.u).pathname);
    } catch {
      audioExtension = false;
    }
    const declaredAudio =
      declaredType.startsWith("audio/") ||
      declaredType === "application/ogg" ||
      (declaredType === "application/octet-stream" && audioExtension);
    if (!declaredAudio) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(context, 415, "MUSIC_NOT_AUDIO", "这个地址不是音频内容");
    }
    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > MUSIC_STREAM_MAX_BYTES) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(context, 413, "MUSIC_TOO_LARGE", "音频文件过大");
    }
    if (!upstream.body)
      return errorResponse(context, 503, "MUSIC_STREAM_FAILED", "音频暂时无法读取");

    const headers = new Headers();
    headers.set("Content-Type", declaredType || "audio/mpeg");
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "none");
    for (const header of ["content-length", "content-range"]) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }

    if (upstream.status === 200 && !range) {
      // 全量响应：先嗅探前 768 字节确认真的是音频，再把已读字节拼回流前面。
      const reader = upstream.body.getReader();
      const head: Uint8Array[] = [];
      let headBytes = 0;
      while (headBytes < 768) {
        const { done, value } = await reader.read();
        if (done) break;
        head.push(value);
        headBytes += value.length;
      }
      if (!sniffAudioBytes(concatBytes(head))) {
        await reader.cancel().catch(() => undefined);
        return errorResponse(context, 415, "MUSIC_NOT_AUDIO", "这个地址不是可播放的音频");
      }
      let totalBytes = headBytes;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          for (const chunk of head) streamController.enqueue(chunk);
        },
        async pull(streamController) {
          const { done, value } = await reader.read();
          if (done) {
            streamController.close();
            return;
          }
          totalBytes += value.length;
          if (totalBytes > MUSIC_STREAM_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            streamController.error(new Error("MUSIC_TOO_LARGE"));
            return;
          }
          streamController.enqueue(value);
        },
        async cancel() {
          await reader.cancel().catch(() => undefined);
        },
      });
      return new Response(body, { status: 200, headers });
    }

    // Range 请求（或上游分片响应）：透传字节，counting 包装防止无上限拉取。
    const reader = upstream.body.getReader();
    let totalBytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        const { done, value } = await reader.read();
        if (done) {
          streamController.close();
          return;
        }
        totalBytes += value.length;
        if (totalBytes > MUSIC_STREAM_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          streamController.error(new Error("MUSIC_TOO_LARGE"));
          return;
        }
        streamController.enqueue(value);
      },
      async cancel() {
        await reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, { status: upstream.status, headers });
  });

  // 封面代理：与音频同一套守卫，仅允许图片内容类型，供外链卡片展示。
  app.get("/api/v1/music/cover", async (context) => {
    const session = await requireIdentitySession(context, dependencies.identity, identityCookie);
    if (session instanceof Response) return session;
    const input = z.object({ u: z.string().url().max(2_048) }).parse(context.req.query());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MUSIC_COVER_TIMEOUT_MS);
    try {
      const upstream = await musicGuardedFetch(input.u, {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        signal: controller.signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        return errorResponse(context, 503, "MUSIC_COVER_UNAVAILABLE", "封面暂时无法读取");
      }
      const contentType =
        (upstream.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
        await upstream.body?.cancel().catch(() => undefined);
        return errorResponse(context, 415, "MUSIC_NOT_IMAGE", "封面地址不是图片内容");
      }
      const contentLength = Number(upstream.headers.get("content-length") || 0);
      if (contentLength > MUSIC_COVER_MAX_BYTES) {
        await upstream.body?.cancel().catch(() => undefined);
        return errorResponse(context, 413, "MUSIC_COVER_TOO_LARGE", "封面图片过大");
      }
      const headers = new Headers();
      headers.set("Content-Type", contentType || "image/jpeg");
      headers.set("Cache-Control", "private, max-age=3600");
      headers.set("X-Content-Type-Options", "nosniff");
      if (contentLength) headers.set("Content-Length", String(contentLength));
      return new Response(upstream.body, { status: 200, headers });
    } catch (error) {
      if (error instanceof MusicProxyError)
        return errorResponse(context, error.status, error.code, error.message);
      if (error instanceof Error && error.name === "AbortError") {
        return errorResponse(context, 503, "MUSIC_COVER_TIMEOUT", "封面下载超时");
      }
      return errorResponse(context, 503, "MUSIC_COVER_FAILED", "封面暂时无法读取");
    } finally {
      clearTimeout(timer);
    }
  });

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
    const data = modality?.success
      ? { ...catalog, models: catalog.models.filter((model) => model.modality === modality.data) }
      : catalog;
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
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      data: { overrides, models: modelOverrideAdminRows(catalog.models, overrides) },
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

  app.post("/api/v1/auth/register", async (context) => {
    if (!dependencies.identity) return identityUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交账号请求",
      );
    }
    const registerLimited = sensitiveActionGuard.consume(
      `register:${clientIdentifier(context)}`,
      10,
      60 * 60_000,
    );
    if (registerLimited) return rateLimitedResponse(context, registerLimited);
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    let result: IdentityRegistrationResult;
    try {
      result = await dependencies.identity.register(body);
    } catch (error) {
      const rejected = identityRequestErrorResponse(context, "register", error);
      if (rejected) return rejected;
      throw error;
    }
    if (result.status === "authenticated") {
      setIdentityCookie(context, identityCookie, result.session);
      return context.json(
        identityRegistrationResponseSchema.parse({
          ok: true,
          status: "authenticated",
          data: publicIssuedSession(result.session),
          capabilities: identityCapabilities(dependencies.identity),
        }),
        201,
      );
    }
    return context.json(
      identityRegistrationResponseSchema.parse({
        ok: true,
        status: "verification_required",
        data: { email: result.email },
        capabilities: identityCapabilities(dependencies.identity),
      }),
      201,
    );
  });

  app.post("/api/v1/auth/login", async (context) => {
    if (!dependencies.identity) return identityUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交登录请求",
      );
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    // 登录撞库面：按 IP+邮箱 每 10 次/分钟，另按邮箱 30 次/5 分钟（防换 IP 打同一账号）。
    const loginEmail =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { email?: unknown }).email === "string"
        ? (body as { email: string }).email.trim().toLowerCase()
        : "";
    const loginLimited =
      sensitiveActionGuard.consume(
        `login:${clientIdentifier(context)}:${loginEmail}`,
        10,
        60_000,
      ) ?? sensitiveActionGuard.consume(`login-email:${loginEmail}`, 30, 5 * 60_000);
    if (loginLimited) return rateLimitedResponse(context, loginLimited);
    let issued: IssuedIdentitySession;
    try {
      issued = await dependencies.identity.login(body);
    } catch (error) {
      const rejected = identityRequestErrorResponse(context, "login", error);
      if (rejected) return rejected;
      throw error;
    }
    setIdentityCookie(context, identityCookie, issued);
    return context.json(
      identitySessionResponseSchema.parse({
        ok: true,
        data: publicIssuedSession(issued),
        capabilities: identityCapabilities(dependencies.identity),
      }),
    );
  });

  app.get("/api/v1/auth/session", async (context) => {
    if (!dependencies.identity) {
      return context.json(
        identitySessionStateResponseSchema.parse({
          ok: true,
          data: null,
          capabilities: identityCapabilities(undefined),
        }),
      );
    }
    const session = await authenticateIdentity(context, dependencies.identity, identityCookie);
    return context.json(
      identitySessionStateResponseSchema.parse({
        ok: true,
        data: session,
        capabilities: identityCapabilities(dependencies.identity),
      }),
    );
  });

  app.post("/api/v1/auth/logout", async (context) => {
    if (!dependencies.identity) return identityUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交退出请求",
      );
    }
    try {
      await dependencies.identity.logout(getCookie(context, identityCookie.name));
    } finally {
      // Never leave a locally valid cookie behind when upstream revocation fails.
      clearIdentityCookie(context, identityCookie);
    }
    return context.json(identityLogoutResponseSchema.parse({ ok: true }));
  });

  app.get("/api/v1/wallet", async (context) => {
    if (!dependencies.wallet) return walletUnavailable(context);
    const result = await dependencies.wallet.getSummary(getCookie(context, identityCookie.name));
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(walletResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.get("/api/v1/wallet/ledger", async (context) => {
    if (!dependencies.wallet) return walletUnavailable(context);
    const limit = optionalQueryInteger(context, context.req.query("limit"), 20);
    if (limit instanceof Response) return limit;
    if (limit < 1 || limit > 50)
      return errorResponse(context, 400, "INVALID_LIMIT", "积分流水数量范围不正确");
    const result = await dependencies.wallet.getLedger(
      getCookie(context, identityCookie.name),
      limit,
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      walletLedgerResponseSchema.parse({ ok: true, data: { items: result.data } }),
    );
  });

  app.get("/api/v1/wallet/products", async (context) => {
    if (!dependencies.wallet) return walletUnavailable(context);
    const result = await dependencies.wallet.getProducts(getCookie(context, identityCookie.name));
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      walletProductsResponseSchema.parse({
        ok: true,
        data: result.data.products,
        customCreditTopUp: result.data.customCreditTopUp,
      }),
    );
  });

  app.get("/api/v1/membership/tasks", async (context) => {
    if (!dependencies.membershipTasks) return walletUnavailable(context);
    const result = await dependencies.membershipTasks.getMembershipTasks(
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    context.header("Cache-Control", "private, no-store");
    return context.json(membershipTaskCenterResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/membership/tasks/canvas-create-node", async (context) => {
    if (!dependencies.membershipTasks) return walletUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交画布任务",
      );
    }
    // 事件没有服务端完成条件校验，只能靠限速挡住脚本化刷进度。
    const eventLimited = sensitiveActionGuard.consume(
      `canvas-node-event:${clientIdentifier(context)}`,
      20,
      60_000,
    );
    if (eventLimited) return rateLimitedResponse(context, eventLimited);
    const result = await dependencies.membershipTasks.recordCanvasNodeCreated(
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    context.header("Cache-Control", "private, no-store");
    return context.json(membershipTaskActionResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/membership/tasks/:taskKey/claim", async (context) => {
    if (!dependencies.membershipTasks) return walletUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点领取任务奖励",
      );
    }
    const taskKey = membershipTaskKeySchema.parse(context.req.param("taskKey"));
    // taskKey 本身是个可枚举空间：按 IP+key 限速，压住批量试探。
    const claimLimited = sensitiveActionGuard.consume(
      `task-claim:${clientIdentifier(context)}:${taskKey.toLowerCase()}`,
      10,
      60_000,
    );
    if (claimLimited) return rateLimitedResponse(context, claimLimited);
    const result = await dependencies.membershipTasks.claimMembershipTask(
      getCookie(context, identityCookie.name),
      taskKey,
    );
    refreshIdentityCookie(context, identityCookie, result);
    context.header("Cache-Control", "private, no-store");
    return context.json(membershipTaskActionResponseSchema.parse({ ok: true, data: result.data }));
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

  app.post("/api/v1/wallet/checkout", async (context) => {
    if (!dependencies.wallet) return walletUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点创建充值订单",
      );
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = walletCheckoutRequestSchema.parse(body);
    const result = await dependencies.wallet.createCheckout(
      getCookie(context, identityCookie.name),
      input,
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(walletCheckoutResponseSchema.parse({ ok: true, data: result.data }), 201);
  });

  app.get("/api/v1/wallet/orders/:orderNo", async (context) => {
    if (!dependencies.wallet) return walletUnavailable(context);
    const result = await dependencies.wallet.getOrder(
      getCookie(context, identityCookie.name),
      context.req.param("orderNo"),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(walletOrderResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/wallet/redeem", async (context) => {
    if (!dependencies.wallet) return walletUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, dependencies.allowedOrigins)) {
      return errorResponse(context, 403, "CROSS_SITE_REQUEST_REJECTED", "无法从其他站点兑换激活码");
    }
    // 兑换码是低熵 secret：按 IP 限速，降低暴力枚举的速度。
    const redeemLimited = sensitiveActionGuard.consume(
      `redeem:${clientIdentifier(context)}`,
      10,
      60_000,
    );
    if (redeemLimited) return rateLimitedResponse(context, redeemLimited);
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const input = walletRedeemRequestSchema.parse(body);
    let result;
    try {
      result = await dependencies.wallet.redeem(getCookie(context, identityCookie.name), input);
    } catch (error) {
      // 上游会区分"不存在 / 已使用 / 已过期"，原样回显等于给攻击者一个枚举
      // oracle；除会话失效（401，走全局处理清 Cookie）外统一成同一句话。
      if (error instanceof WalletProviderError && error.status !== 401) {
        const status = error.status === 429 ? 429 : 400;
        return errorResponse(context, status, "REDEEM_FAILED", "兑换码无效或已使用");
      }
      throw error;
    }
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(walletRedeemResponseSchema.parse({ ok: true, data: result.data }));
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

type ApiErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 413 | 415 | 416 | 422 | 429 | 500 | 503;

function errorResponse(context: Context, status: ApiErrorStatus, code: string, message: string) {
  return context.json(apiErrorSchema.parse({ ok: false, error: { code, message } }), status);
}

// —— 音乐链接助手 ————————————————————————————————————————————————

class MusicProxyError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MusicProxyError";
  }
}

/** 用户粘贴的链接允许省略协议；仅接受 http/https。 */
function normalizeMusicInputUrl(value: string): URL {
  const trimmed = value.trim();
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("protocol not allowed");
  return url;
}

function detectMusicSource(url: URL): MusicLinkSource {
  const host = url.hostname.toLowerCase();
  if (host === "music.163.com" || host.endsWith(".music.163.com")) return "netease";
  if (host === "qq.com" || host.endsWith(".qq.com")) return "qq";
  if (host === "qishui.douyin.com" || host.endsWith(".qishui.douyin.com")) return "qishui";
  return "link";
}

/**
 * 手动跟随重定向的守卫式抓取：每一跳重新过 SSRF 守卫（redirect:"follow"
 * 只校验初始 URL，302 到 169.254.169.254 的绕过就发生在这）。
 */
async function musicGuardedFetch(
  url: string,
  init: { accept: string; signal: AbortSignal; range?: string },
) {
  let current = url;
  for (let hop = 0; hop <= MEDIA_PROXY_MAX_REDIRECT_HOPS; hop += 1) {
    const blocked = await isBlockedTargetUrl(current);
    if (blocked) throw new MusicProxyError(400, "MUSIC_URL_BLOCKED", "该链接不可用");
    const attempt = await fetch(current, {
      headers: {
        Accept: init.accept,
        "User-Agent": MUSIC_FETCH_UA,
        ...(init.range ? { Range: init.range } : {}),
      },
      redirect: "manual",
      signal: init.signal,
    });
    if (![301, 302, 303, 307, 308].includes(attempt.status)) return attempt;
    await attempt.body?.cancel().catch(() => undefined);
    const location = attempt.headers.get("location");
    if (!location) throw new MusicProxyError(503, "MUSIC_FETCH_FAILED", "链接没有返回内容");
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new MusicProxyError(400, "MUSIC_URL_BLOCKED", "重定向目标不合法");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new MusicProxyError(400, "MUSIC_URL_BLOCKED", "重定向协议不允许");
    }
    current = next.toString();
  }
  throw new MusicProxyError(503, "MUSIC_FETCH_FAILED", "重定向次数过多");
}

/** 音频魔数（WAV/FLAC/MP3/AAC/Ogg/MP4-M4A）；MP4 容器音频视频共用，由声明类型把关。 */
function sniffAudioBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const asciiAt = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  if (asciiAt(0, 4) === "RIFF" && asciiAt(8, 4) === "WAVE") return true;
  if (asciiAt(0, 4) === "fLaC") return true;
  if (asciiAt(0, 3) === "ID3") return true;
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true; // MP3 帧同步
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return true; // ADTS AAC
  if (asciiAt(0, 4) === "OggS") return true;
  if (asciiAt(4, 4) === "ftyp") return true;
  return false;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 音频直链探测：Range 取头部小段，声明类型 + 魔数双重确认后立即断开，
 * 不为探测拉完整文件。过小文件（平台的“版权保护”提示音等占位）判不可用。
 */
async function probeMusicAudio(url: string, signal: AbortSignal) {
  const response = await musicGuardedFetch(url, {
    accept: "audio/*,*/*;q=0.5",
    signal,
    range: "bytes=0-1023",
  });
  if (!response.ok && response.status !== 206) return false;
  const declaredType =
    (response.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";
  let audioExtension = false;
  try {
    audioExtension = MUSIC_AUDIO_URL_PATTERN.test(new URL(url).pathname);
  } catch {
    audioExtension = false;
  }
  const declaredAudio =
    declaredType.startsWith("audio/") ||
    declaredType === "application/ogg" ||
    (declaredType === "application/octet-stream" && audioExtension);
  if (!declaredAudio) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  let head = new Uint8Array();
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const { value } = await reader.read();
      if (value) head = value;
    } catch {
      head = new Uint8Array();
    }
    await reader.cancel().catch(() => undefined);
  }
  if (head.length && !sniffAudioBytes(head)) return false;
  // 占位提示音检查看的是完整文件大小：Range 响应的 Content-Length 是分片
  // 大小（如 1024），完整大小在 Content-Range 的 “/total” 里。
  const contentRangeTotal = Number(response.headers.get("content-range")?.split("/")[1] || 0);
  const fullLength =
    contentRangeTotal > 0 ? contentRangeTotal : Number(response.headers.get("content-length") || 0);
  if (fullLength > 0 && fullLength < 8_192) return false;
  return true;
}

function neteaseSongId(url: URL): string | null {
  if (!/\/song/.test(url.pathname)) return null;
  const fromQuery = url.searchParams.get("id");
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
  return url.pathname.match(/\/song\/(\d+)/)?.[1] ?? null;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'");
}

function readMetaTag(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const property = tag
      .match(/\b(?:property|name|itemprop)=["']([^"']*)["']/i)?.[1]
      ?.toLowerCase();
    if (property !== key.toLowerCase()) continue;
    const content = tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? "";
    if (content.trim()) return decodeHtmlEntities(content).trim();
  }
  return "";
}

// 平台页标题的尾部后缀（「- 单曲 - 网易云音乐」「- QQ音乐-千万正版…」等）。
const MUSIC_TITLE_TAIL_PATTERN =
  /^(单曲|歌曲|专辑|歌单|电台|主播|声音|网易云音乐|qq音乐|汽水音乐|抖音|音乐|高品?质|无损|hi-?res|flac|mp3|.*千万正版音乐.*|.*海量无损曲库.*|.*音乐平台.*|.*music.*)$/i;

/** 从分享页 HTML 提取标题/歌手/封面；各平台 og 标签或 <title> 尽力而为。 */
function parseMusicPageMeta(html: string): { title: string; artist: string; cover: string | null } {
  const rawTitle =
    readMetaTag(html, "og:title") ||
    readMetaTag(html, "title") ||
    decodeHtmlEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
  const cover = readMetaTag(html, "og:image") || readMetaTag(html, "twitter:image") || null;
  let artist = readMetaTag(html, "og:music:artist") || readMetaTag(html, "author");
  const parts = rawTitle
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length > 1 && MUSIC_TITLE_TAIL_PATTERN.test(parts[parts.length - 1] ?? ""))
    parts.pop();
  let title = parts[0] ?? "";
  if (!artist && parts.length >= 2) artist = parts[1] ?? "";
  return {
    title: title.slice(0, 200),
    artist: artist.slice(0, 200),
    cover: cover ? cover.slice(0, 2_048) : null,
  };
}

async function fetchMusicPageMeta(url: string, signal: AbortSignal) {
  const response = await musicGuardedFetch(url, {
    accept: "text/html,application/xhtml+xml",
    signal,
  });
  if (!response.ok) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MUSIC_PAGE_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const html = new TextDecoder("utf-8", { fatal: false }).decode(concatBytes(chunks));
  return parseMusicPageMeta(html);
}

function musicProxyPaths(streamUrl: string | null, coverUrl: string | null) {
  return {
    streamPath: streamUrl ? `/api/v1/music/stream?u=${encodeURIComponent(streamUrl)}` : null,
    coverPath: coverUrl ? `/api/v1/music/cover?u=${encodeURIComponent(coverUrl)}` : null,
  };
}

function musicResolveData(input: {
  source: MusicLinkSource;
  kind: "audio" | "link";
  title: string;
  artist: string;
  pageUrl: string;
  streamUrl: string | null;
  coverUrl: string | null;
}): MusicLinkResolveData {
  return {
    source: input.source,
    kind: input.kind,
    title: input.title.slice(0, 200),
    artist: input.artist.slice(0, 200),
    pageUrl: input.pageUrl.slice(0, 2_048),
    streamUrl: input.streamUrl,
    coverUrl: input.coverUrl,
    ...musicProxyPaths(input.streamUrl, input.coverUrl),
  };
}

async function resolveMusicLink(input: {
  target: URL;
  source: MusicLinkSource;
  signal: AbortSignal;
}): Promise<MusicLinkResolveData> {
  const pageUrl = input.target.toString().slice(0, 2_048);
  if (input.source === "netease") {
    const songId = neteaseSongId(input.target);
    if (songId) {
      const streamUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
      const playable = await probeMusicAudio(streamUrl, input.signal).catch(() => false);
      if (playable) {
        const meta = await fetchMusicPageMeta(pageUrl, input.signal).catch(() => null);
        return musicResolveData({
          source: "netease",
          kind: "audio",
          title: meta?.title || `网易云音乐歌曲 ${songId}`,
          artist: meta?.artist ?? "",
          pageUrl,
          streamUrl,
          coverUrl: meta?.cover ?? null,
        });
      }
    }
    const meta = await fetchMusicPageMeta(pageUrl, input.signal).catch(() => null);
    return musicResolveData({
      source: "netease",
      kind: "link",
      title: meta?.title || "",
      artist: meta?.artist ?? "",
      pageUrl,
      streamUrl: null,
      coverUrl: meta?.cover ?? null,
    });
  }
  if (input.source === "qq" || input.source === "qishui") {
    // 平台播放链接有签名防盗链/DRM，只做外链卡片（元信息 + 跳转）。
    const meta = await fetchMusicPageMeta(pageUrl, input.signal).catch(() => null);
    return musicResolveData({
      source: input.source,
      kind: "link",
      title: meta?.title || "",
      artist: meta?.artist ?? "",
      pageUrl,
      streamUrl: null,
      coverUrl: meta?.cover ?? null,
    });
  }
  const probe = await probeMusicAudio(pageUrl, input.signal).catch(() => false);
  if (probe) {
    const fileName = decodeURIComponent(input.target.pathname.split("/").pop() || "").trim();
    return musicResolveData({
      source: "direct",
      kind: "audio",
      title: fileName || "音频直链",
      artist: "",
      pageUrl,
      streamUrl: pageUrl,
      coverUrl: null,
    });
  }
  const meta = await fetchMusicPageMeta(pageUrl, input.signal).catch(() => null);
  return musicResolveData({
    source: "link",
    kind: "link",
    title: meta?.title || input.target.hostname,
    artist: meta?.artist ?? "",
    pageUrl,
    streamUrl: null,
    coverUrl: meta?.cover ?? null,
  });
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

function identityUnavailable(context: Context) {
  return errorResponse(context, 503, "IDENTITY_UNAVAILABLE", "账号服务暂未配置");
}

/**
 * 登录/注册入参由 contracts 的 schema 把关（邮箱必须是邮箱格式、注册密码至少 10 位）。
 * 让 ZodError 落到全局分支只会得到「请求参数不完整或格式不正确」，用户无从知道该改哪一项：
 * 真实反馈里有人把手机号填进邮箱框，然后在登录与注册之间反复重试。这里按字段给出可执行提示。
 * 只认凭据字段；其余（例如上游返回体形状不符）仍交给全局分支，不误报成用户输入问题。
 */
function identityRequestErrorResponse(
  context: Context,
  mode: "login" | "register",
  error: unknown,
): Response | null {
  if (!(error instanceof ZodError)) return null;
  const field = error.issues[0]?.path[0];
  if (field === "email") {
    return errorResponse(
      context,
      400,
      "INVALID_REQUEST",
      "邮箱地址格式不正确，请填写完整邮箱（例如 name@example.com）",
    );
  }
  if (field === "password") {
    return errorResponse(
      context,
      400,
      "INVALID_REQUEST",
      mode === "register" ? "密码需为 10-128 位" : "请输入密码",
    );
  }
  if (field === "displayName") {
    return errorResponse(context, 400, "INVALID_REQUEST", "昵称需为 1-48 个字符");
  }
  return null;
}

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

function walletUnavailable(context: Context) {
  return errorResponse(context, 503, "WALLET_UNAVAILABLE", "积分服务暂未配置");
}

function setCloudProjectEtag(context: Context, projectId: string, revision: number) {
  context.header("ETag", `\"${projectId}:${revision}\"`);
}

function optionalQueryInteger(context: Context, value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    return errorResponse(context, 400, "INVALID_LIMIT", "任务数量范围不正确");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    return errorResponse(context, 400, "INVALID_LIMIT", "任务数量范围不正确");
  return parsed;
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

function anonymousAgentRateLimited(context: Context, retryAfterSeconds: number) {
  context.header("Retry-After", String(retryAfterSeconds));
  return errorResponse(context, 429, "AGENT_RATE_LIMITED", "Agent 请求过于频繁，请稍后再试");
}

class AnonymousAgentGuard {
  private readonly now: () => number;
  private readonly conversationsPerMinute: number;
  private readonly submissionsPerMinute: number;
  private readonly submissionsPerDay: number;
  private readonly readsPerMinute: number;
  private readonly globalConversationsPerMinute: number;
  private readonly globalSubmissionsPerMinute: number;
  private readonly globalSubmissionsPerDay: number;
  private readonly globalReadsPerMinute: number;
  private readonly buckets = new Map<
    string,
    { startedAt: number; count: number; durationMs: number }
  >();

  constructor(
    options: ApiDependencies["anonymousAgentLimits"] = {
      conversationsPerMinute: 8,
      submissionsPerMinute: 6,
      submissionsPerDay: 60,
    },
  ) {
    this.now = options?.now ?? Date.now;
    this.conversationsPerMinute = positiveLimit(options?.conversationsPerMinute, 8);
    this.submissionsPerMinute = positiveLimit(options?.submissionsPerMinute, 6);
    this.submissionsPerDay = positiveLimit(options?.submissionsPerDay, 60);
    this.readsPerMinute = positiveLimit(options?.readsPerMinute, 120);
    this.globalConversationsPerMinute = positiveLimit(options?.globalConversationsPerMinute, 120);
    this.globalSubmissionsPerMinute = positiveLimit(options?.globalSubmissionsPerMinute, 60);
    this.globalSubmissionsPerDay = positiveLimit(options?.globalSubmissionsPerDay, 2_000);
    this.globalReadsPerMinute = positiveLimit(options?.globalReadsPerMinute, 10_000);
  }

  consumeConversation(ownerId: string) {
    return (
      this.consume("global:conversation-minute", this.globalConversationsPerMinute, 60_000) ??
      this.consume(`${ownerId}:conversation`, this.conversationsPerMinute, 60_000)
    );
  }

  consumeSubmission(ownerId: string) {
    return (
      this.consume("global:submit-minute", this.globalSubmissionsPerMinute, 60_000) ??
      this.consume("global:submit-day", this.globalSubmissionsPerDay, 24 * 60 * 60_000) ??
      this.consume(`${ownerId}:submit-minute`, this.submissionsPerMinute, 60_000) ??
      this.consume(`${ownerId}:submit-day`, this.submissionsPerDay, 24 * 60 * 60_000)
    );
  }

  consumeRead(ownerId: string) {
    return (
      this.consume("global:read-minute", this.globalReadsPerMinute, 60_000) ??
      this.consume(`${ownerId}:read-minute`, this.readsPerMinute, 60_000)
    );
  }

  private consume(key: string, limit: number, durationMs: number) {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.durationMs !== durationMs || now - bucket.startedAt >= durationMs) {
      this.buckets.set(key, { startedAt: now, count: 1, durationMs });
      this.prune(now);
      return null;
    }
    if (bucket.count >= limit)
      return Math.max(1, Math.ceil((durationMs - (now - bucket.startedAt)) / 1_000));
    bucket.count += 1;
    return null;
  }

  private prune(now: number) {
    if (this.buckets.size < 2_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= bucket.durationMs) this.buckets.delete(key);
    }
    while (this.buckets.size > 4_000) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * 敏感接口的固定窗口限速（登录 / 注册 / 兑换 / 会员任务）。
 * 单实例进程内计数：systemd 单机部署有效；多实例部署下每个实例各自计数，
 * 需要跨实例一致时应换成 PostgresFixedWindowRateLimiter。
 */
class SensitiveActionGuard {
  private readonly buckets = new Map<
    string,
    { startedAt: number; count: number; durationMs: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** 返回 null 表示放行，返回数字表示还需等待的秒数。 */
  consume(key: string, limit: number, durationMs: number): number | null {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.durationMs !== durationMs || now - bucket.startedAt >= durationMs) {
      this.buckets.set(key, { startedAt: now, count: 1, durationMs });
      this.prune(now);
      return null;
    }
    if (bucket.count >= limit) {
      return Math.max(1, Math.ceil((durationMs - (now - bucket.startedAt)) / 1_000));
    }
    bucket.count += 1;
    return null;
  }

  private prune(now: number) {
    if (this.buckets.size < 2_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= bucket.durationMs) this.buckets.delete(key);
    }
    while (this.buckets.size > 4_000) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
  }
}

/** 取客户端标识：按部署的代理链依次看 CF / XFF / X-Real-IP，全部缺失时回落 anonymous。 */
function clientIdentifier(context: Context) {
  const cf = context.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return context.req.header("x-real-ip")?.trim() || "anonymous";
}

function rateLimitedResponse(context: Context, retryAfterSeconds: number) {
  context.header("Retry-After", String(retryAfterSeconds));
  return errorResponse(context, 429, "RATE_LIMITED", "操作太频繁了，请稍后再试");
}

export async function requireIdentitySession(
  context: Context,
  identity: IdentityProvider | undefined,
  cookie: NonNullable<ApiDependencies["identityCookie"]>,
) {
  if (!identity) return identityUnavailable(context);
  const session = await authenticateIdentity(context, identity, cookie);
  if (session) return session;
  return errorResponse(context, 401, "UNAUTHENTICATED", "请先登录");
}

async function authenticateIdentity(
  context: Context,
  identity: IdentityProvider,
  cookie: NonNullable<ApiDependencies["identityCookie"]>,
) {
  const token = getCookie(context, cookie.name);
  const session = await identity.authenticate(token);
  if (!session) {
    if (token) clearIdentityCookie(context, cookie);
    return null;
  }
  if (session.refreshedToken) {
    setIdentityCookie(context, cookie, { ...session, token: session.refreshedToken });
  }
  const { refreshedToken: _refreshedToken, ...publicSession } = session;
  return publicSession;
}

async function readJsonBody(context: Context) {
  const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(context, 415, "JSON_REQUIRED", "请求必须使用 JSON 格式");
  }
  const contentEncoding = context.req.header("Content-Encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return errorResponse(context, 415, "CONTENT_ENCODING_UNAVAILABLE", "请求内容不能使用压缩编码");
  }
  const declaredLength = context.req.header("Content-Length");
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength))
      return errorResponse(context, 400, "CONTENT_LENGTH_INVALID", "请求大小信息无效");
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed))
      return errorResponse(context, 400, "CONTENT_LENGTH_INVALID", "请求大小信息无效");
    if (parsed > 1024 * 1024) return errorResponse(context, 413, "JSON_TOO_LARGE", "请求内容过大");
  }
  const body = context.req.raw.body;
  if (!body) return errorResponse(context, 400, "INVALID_JSON", "请求内容格式不正确");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        return errorResponse(context, 413, "JSON_TOO_LARGE", "请求内容过大");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return errorResponse(context, 400, "INVALID_JSON", "请求内容格式不正确");
  }
}

function publicIssuedSession({ token: _token, ...session }: IssuedIdentitySession) {
  return session;
}

function isGenerationObservationTerminal(status: GenerationJobStatus) {
  return status === "completed" || status === "failed" || status === "submission_unknown";
}

function setIdentityCookie(
  context: Context,
  cookie: NonNullable<ApiDependencies["identityCookie"]>,
  issued: Pick<IssuedIdentitySession, "token" | "expiresAt">,
) {
  const expires = new Date(issued.expiresAt);
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1_000));
  setCookie(context, cookie.name, issued.token, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: "Strict",
    path: "/",
    expires,
    maxAge,
    priority: "High",
  });
}

export function refreshIdentityCookie(
  context: Context,
  cookie: NonNullable<ApiDependencies["identityCookie"]>,
  result: { refreshedToken?: string; expiresAt?: string },
) {
  if (!result.refreshedToken || !result.expiresAt) return;
  setIdentityCookie(context, cookie, {
    token: result.refreshedToken,
    expiresAt: result.expiresAt,
  });
}

function refreshIdentityCookieFromError(
  context: Context,
  cookie: NonNullable<ApiDependencies["identityCookie"]>,
  error: unknown,
) {
  if (!error || typeof error !== "object" || Array.isArray(error)) return;
  const value = error as {
    refreshedToken?: unknown;
    expiresAt?: unknown;
    status?: unknown;
    code?: unknown;
  };
  if (value.status === 401 || value.code === "UNAUTHENTICATED") return;
  if (typeof value.refreshedToken !== "string" || typeof value.expiresAt !== "string") return;
  refreshIdentityCookie(context, cookie, {
    refreshedToken: value.refreshedToken,
    expiresAt: value.expiresAt,
  });
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
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0f1113; color: #e7eae8; font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 14px 18px; background: #17191c; border-bottom: 1px solid #2a2e32; }
h1 { font-size: 15px; margin: 0 auto 0 0; font-weight: 600; }
input, button { font: inherit; border-radius: 8px; border: 1px solid #34383d; background: #131518; color: #e7eae8; padding: 7px 10px; }
input:focus, button:focus { outline: 1px solid #4cbf88; }
button { cursor: pointer; background: #1d2024; }
button.primary { background: #2f7d59; border-color: #2f7d59; color: #fff; }
button:disabled { opacity: .5; cursor: default; }
main { padding: 16px 18px 64px; }
#status { font-size: 12px; color: #9aa2a0; }
#msg { margin: 12px 0; font-size: 13px; min-height: 20px; }
#msg.ok { color: #6fd39a; }
#msg.err { color: #ff8f8f; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #22262a; vertical-align: middle; }
th { position: sticky; top: 61px; background: #14171a; font-size: 12px; color: #9aa2a0; font-weight: 500; }
td.id code { font-size: 12px; color: #b9c6c0; }
td .label { display: block; font-size: 12px; color: #7d8684; }
.muted { color: #7d8684; font-size: 12px; }
.price-input { width: 92px; }
.hidden-row { opacity: .55; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid #34383d; color: #9aa2a0; }
#filters { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; align-items: center; }
#filters input { flex: 1; min-width: 180px; }
.token-inputs { display: flex; gap: 4px; }
.token-inputs .price-input { width: 82px; }
.hint { color: #7d8684; font-size: 12px; margin: 0 0 10px; }
.zone-input { width: 104px; }
.name-input { width: 100%; margin-bottom: 4px; }
.desc-input { width: 100%; font-size: 12px; }
.badge-promo { border-color: #8a6a2f; color: #e0b25f; }
</style>
</head>
<body>
<header>
  <h1>画布模型上架与定价</h1>
  <input id="secret" type="password" placeholder="管理密钥" style="width:200px">
  <button id="load" class="primary">加载</button>
  <button id="save" class="primary" disabled>保存</button>
  <span id="status"></span>
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
      <th style="width:26%">模型</th><th>类型</th><th>分辨率</th><th style="width:180px">当前价</th><th style="width:170px">自定义价（元）</th><th style="width:110px">分区</th><th style="width:200px">显示名 / 简介</th><th style="width:64px">展示</th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="8" class="muted">输入密钥后点「加载」</td></tr></tbody>
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
    if (!list.length) { body.innerHTML = '<tr><td colspan="8" class="muted">没有匹配的模型</td></tr>'; return; }
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

function identityCapabilities(identity: IdentityProvider | undefined) {
  return (
    identity?.capabilities ?? {
      available: false,
      registration: "disabled" as const,
      registrationUrl: null,
      passwordResetUrl: null,
    }
  );
}

function clearIdentityCookie(
  context: Context,
  cookie: NonNullable<ApiDependencies["identityCookie"]>,
) {
  deleteCookie(context, cookie.name, {
    secure: cookie.secure,
    sameSite: "Strict",
    path: "/",
  });
}

function isTrustedBrowserRequest(request: Request, allowedOrigins: readonly string[] = []) {
  if (request.headers.get("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
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
