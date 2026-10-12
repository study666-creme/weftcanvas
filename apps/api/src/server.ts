import "./load-environment.js";

import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { createApiApp } from "./app.js";
import { CanvasCommandBroker } from "./connectors/canvas-command-broker.js";
import { ExternalConnectorService } from "./connectors/external-connector-service.js";
import { HttpAgentConnectorGateway } from "./agent/connector-gateway.js";
import { HttpAgentExecutor } from "./agent/http-executor.js";
import { MemoryAgentStore } from "./agent/memory-store.js";
import { PostgresAgentStore } from "./agent/postgres-store.js";
import { AgentService, type AgentBilling } from "./agent/service.js";
import { buildAgentTextModels, createStationTextPricingLookup } from "./agent/text-models.js";
import { WeftcanvasCatalogAdapter } from "./catalog/adapter.js";
import { JsonModelOverrideStore } from "./catalog/overrides.js";
import { toPublicCatalogView } from "./catalog/public-view.js";
import { GenerationQuoteService } from "./catalog/quote.js";
import {
  JsonCatalogSnapshotStore,
  PostgresCatalogSnapshotStore,
  ResilientCatalogSnapshotStore,
} from "./catalog/store.js";
import { createDatabasePool } from "./database/pool.js";
import { createPostgresApiReadinessProbe } from "./database/readiness.js";
import { GenerationApiGuard, PostgresFixedWindowRateLimiter } from "./generation/api-rate-limit.js";
import { MediaGenerationInputAuthorizer } from "./generation/input-authorizer.js";
import { PostgresGenerationJobStore } from "./generation/postgres-store.js";
import { GenerationJobService } from "./generation/service.js";
import { PostgresIdentityStore } from "./identity/postgres-store.js";
import { PostgresPrincipalMembershipReader } from "./identity/principal-membership-reader.js";
import { IdentityService } from "./identity/service.js";
import { DefaultMediaInspector } from "./media/inspector.js";
import { MediaMultipartService } from "./media/multipart-service.js";
import { createMediaObjectStore, maintainMediaObjectStore } from "./media/object-store-factory.js";
import { PostgresMediaMultipartUploadStore } from "./media/postgres-multipart-store.js";
import { PostgresMediaMetadataStore } from "./media/postgres-store.js";
import { MediaService } from "./media/service.js";
import { CloudResourceService } from "./media/cloud-resource-service.js";
import { SignedMediaAccess } from "./media/signed-access.js";
import { supportsMultipartMediaAccess } from "./media/types.js";
import {
  defaultCloudProjectEntitlementPolicy,
  MembershipCloudProjectEntitlementResolver,
  StaticCloudProjectEntitlementResolver,
} from "./project/entitlements.js";
import { PostgresCloudProjectStore } from "./project/postgres-store.js";
import { PostgresCloudProjectMediaValidator } from "./project/media-access.js";
import { CloudProjectService } from "./project/service.js";
import { CloudProjectCollaborationService } from "./project/collaboration-service.js";
import { PostgresCloudProjectCollaborationStore } from "./project/postgres-collaboration-store.js";
import { PostgresCollaborationSeatEntitlementResolver } from "./project/collaboration-seat-entitlements.js";
import { assembleProviderServices, resolveProviderPlan } from "./spi/assembly.js";
import type { GenerationProvider, HostedAccountProvider } from "./spi/types.js";

const port = readPort(process.env.PORT, 8787);
// Provider 装配第一步：解析 CANVAS_API_PROVIDER 与端点计划（weftcanvas 私有
// 模块如被点名会在此加载）。目录/报价必须先建，端点随计划先到。
const providerPlan = await resolveProviderPlan(process.env);
// The source already exposes its own latest validated catalog. Forcing its
// refresh on every Canvas cold start turns a normal transient into a user-facing
// model-picker outage, so Canvas refreshes on its own interval instead.
const sourceUrl = providerPlan.catalogSourceUrl;
const snapshotPath = resolve(process.env.CATALOG_SNAPSHOT_PATH || ".data/model-catalog.json");
const pool = createDatabasePool();
const readiness = pool ? await createPostgresApiReadinessProbe(pool) : undefined;
const fileCatalogStore = new JsonCatalogSnapshotStore(snapshotPath);
const store = pool
  ? new ResilientCatalogSnapshotStore([new PostgresCatalogSnapshotStore(pool), fileCatalogStore])
  : fileCatalogStore;
const modelOverrides = new JsonModelOverrideStore(
  resolve(process.env.MODEL_OVERRIDES_PATH || ".data/model-overrides.json"),
);
const catalog = new WeftcanvasCatalogAdapter({
  sourceUrl,
  // 视频准入以**执行器目录**为准（托管模式下由私有 provider 提供端点）。
  // dev-test 模式没有默认端点：目录走纯快照模式或自托管端点。
  videoInventoryUrl: providerPlan.catalogVideoInventoryUrl,
  includeKnownModels: true,
  // 站点策展层（计价/品牌化规则）由私有 overlay 提供；dev-test 无 overlay。
  ...(providerPlan.weftcanvas
    ? { overlay: providerPlan.weftcanvas.createCatalogOverlay(process.env) }
    : {}),
  overrides: modelOverrides,
  store,
});
const quotes = new GenerationQuoteService(catalog);
// Warm the shared snapshot before the first creator opens a model picker.
void catalog.getCatalog().catch((error) => console.error("Catalog prewarm failed", error));
// 会话 24 小时强制过期：每个账号每天必须重新登录一次（产品安全要求）。
// 部署环境可用 SESSION_TTL_SECONDS 覆盖，但默认值不再是 30 天。
const sessionTtlMs =
  readInteger(process.env.SESSION_TTL_SECONDS, 24 * 60 * 60, 3_600, 90 * 24 * 60 * 60) * 1_000;
const nativeIdentity = pool
  ? new IdentityService(new PostgresIdentityStore(pool), {
      sessionTtlMs,
      initialCreditMicros: readInteger(
        process.env.REGISTRATION_CREDIT_MICROS,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    })
  : undefined;
const sessionSecret = identitySessionSecret(process.env.IDENTITY_SESSION_SECRET);
const agentRuntimeUrl = process.env.AGENT_RUNTIME_URL?.trim();
const agentRuntimeToken = process.env.AGENT_RUNTIME_TOKEN?.trim();
if ((agentRuntimeUrl && !agentRuntimeToken) || (!agentRuntimeUrl && agentRuntimeToken)) {
  throw new Error("AGENT_RUNTIME_URL and AGENT_RUNTIME_TOKEN must be configured together");
}
const agentExecutor =
  agentRuntimeUrl && agentRuntimeToken
    ? new HttpAgentExecutor(
        agentRuntimeUrl,
        agentRuntimeToken,
        readInteger(process.env.AGENT_RUNTIME_TIMEOUT_MS, 5 * 60_000, 1_000, 30 * 60_000),
      )
    : undefined;
// 本机连接（Codex / Blender）由 Agent 运行时持有；浏览器通过 API 代理读写。
// 运行时没配置时这些接口返回明确的"未配置"，而不是假装连接可用。
const connectors =
  agentRuntimeUrl && agentRuntimeToken
    ? new HttpAgentConnectorGateway(agentRuntimeUrl, agentRuntimeToken, {
        timeoutMs: readInteger(
          process.env.AGENT_RUNTIME_TIMEOUT_MS,
          5 * 60_000,
          1_000,
          30 * 60_000,
        ),
      })
    : undefined;
// Agent 只按轮次计费，因此选择器默认只放「有按次价」的文本模型：站点把按次价
// 发布在公开价格表的 request 分组里（Gemini 全系都挂着按次价，但目录里写着
// tiered_token，只看目录计费模式会把它们整线漏掉）。AGENT_INCLUDE_TOKEN_MODELS=true
// 时放开全部文本模型（含纯按量）。
const agentIncludeTokenModels = readBoolean(process.env.AGENT_INCLUDE_TOKEN_MODELS, false);
// Agent 模型选择器的站点定价表：weftcanvas 模式由私有装配给出端点；
// dev-test 模式只认显式 WEFTCANVAS_PRICING_URL，没有配置就不查价（选择器
// 仍可用，只是没有站点价参考）。
const stationTextPricing = providerPlan.stationPricingUrl
  ? createStationTextPricingLookup({ url: providerPlan.stationPricingUrl })
  : async () => null;
const agentOptions = {
  ...(agentExecutor ? { executor: agentExecutor } : {}),
  // Agent 模型选择器复用平台文本模型目录，按厂商分组（与模型广场同一口径）。
  // 按次模型统一走平台默认价（2 分钱 = 2 积分一次对话，管理员可在后台改价）。
  textModels: async () => {
    const [view, overrides, pricing] = await Promise.all([
      catalog.getCatalog().then(toPublicCatalogView),
      modelOverrides.load(),
      stationTextPricing(),
    ]);
    return buildAgentTextModels({
      models: view.models,
      overrides,
      stationPricing: pricing,
      includeTokenModels: agentIncludeTokenModels,
    });
  },
};
// 用户侧反向连接：用户的 Blender/Codex 主动连到这里领取任务并回传结果。
// 这些客户端跑在用户自己的机器上，服务器上不需要（也不该）装 Blender 或 Codex。
// 同一实例既服务浏览器侧（配对/状态/派发），也用于把 Agent 的工具调用派发给对应用户。
// 配对令牌默认 30 天过期：它等同"用户机器上的代码执行权限"，不该永久有效。
const pairingTokenTtlMs =
  readInteger(process.env.PAIRING_TOKEN_TTL_DAYS, 30, 1, 365) * 24 * 60 * 60_000;
const externalConnectors = new ExternalConnectorService({ tokenTtlMs: pairingTokenTtlMs });
const canvasCommands = new CanvasCommandBroker();
const mediaObjects = pool ? createMediaObjectStore() : undefined;
if (mediaObjects) {
  await maintainMediaObjectStore(mediaObjects).catch((error) =>
    console.error("Media temporary cleanup failed", error),
  );
}
const mediaMetadata = pool ? new PostgresMediaMetadataStore(pool) : undefined;
const media =
  pool && mediaMetadata
    ? new MediaService(mediaMetadata, mediaObjects!, new DefaultMediaInspector())
    : undefined;
const cloudResourceService =
  mediaObjects && mediaMetadata ? new CloudResourceService(mediaMetadata, mediaObjects) : undefined;
const multipartMedia =
  pool && media && mediaMetadata && mediaObjects && supportsMultipartMediaAccess(mediaObjects)
    ? new MediaMultipartService(
        new PostgresMediaMultipartUploadStore(pool),
        mediaMetadata,
        mediaObjects,
        media,
      )
    : undefined;
const mediaPublicBaseUrl = process.env.MEDIA_PUBLIC_BASE_URL?.trim();
const signedMedia = process.env.MEDIA_SIGNING_SECRET
  ? new SignedMediaAccess({
      secret: process.env.MEDIA_SIGNING_SECRET,
      ...(mediaPublicBaseUrl ? { baseUrl: mediaPublicBaseUrl } : {}),
      allowInsecureLocalhost: process.env.NODE_ENV !== "production",
    })
  : undefined;
const nativeGeneration =
  pool && media
    ? new GenerationJobService(quotes, catalog, new PostgresGenerationJobStore(pool), {
        inputAuthorizer: new MediaGenerationInputAuthorizer(media),
        maxActiveJobs: readInteger(process.env.GENERATION_MAX_ACTIVE_JOBS, 100, 1, 1000),
      })
    : undefined;
// Provider 装配第二步：身份/托管账号/生成服务按计划落位（weftcanvas 私有模块
// 在此接管托管实现；dev-test 直接用上面的原生服务）。
const providerServices = await assembleProviderServices(providerPlan, {
  env: process.env,
  sessionSecret,
  sessionTtlMs,
  quotes,
  media,
  signedMedia,
  nativeIdentity,
  nativeGeneration,
});
const identity = providerServices.identity;
const hostedAccount: HostedAccountProvider | undefined = providerServices.account;
const generation: GenerationProvider | undefined = providerServices.hostedGeneration;
// Agent 每轮固定扣费：走已登录用户的托管钱包（同一份积分余额）。
// dev-test 身份不扣费，仅开发/测试环境会出现。
const agentBilling: AgentBilling | undefined = hostedAccount
  ? {
      async consume(input) {
        const result = await hostedAccount.consumeCredit(input.token, {
          amount: input.amount,
          reason: input.reason,
          refId: input.refId,
        });
        return result.data;
      },
      async refund(input) {
        const result = await hostedAccount.refundCredit(input.token, {
          amount: input.amount,
          reason: input.reason,
          refId: input.refId,
        });
        return result.data;
      },
    }
  : undefined;
const agentOptionsWithConnectors = {
  ...agentOptions,
  connectorClients: externalConnectors,
  ...(agentBilling ? { billing: agentBilling } : {}),
};
const agent = pool
  ? new AgentService(new PostgresAgentStore(pool), agentOptionsWithConnectors)
  : undefined;
const anonymousAgent = new AgentService(
  new MemoryAgentStore({
    retentionMs:
      readInteger(
        process.env.AGENT_ANONYMOUS_RETENTION_SECONDS,
        24 * 60 * 60,
        300,
        7 * 24 * 60 * 60,
      ) * 1_000,
    maxConversations: readInteger(
      process.env.AGENT_ANONYMOUS_MAX_CONVERSATIONS,
      2_000,
      10,
      100_000,
    ),
  }),
  agentOptionsWithConnectors,
);
const cloudProjectPolicy = readCloudProjectPolicy();
const cloudProjectEntitlements = hostedAccount
  ? new MembershipCloudProjectEntitlementResolver(hostedAccount, cloudProjectPolicy, {
      ...(pool ? { principalMembershipReader: new PostgresPrincipalMembershipReader(pool) } : {}),
    })
  : new StaticCloudProjectEntitlementResolver(cloudProjectPolicy.free);
const cloudProjectStore = pool ? new PostgresCloudProjectStore(pool) : undefined;
const cloudProjectCollaborationStore = pool
  ? new PostgresCloudProjectCollaborationStore(pool)
  : undefined;
const cloudProjects = pool
  ? new CloudProjectService(cloudProjectStore!, cloudProjectEntitlements, {
      access: cloudProjectCollaborationStore,
      mediaValidator: new PostgresCloudProjectMediaValidator(pool),
      // 宽限记录与 canvas_media 同库：复用 media 元数据存储的宽限方法。
      ...(mediaMetadata ? { storageGrace: mediaMetadata } : {}),
    })
  : undefined;
const collaboration =
  cloudProjectCollaborationStore && pool
    ? new CloudProjectCollaborationService(
        cloudProjectCollaborationStore,
        cloudProjectEntitlements,
        {
          seatEntitlements: new PostgresCollaborationSeatEntitlementResolver(pool),
        },
      )
    : undefined;
// Hosted generation and reference uploads share the Prompt Hub account channel.
const generationGuard =
  pool && generation
    ? new GenerationApiGuard(new PostgresFixedWindowRateLimiter(pool), {
        // 0 = 不设上限（产品要求提交不限次数）；正数才启用对应窗口的限流。
        submissionsPerMinute: readInteger(process.env.GENERATION_SUBMIT_PER_MINUTE, 10, 0, 10_000),
        submissionsPerDay: readInteger(process.env.GENERATION_SUBMIT_PER_DAY, 100, 0, 1_000_000),
        readsPerMinute: readInteger(process.env.GENERATION_READ_PER_MINUTE, 180, 1, 100_000),
        streamStartsPerMinute: readInteger(
          process.env.GENERATION_STREAMS_PER_MINUTE,
          30,
          1,
          10_000,
        ),
        streamsPerOwner: readInteger(process.env.GENERATION_STREAMS_PER_USER, 3, 1, 100),
        streamsGlobal: readInteger(process.env.GENERATION_STREAMS_GLOBAL, 200, 1, 100_000),
      })
    : undefined;
const secureCookie = readBoolean(
  process.env.SESSION_COOKIE_SECURE,
  process.env.NODE_ENV === "production",
);
if (process.env.NODE_ENV === "production" && !secureCookie) {
  throw new Error("SESSION_COOKIE_SECURE must be true in production");
}
const cookieName =
  process.env.SESSION_COOKIE_NAME?.trim() ||
  (secureCookie ? "__Host-weftcanvas_session" : "weftcanvas_session");
if (cookieName.startsWith("__Host-") && !secureCookie) {
  throw new Error("A __Host- session cookie requires SESSION_COOKIE_SECURE=true");
}
const anonymousAgentCookieName =
  process.env.AGENT_ANONYMOUS_COOKIE_NAME?.trim() ||
  (secureCookie ? "__Host-weftcanvas_agent_guest" : "weftcanvas_agent_guest");
if (anonymousAgentCookieName.startsWith("__Host-") && !secureCookie) {
  throw new Error("A __Host- anonymous Agent cookie requires SESSION_COOKIE_SECURE=true");
}
const app = createApiApp({
  agent,
  connectors,
  // 用户侧反向连接：用户的 Blender/Codex 主动连到这里领取任务并回传结果。
  externalConnectors,
  // Codex（MCP）下发的画布指令队列，由浏览器轮询执行。
  canvasCommands,
  // 运行时用同一个共享令牌调用 /internal/v1/* 派发任务（方向相反）。
  ...(agentRuntimeToken ? { internalRuntimeToken: agentRuntimeToken } : {}),
  anonymousAgent,
  anonymousAgentCookie: { name: anonymousAgentCookieName, secure: secureCookie },
  anonymousAgentLimits: {
    conversationsPerMinute: readInteger(
      process.env.AGENT_ANONYMOUS_CONVERSATIONS_PER_MINUTE,
      8,
      1,
      10_000,
    ),
    submissionsPerMinute: readInteger(process.env.AGENT_ANONYMOUS_SUBMIT_PER_MINUTE, 6, 1, 10_000),
    submissionsPerDay: readInteger(process.env.AGENT_ANONYMOUS_SUBMIT_PER_DAY, 60, 1, 1_000_000),
  },
  catalog,
  registerAccountRoutes: providerServices.registerAccountRoutes,
  quotes,
  ...(process.env.MODEL_OVERRIDES_ADMIN_SECRET?.trim()
    ? {
        modelOverrides,
        modelOverridesAdminSecret: process.env.MODEL_OVERRIDES_ADMIN_SECRET.trim(),
      }
    : {}),
  identity,
  entitlements: cloudProjectEntitlements,
  media,
  cloudResources: cloudResourceService,
  multipartMedia,
  projects: cloudProjects,
  collaboration,
  signedMedia,
  generation,
  generationGuard,
  readiness,
  wallet: hostedAccount,
  membershipTasks: hostedAccount,
  ...(media && mediaMetadata && pool
    ? {
        // 每日存储清扫：宽限期到期的 owner 按最旧未绑定素材优先执行配额。
        storageSweep: {
          sweep: async () => {
            const failures: Array<{ ownerId: string; error: string }> = [];
            const overdue = await mediaMetadata.overdueStorageGrace();
            let enforced = 0;
            let evicted = 0;
            for (const ownerId of overdue) {
              try {
                const resolved =
                  "resolveForPrincipal" in cloudProjectEntitlements
                    ? await cloudProjectEntitlements.resolveForPrincipal(ownerId)
                    : { data: cloudProjectPolicy.free };
                const { evicted: items } = await mediaMetadata.enforceQuotaAfterGrace(
                  ownerId,
                  resolved.data.mediaStorageBytes,
                );
                await media.releaseEvictedForSweep(items);
                enforced += 1;
                evicted += items.length;
              } catch (error) {
                failures.push({
                  ownerId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            return { scanned: overdue.length, enforced, evicted, failures };
          },
        },
        ...(process.env.STORAGE_SWEEP_SECRET?.trim()
          ? { storageSweepSecret: process.env.STORAGE_SWEEP_SECRET.trim() }
          : {}),
      }
    : {}),
  generationStream: {
    pollIntervalMs: readInteger(process.env.GENERATION_SSE_POLL_MS, 1_000, 250, 30_000),
    heartbeatMs: readInteger(process.env.GENERATION_SSE_HEARTBEAT_MS, 15_000, 5_000, 60_000),
    maxDurationMs: readInteger(process.env.GENERATION_SSE_MAX_MS, 10 * 60_000, 30_000, 60 * 60_000),
  },
  identityCookie: { name: cookieName, secure: secureCookie },
  allowedOrigins: readAllowedOrigins(process.env.APP_ORIGINS),
});

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Canvas API listening on http://127.0.0.1:${info.port}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    await pool?.end().catch((error) => console.error("Failed to close the database pool", error));
    process.exit(0);
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function readPort(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function readInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer between ${min} and ${max}, received ${value}`);
  }
  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received ${value}`);
}

function readOrigins(value: string | undefined) {
  if (!value) return [];
  return value.split(",").map((origin) => {
    const normalized = new URL(origin.trim()).origin;
    if (normalized !== origin.trim().replace(/\/$/, ""))
      throw new Error(`APP_ORIGINS contains an invalid origin: ${origin}`);
    return normalized;
  });
}

function readAllowedOrigins(value: string | undefined) {
  const configured = readOrigins(value);
  if (process.env.NODE_ENV === "production") return configured;
  return Array.from(new Set([...configured, "http://127.0.0.1:4173", "http://localhost:4173"]));
}

function identitySessionSecret(value: string | undefined) {
  const configured = value?.trim();
  if (configured) {
    if (process.env.NODE_ENV === "production" && Buffer.byteLength(configured, "utf8") < 32) {
      throw new Error("IDENTITY_SESSION_SECRET must contain at least 32 bytes in production");
    }
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("IDENTITY_SESSION_SECRET is required for hosted identity in production");
  }
  return randomBytes(32).toString("base64url");
}

function readCloudProjectPolicy() {
  const policy = defaultCloudProjectEntitlementPolicy();
  policy.free.cloudProjectLimit = readInteger(
    process.env.CLOUD_PROJECT_FREE_LIMIT,
    policy.free.cloudProjectLimit,
    0,
    100_000,
  );
  policy.free.projectStorageBytes = readInteger(
    process.env.CLOUD_PROJECT_FREE_STORAGE_BYTES,
    policy.free.projectStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.free.mediaStorageBytes = readInteger(
    process.env.CLOUD_MEDIA_FREE_STORAGE_BYTES,
    policy.free.mediaStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.free.revisionRetentionCount = readInteger(
    process.env.CLOUD_PROJECT_FREE_REVISIONS,
    policy.free.revisionRetentionCount,
    1,
    1_000,
  );
  policy.lite.cloudProjectLimit = readInteger(
    process.env.CLOUD_PROJECT_LITE_LIMIT,
    policy.lite.cloudProjectLimit,
    0,
    100_000,
  );
  policy.lite.projectStorageBytes = readInteger(
    process.env.CLOUD_PROJECT_LITE_STORAGE_BYTES,
    policy.lite.projectStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.lite.mediaStorageBytes = readInteger(
    process.env.CLOUD_MEDIA_LITE_STORAGE_BYTES,
    policy.lite.mediaStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.lite.revisionRetentionCount = readInteger(
    process.env.CLOUD_PROJECT_LITE_REVISIONS,
    policy.lite.revisionRetentionCount,
    1,
    1_000,
  );
  policy.basic.cloudProjectLimit = readInteger(
    process.env.CLOUD_PROJECT_BASIC_LIMIT,
    policy.basic.cloudProjectLimit,
    0,
    100_000,
  );
  policy.basic.projectStorageBytes = readInteger(
    process.env.CLOUD_PROJECT_BASIC_STORAGE_BYTES,
    policy.basic.projectStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.basic.mediaStorageBytes = readInteger(
    process.env.CLOUD_MEDIA_BASIC_STORAGE_BYTES,
    policy.basic.mediaStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.basic.revisionRetentionCount = readInteger(
    process.env.CLOUD_PROJECT_BASIC_REVISIONS,
    policy.basic.revisionRetentionCount,
    1,
    1_000,
  );
  policy.standard.cloudProjectLimit = readInteger(
    process.env.CLOUD_PROJECT_STANDARD_LIMIT,
    policy.standard.cloudProjectLimit,
    0,
    100_000,
  );
  policy.standard.projectStorageBytes = readInteger(
    process.env.CLOUD_PROJECT_STANDARD_STORAGE_BYTES,
    policy.standard.projectStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.standard.mediaStorageBytes = readInteger(
    process.env.CLOUD_MEDIA_STANDARD_STORAGE_BYTES,
    policy.standard.mediaStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.standard.revisionRetentionCount = readInteger(
    process.env.CLOUD_PROJECT_STANDARD_REVISIONS,
    policy.standard.revisionRetentionCount,
    1,
    1_000,
  );
  policy.pro.cloudProjectLimit = readInteger(
    process.env.CLOUD_PROJECT_PRO_LIMIT,
    policy.pro.cloudProjectLimit,
    0,
    100_000,
  );
  policy.pro.projectStorageBytes = readInteger(
    process.env.CLOUD_PROJECT_PRO_STORAGE_BYTES,
    policy.pro.projectStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.pro.mediaStorageBytes = readInteger(
    process.env.CLOUD_MEDIA_PRO_STORAGE_BYTES,
    policy.pro.mediaStorageBytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  policy.pro.revisionRetentionCount = readInteger(
    process.env.CLOUD_PROJECT_PRO_REVISIONS,
    policy.pro.revisionRetentionCount,
    1,
    1_000,
  );
  return policy;
}
