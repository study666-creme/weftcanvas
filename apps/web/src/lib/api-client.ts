import {
  agentConnectorListResponseSchema,
  agentConnectorResponseSchema,
  agentConversationDetailResponseSchema,
  agentConversationListResponseSchema,
  agentConversationResponseSchema,
  agentModelCatalogResponseSchema,
  apiErrorSchema,
  canvasControlPendingResponseSchema,
  canvasControlReceiptResponseSchema,
  connectorClientListResponseSchema,
  connectorPairingResponseSchema,
  connectorPairingRevokeResponseSchema,
  externalTaskRunResponseSchema,
  cloudProjectDeleteResponseSchema,
  cloudProjectInvitationListResponseSchema,
  cloudProjectInvitationResponseSchema,
  cloudProjectListResponseSchema,
  cloudProjectMemberListResponseSchema,
  cloudProjectMemberResponseSchema,
  cloudProjectResponseSchema,
  cloudResourceCleanupResponseSchema,
  cloudResourceListResponseSchema,
  generationJobEventSchema,
  generationJobListResponseSchema,
  generationJobResponseSchema,
  generationQuoteResponseSchema,
  identityLogoutResponseSchema,
  identityRegistrationResponseSchema,
  identitySessionResponseSchema,
  identitySessionStateResponseSchema,
  mediaResponseSchema,
  mediaMultipartCompleteResponseSchema,
  mediaMultipartPartInstructionsResponseSchema,
  mediaMultipartUploadStateResponseSchema,
  mediaUploadIntentResponseSchema,
  MEDIA_MULTIPART_MAX_SIGNED_PARTS,
  membershipTaskActionResponseSchema,
  membershipTaskCenterResponseSchema,
  modelCatalogResponseSchema,
  musicLinkResolveResponseSchema,
  providerMediaReferenceResponseSchema,
  walletCheckoutResponseSchema,
  walletLedgerResponseSchema,
  walletOrderResponseSchema,
  walletProductsResponseSchema,
  walletRedeemResponseSchema,
  walletResponseSchema,
  type GenerationJobSubmission,
  type GenerationQuoteRequest,
  type AgentCanvasContext,
  type AgentConnectorId,
  type AgentConnectorUpdateRequest,
  type AgentMessageCreateRequest,
  type AgentConversationCreateRequest,
  type AgentExecutionReceiptCreateRequest,
  type AgentProposalConfirmRequest,
  type CanvasControlReceiptRequest,
  type CloudProjectCreateRequest,
  type CloudProjectInvitation,
  type CloudProjectMember,
  type CloudProjectSaveRequest,
  type CloudResourceCleanupRequest,
  type IdentityLoginRequest,
  type IdentityRegisterRequest,
  type MediaUploadRequest,
  type MediaKind,
  type ModelModality,
  type MusicLinkResolveResponse,
  type PublicGenerationJob,
  type PublicMedia,
  type WalletCheckoutRequest,
  type WalletRedeemRequest,
} from "@weftcanvas/contracts";

type Parser<T> = { parse(value: unknown): T };

const GENERATION_SUBMIT_TIMEOUT_MS = 6_000;
const GENERATION_SUBMIT_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const GENERATION_EVENT_SILENCE_TIMEOUT_MS = 30_000;
const GENERATION_FETCH_TIMEOUT_MS = 12_000;
const OBSERVATION_MAX_BACKOFF_MS = 30_000;
// Consecutive transport failures (SSE disconnects, poll fetch errors, 5xx/429
// statuses) that stop observation once spent. This budget is separate from the
// version/progress-stagnation budget: a successful fetch of the same
// nonterminal snapshot proves transport recovered and must not itself reset
// every no-progress/exhaustion deadline indefinitely.
const OBSERVATION_MAX_TRANSPORT_FAILURES = 8;
// A job whose public snapshot (version/status/progress) never advances for a
// conservative state-aware window stops spinning and marks the node with the
// explicit temporarily-unavailable state instead of an ordinary running
// animation forever. Legitimate long-running image/video jobs keep advancing
// (any version/status/progress change resets the marker); a genuine long
// stall is truthful and safely recoverable on project reopen. `submission_unknown`
// is excluded: it keeps its existing read-only recovery semantics.
const OBSERVATION_STAGNATION_WINDOW_MS = 60 * 60_000;
const OBSERVATION_STAGNATION_WINDOW_BY_STATUS: Readonly<Record<string, number>> = {
  submitting: 30 * 60_000,
  queued: 60 * 60_000,
  running: 60 * 60_000,
  validating: 30 * 60_000,
};
// A delivery-count backstop for the same stagnant snapshot so a throttled or
// clock-skewed tab still converges, independent of wall-clock timers.
const OBSERVATION_STAGNATION_MAX_DELIVERIES = 2400;
const TRANSIENT_REQUEST_TIMEOUT_MS = 8_000;
const TRANSIENT_REQUEST_RETRY_DELAYS_MS = [250, 750] as const;
// 素材确认完成的退避要明显宽于普通读请求：服务端那次失败本身就等过一轮连接
// 超时（约 5 秒），紧接着重试大概率还落在同一段抖动里。两次重试总计约 4 秒
// 等待，在存储真的不可用时会由服务端快速失败兜住，不会把用户晾着。
const MEDIA_COMPLETE_RETRY_DELAYS_MS = [700, 3_000] as const;
const MULTIPART_UPLOAD_CONCURRENCY = 4;
const MULTIPART_RECONCILE_TIMEOUT_MS = 120_000;
const MULTIPART_RECONCILE_INITIAL_DELAY_MS = 500;

export class CanvasApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
    readonly currentRevision: number | null = null,
  ) {
    super(message);
    this.name = "CanvasApiError";
  }
}

export async function fetchIdentityState() {
  return requestWithTransientRetry("/api/v1/auth/session", identitySessionStateResponseSchema);
}

export async function loginIdentity(value: IdentityLoginRequest) {
  return requestWithTransientRetry(
    "/api/v1/auth/login",
    identitySessionResponseSchema,
    jsonRequest("POST", value),
  );
}

export async function registerIdentity(value: IdentityRegisterRequest) {
  return request(
    "/api/v1/auth/register",
    identityRegistrationResponseSchema,
    jsonRequest("POST", value),
  );
}

export async function logoutIdentity() {
  await request("/api/v1/auth/logout", identityLogoutResponseSchema, { method: "POST" });
}

export async function listCloudProjects() {
  const response = await request("/api/v1/cloud-projects", cloudProjectListResponseSchema);
  return response.data;
}

export async function fetchCloudProject(projectId: string, projectOwnerId?: string) {
  const response = await request(
    cloudProjectPath(projectId, projectOwnerId),
    cloudProjectResponseSchema,
  );
  return response.data;
}

export async function createCloudProject(value: CloudProjectCreateRequest) {
  const response = await request(
    "/api/v1/cloud-projects",
    cloudProjectResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function saveCloudProject(
  projectId: string,
  value: CloudProjectSaveRequest,
  projectOwnerId?: string,
) {
  const response = await request(
    cloudProjectPath(projectId, projectOwnerId),
    cloudProjectResponseSchema,
    jsonRequest("PUT", value),
  );
  return response.data;
}

export async function deleteCloudProject(projectId: string, baseRevision: number) {
  await request(
    `/api/v1/cloud-projects/${encodeURIComponent(projectId)}?baseRevision=${encodeURIComponent(String(baseRevision))}`,
    cloudProjectDeleteResponseSchema,
    { method: "DELETE" },
  );
}

/** 删除未被云项目引用的服务端素材，释放账号存储配额。 */
export async function deleteServerMedia(mediaId: string): Promise<PublicMedia> {
  const response = await request(
    `/api/v1/media/${encodeURIComponent(mediaId)}`,
    mediaResponseSchema,
    { method: "DELETE" },
  );
  return response.data;
}

/** 盘点账号下全部云端素材及其项目绑定关系，用于“清理云端资源”。 */
export async function listCloudResources() {
  const response = await request("/api/v1/media", cloudResourceListResponseSchema);
  return response.data;
}

/** 自选清理云端素材：遗留素材直接删；「使用中」素材需带 forceUnbound（调用方已二次确认并缓存本地）。被云项目引用的 id 会原样跳过。 */
export async function cleanupCloudResources(value: CloudResourceCleanupRequest) {
  const response = await request(
    "/api/v1/media/cleanup",
    cloudResourceCleanupResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function listCloudProjectMembers(
  projectId: string,
  projectOwnerId?: string,
): Promise<{
  members: CloudProjectMember[];
  invitations: CloudProjectInvitation[];
  seatUsage?: { limit: number; used: number } | null;
}> {
  const response = await request(
    `${cloudProjectPath(projectId, projectOwnerId, "/members")}`,
    cloudProjectMemberListResponseSchema,
  );
  return response.data;
}

function cloudProjectPath(projectId: string, projectOwnerId?: string, suffix = "") {
  const path = `/api/v1/cloud-projects/${encodeURIComponent(projectId)}${suffix}`;
  if (!projectOwnerId) return path;
  return `${path}?ownerId=${encodeURIComponent(projectOwnerId)}`;
}

export async function inviteCloudProjectMember(
  projectId: string,
  inviteeId: string,
): Promise<CloudProjectInvitation> {
  const response = await request(
    `/api/v1/cloud-projects/${encodeURIComponent(projectId)}/members/invitations`,
    cloudProjectInvitationResponseSchema,
    jsonRequest("POST", { inviteeId }),
  );
  return response.data;
}

export async function removeCloudProjectMember(projectId: string, memberId: string) {
  await request(
    `/api/v1/cloud-projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}`,
    cloudProjectDeleteResponseSchema,
    { method: "DELETE" },
  );
}

export async function revokeCloudProjectInvitation(projectId: string, invitationId: string) {
  await request(
    `/api/v1/cloud-projects/${encodeURIComponent(projectId)}/members/invitations/${encodeURIComponent(invitationId)}`,
    cloudProjectDeleteResponseSchema,
    { method: "DELETE" },
  );
}

export async function listCloudProjectInvitations(): Promise<CloudProjectInvitation[]> {
  const response = await request(
    "/api/v1/cloud-project-invitations",
    cloudProjectInvitationListResponseSchema,
  );
  return response.data.invitations;
}

export async function acceptCloudProjectInvitation(
  invitationId: string,
): Promise<CloudProjectMember> {
  const response = await request(
    `/api/v1/cloud-project-invitations/${encodeURIComponent(invitationId)}/accept`,
    cloudProjectMemberResponseSchema,
    jsonRequest("POST", {}),
  );
  return response.data;
}

export async function declineCloudProjectInvitation(invitationId: string) {
  await request(
    `/api/v1/cloud-project-invitations/${encodeURIComponent(invitationId)}`,
    cloudProjectDeleteResponseSchema,
    { method: "DELETE" },
  );
}

export async function fetchWallet() {
  const response = await request("/api/v1/wallet", walletResponseSchema);
  return response.data;
}

export async function fetchWalletLedger(limit = 20) {
  const query = new URLSearchParams({ limit: String(limit) });
  const response = await request(`/api/v1/wallet/ledger?${query}`, walletLedgerResponseSchema);
  return response.data.items;
}

export async function fetchWalletProducts() {
  const response = await request("/api/v1/wallet/products", walletProductsResponseSchema);
  return {
    products: response.data,
    customCreditTopUp: response.customCreditTopUp ?? null,
  };
}

export async function fetchMembershipTasks() {
  const response = await requestWithTransientRetry(
    "/api/v1/membership/tasks",
    membershipTaskCenterResponseSchema,
  );
  return response.data;
}

export async function claimMembershipTask(taskKey: string) {
  const response = await request(
    `/api/v1/membership/tasks/${encodeURIComponent(taskKey)}/claim`,
    membershipTaskActionResponseSchema,
    jsonRequest("POST", {}),
  );
  return response.data;
}

export async function recordCanvasNodeCreated() {
  const response = await requestWithTransientRetry(
    "/api/v1/membership/tasks/canvas-create-node",
    membershipTaskActionResponseSchema,
    jsonRequest("POST", {}),
  );
  return response.data;
}

export async function createWalletCheckout(value: WalletCheckoutRequest) {
  const response = await request(
    "/api/v1/wallet/checkout",
    walletCheckoutResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function fetchWalletOrder(orderNo: string) {
  const response = await request(
    `/api/v1/wallet/orders/${encodeURIComponent(orderNo)}`,
    walletOrderResponseSchema,
  );
  return response.data;
}

export async function redeemWalletCode(value: WalletRedeemRequest) {
  const response = await request(
    "/api/v1/wallet/redeem",
    walletRedeemResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function listAgentConversations(projectId: string, limit = 30) {
  const query = new URLSearchParams({ projectId, limit: String(limit) });
  const response = await request(
    `/api/v1/agent/conversations?${query}`,
    agentConversationListResponseSchema,
  );
  return response.data;
}

export async function fetchAgentModels(force = false) {
  const path = force ? `/api/v1/agent/models?refresh=${Date.now()}` : "/api/v1/agent/models";
  const response = await request(path, agentModelCatalogResponseSchema);
  return response.data;
}

export async function createAgentConversation(value: AgentConversationCreateRequest) {
  const response = await request(
    "/api/v1/agent/conversations",
    agentConversationResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function fetchAgentConversation(conversationId: string) {
  const response = await request(
    `/api/v1/agent/conversations/${encodeURIComponent(conversationId)}`,
    agentConversationDetailResponseSchema,
  );
  return response.data;
}

export async function submitAgentMessage(conversationId: string, value: AgentMessageCreateRequest) {
  const response = await request(
    `/api/v1/agent/conversations/${encodeURIComponent(conversationId)}/messages`,
    agentConversationDetailResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function cancelAgentRun(conversationId: string, runId: string) {
  const response = await request(
    `/api/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/cancel`,
    agentConversationDetailResponseSchema,
    { method: "POST" },
  );
  return response.data;
}

export async function confirmAgentProposal(
  conversationId: string,
  runId: string,
  value: AgentProposalConfirmRequest,
) {
  const response = await request(
    `/api/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/proposal/confirm`,
    agentConversationDetailResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function dismissAgentProposal(conversationId: string, runId: string) {
  const response = await request(
    `/api/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/proposal/dismiss`,
    agentConversationDetailResponseSchema,
    { method: "POST" },
  );
  return response.data;
}

export async function recordAgentExecutionReceipt(
  conversationId: string,
  runId: string,
  value: AgentExecutionReceiptCreateRequest,
) {
  const response = await request(
    `/api/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/receipt`,
    agentConversationDetailResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

/** 本机连接（Codex / Blender）状态与开关。 */
export async function fetchAgentConnectors(force = false) {
  const path = force
    ? `/api/v1/agent/connectors?refresh=${Date.now()}`
    : "/api/v1/agent/connectors";
  const response = await request(path, agentConnectorListResponseSchema, {
    signal: AbortSignal.timeout(12_000),
  });
  return response.data;
}

export async function updateAgentConnector(
  id: AgentConnectorId,
  value: AgentConnectorUpdateRequest,
) {
  const response = await request(
    `/api/v1/agent/connectors/${encodeURIComponent(id)}`,
    agentConnectorResponseSchema,
    { ...jsonRequest("PUT", value), signal: AbortSignal.timeout(15_000) },
  );
  return response.data;
}

/**
 * 一键接入：运行时自己写 Codex 配置 / 安装 Blender 插件 / 启动 Blender。
 * 可能要几十秒（Blender 后台启用一次），所以超时给得比较宽。
 */
export async function connectAgentConnector(
  id: AgentConnectorId,
  options: { launch?: boolean } = {},
) {
  const response = await request(
    `/api/v1/agent/connectors/${encodeURIComponent(id)}/connect`,
    agentConnectorResponseSchema,
    { ...jsonRequest("POST", options), signal: AbortSignal.timeout(180_000) },
  );
  return response.data;
}

/** 画布页面轮询外部连接下发的指令，顺带上报当前画布摘要。 */
export async function pollCanvasControlCommands(projectId: string, context?: AgentCanvasContext) {
  const response = await request(
    "/api/v1/agent/canvas-control/pending",
    canvasControlPendingResponseSchema,
    {
      ...jsonRequest("POST", { projectId, ...(context ? { context } : {}) }),
      signal: AbortSignal.timeout(8_000),
    },
  );
  return response.data.commands;
}

export async function sendCanvasControlReceipt(value: CanvasControlReceiptRequest) {
  const response = await request(
    "/api/v1/agent/canvas-control/receipts",
    canvasControlReceiptResponseSchema,
    { ...jsonRequest("POST", value), signal: AbortSignal.timeout(8_000) },
  );
  return response.data.accepted;
}

/**
 * 用户侧反向连接：用户的 Blender / Codex 主动连到画布服务端，用配对令牌鉴权。
 * 生成的明文令牌只返回一次，面板需要立刻展示给用户复制。
 */
export async function fetchConnectorClients() {
  const response = await request(
    "/api/v1/agent/connectors/clients",
    connectorClientListResponseSchema,
    {
      signal: AbortSignal.timeout(12_000),
    },
  );
  return response.data;
}

export async function createConnectorPairing(connectorId: AgentConnectorId) {
  const response = await request(
    "/api/v1/agent/connectors/pairing",
    connectorPairingResponseSchema,
    { ...jsonRequest("POST", { connectorId }), signal: AbortSignal.timeout(15_000) },
  );
  return response.data;
}

export async function revokeConnectorPairing(connectorId: AgentConnectorId) {
  const response = await request(
    `/api/v1/agent/connectors/pairing/${encodeURIComponent(connectorId)}`,
    connectorPairingRevokeResponseSchema,
    { method: "DELETE", signal: AbortSignal.timeout(15_000) },
  );
  return response.data.revoked;
}

/** 在用户自己的机器上跑一条任务并等结果（面板「测试连接」）。 */
export async function runConnectorTask(value: {
  connectorId: AgentConnectorId;
  method: "ping" | "run_python";
  params: Record<string, unknown>;
  waitMs?: number;
}) {
  const response = await request("/api/v1/agent/connectors/tasks", externalTaskRunResponseSchema, {
    ...jsonRequest("POST", value),
    signal: AbortSignal.timeout(90_000),
  });
  return response.data;
}

export async function fetchModelCatalog(modality?: ModelModality, force = false) {
  const params = new URLSearchParams();
  if (modality) params.set("modality", modality);
  if (force) params.set("refresh", "1");
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await requestWithTransientRetry(
    `/api/v1/model-catalog${query}`,
    modelCatalogResponseSchema,
  );
  return response.data;
}

export async function createGenerationQuote(value: GenerationQuoteRequest) {
  const response = await requestWithTransientRetry(
    "/api/v1/generation-quotes",
    generationQuoteResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function submitGenerationJob(value: GenerationJobSubmission) {
  const init = jsonRequest("POST", value);
  for (let attempt = 0; attempt <= GENERATION_SUBMIT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await request("/api/v1/generation-jobs", generationJobResponseSchema, {
        ...init,
        signal: AbortSignal.timeout(GENERATION_SUBMIT_TIMEOUT_MS),
      });
      return response.data;
    } catch (error) {
      // A dropped response does not prove the server rejected the request. All
      // attempts reuse the same idempotency key, so a recovered connection
      // returns the one durable task without another upstream debit.
      if (!isTransientRequestError(error) || attempt === GENERATION_SUBMIT_RETRY_DELAYS_MS.length)
        throw error;
      await delay(GENERATION_SUBMIT_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
  throw new CanvasApiError(0, "NETWORK_UNAVAILABLE", "无法连接画布服务");
}

export async function fetchGenerationJob(jobId: string) {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), GENERATION_FETCH_TIMEOUT_MS);
  try {
    const response = await request(
      `/api/v1/generation-jobs/${encodeURIComponent(jobId)}`,
      generationJobResponseSchema,
      { signal: controller.signal },
    );
    return response.data;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Authoritative read-only reconciliation of one durable generation request by
 * its existing idempotency identity. A 404 is the unambiguous miss used to
 * settle an expired request; every other non-OK status is thrown so the caller
 * can keep a still-recent request protected. This never submits or replays.
 */
export async function reconcileGenerationJob(key: string): Promise<PublicGenerationJob | null> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), GENERATION_FETCH_TIMEOUT_MS);
  try {
    const query = new URLSearchParams({ key });
    let response: Response;
    try {
      response = await fetch(`/api/v1/generation-jobs/reconcile?${query}`, {
        credentials: "include",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } catch {
      throw new CanvasApiError(0, "NETWORK_UNAVAILABLE", "无法连接画布服务");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError(response);
    try {
      return generationJobResponseSchema.parse(await response.json()).data;
    } catch {
      throw new CanvasApiError(response.status, "INVALID_RESPONSE", "画布服务返回了无法识别的数据");
    }
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function listGenerationJobs(projectId: string, limit = 50) {
  const query = new URLSearchParams({ projectId, limit: String(limit) });
  const response = await request(
    `/api/v1/generation-jobs?${query}`,
    generationJobListResponseSchema,
  );
  return response.data;
}

export async function createMediaUpload(value: MediaUploadRequest) {
  const response = await request(
    "/api/v1/media/uploads",
    mediaUploadIntentResponseSchema,
    jsonRequest("POST", value),
  );
  return response.data;
}

export async function fetchMediaMetadata(mediaId: string, projectId?: string) {
  const path = `/api/v1/media/${encodeURIComponent(mediaId)}`;
  const query = projectId ? `?${new URLSearchParams({ projectId })}` : "";
  const response = await request(`${path}${query}`, mediaResponseSchema);
  return response.data;
}

export async function createProviderMediaReference(
  mediaId: string,
  kind: MediaKind,
  projectId?: string,
) {
  const response = await request(
    `/api/v1/media/${encodeURIComponent(mediaId)}/provider-reference`,
    providerMediaReferenceResponseSchema,
    jsonRequest("POST", { kind, ...(projectId ? { projectId } : {}) }),
  );
  return response.data.url;
}

export function mediaContentPath(
  mediaId: string,
  projectId?: string,
  options?: { download?: boolean; variant?: "thumb" },
) {
  const path = `/api/v1/media/${encodeURIComponent(mediaId)}/content`;
  const query = new URLSearchParams();
  if (projectId) query.set("projectId", projectId);
  if (options?.download) query.set("download", "1");
  if (options?.variant) query.set("variant", options.variant);
  const value = query.toString();
  return value ? `${path}?${value}` : path;
}

/**
 * 音乐链接解析：服务端代拉平台页/直链判定可用性，返回标题、封面与同源
 * 代理路径（streamPath/coverPath 可直接喂给 <audio>/<img>）。
 */
export function resolveMusicLink(url: string) {
  return request<MusicLinkResolveResponse>(
    `/api/v1/music/resolve?url=${encodeURIComponent(url)}`,
    musicLinkResolveResponseSchema,
  );
}

export async function uploadMediaBlob(
  media: PublicMedia,
  instruction: NonNullable<Awaited<ReturnType<typeof createMediaUpload>>["upload"]>,
  blob: Blob,
) {
  if (instruction.strategy === "multipart") {
    return uploadMultipartMediaBlob(media, instruction, blob);
  }

  const target = new URL(instruction.url, window.location.href);
  let response: Response;
  try {
    response = await fetch(target, {
      method: instruction.method,
      headers: instruction.headers,
      body: blob,
      credentials: target.origin === window.location.origin ? "include" : "omit",
    });
  } catch {
    throw new CanvasApiError(0, "MEDIA_UPLOAD_INTERRUPTED", "素材上传连接中断，请重试");
  }
  if (!response.ok) throw await responseError(response);

  if (instruction.completeUrl) {
    return await completeMediaUpload(instruction.completeUrl);
  }

  if (response.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    try {
      const payload = mediaResponseSchema.parse(await response.json());
      return payload.data;
    } catch {
      throw new CanvasApiError(response.status, "INVALID_RESPONSE", "素材服务返回了无法识别的数据");
    }
  }
  return media;
}

/**
 * 确认上传完成（把隔离区字节提升为正式对象）这一步由服务端去访问对象存储，
 * 因此它是"素材已传上去、但服务端一时够不到存储"的唯一失败点。此时字节通常
 * 已经落在隔离区，重新确认一次就能成功，而让用户重新选文件再传一遍代价高得
 * 多——所以这里按有界退避重试，只重试"暂时性"的失败：网络中断、429/5xx
 * （含存储不可达），以及并发确认时的"正在处理中"。
 * 素材本身不合格（大小/类型/校验，4xx 非 429）立即失败，不做无谓等待。
 */
async function completeMediaUpload(completeUrl: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const completed = await request(completeUrl, mediaResponseSchema, { method: "POST" });
      return completed.data;
    } catch (error) {
      if (!isRetryableMediaCompletion(error) || attempt >= MEDIA_COMPLETE_RETRY_DELAYS_MS.length)
        throw error;
      await delay(MEDIA_COMPLETE_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}

function isRetryableMediaCompletion(error: unknown) {
  if (!(error instanceof CanvasApiError)) return false;
  if (isTransientRequestError(error)) return true;
  // 同一次上传的确认还在服务端处理中（并发确认或上一次请求被中断）：
  // 稍后重试会拿到已就绪的结果，而不是失败。
  return error.status === 409 && error.code === "MEDIA_UPLOAD_IN_PROGRESS";
}

// Multipart URLs are short-lived and the API caps each signing request, so sign
// and upload bounded batches instead of retaining every signed URL in memory.
async function uploadMultipartMediaBlob(
  media: PublicMedia,
  instruction: Extract<
    NonNullable<Awaited<ReturnType<typeof createMediaUpload>>["upload"]>,
    { strategy: "multipart" }
  >,
  blob: Blob,
) {
  try {
    for (
      let firstPart = 1;
      firstPart <= instruction.partCount;
      firstPart += MEDIA_MULTIPART_MAX_SIGNED_PARTS
    ) {
      const partNumbers = Array.from(
        {
          length: Math.min(MEDIA_MULTIPART_MAX_SIGNED_PARTS, instruction.partCount - firstPart + 1),
        },
        (_, index) => firstPart + index,
      );
      const signed = await request(
        instruction.signPartsUrl,
        mediaMultipartPartInstructionsResponseSchema,
        jsonRequest("POST", { partNumbers }),
      );
      if (
        signed.data.sessionId !== instruction.sessionId ||
        signed.data.parts.length !== partNumbers.length
      ) {
        throw new CanvasApiError(
          0,
          "MEDIA_MULTIPART_INVALID_INSTRUCTIONS",
          "素材服务返回了不完整的分片上传指令",
        );
      }
      const expectedParts = new Set(partNumbers);
      if (
        signed.data.parts.some((part) => !expectedParts.delete(part.partNumber)) ||
        expectedParts.size
      ) {
        throw new CanvasApiError(
          0,
          "MEDIA_MULTIPART_INVALID_INSTRUCTIONS",
          "素材服务返回了不匹配的分片上传指令",
        );
      }
      await uploadMultipartPartBatch(signed.data.parts, blob, instruction.partSize);
    }

    const completed = await request(
      instruction.completeUrl,
      mediaMultipartCompleteResponseSchema,
      jsonRequest("POST", {}),
    );
    return reconcileMultipartMedia(instruction.reconcileUrl, completed.data, media);
  } catch (error) {
    await abortMultipartUpload(instruction.abortUrl);
    throw error;
  }
}

async function uploadMultipartPartBatch(
  parts: Array<{ partNumber: number; method: "PUT"; url: string; headers: Record<string, string> }>,
  blob: Blob,
  partSize: number,
) {
  let nextPartIndex = 0;
  const workerCount = Math.min(MULTIPART_UPLOAD_CONCURRENCY, parts.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextPartIndex < parts.length) {
        const part = parts[nextPartIndex];
        nextPartIndex += 1;
        if (!part) return;
        const start = (part.partNumber - 1) * partSize;
        const response = await uploadBlobToTarget(
          part.url,
          part.method,
          part.headers,
          blob.slice(start, start + partSize),
        );
        if (!response.ok) throw await responseError(response);
      }
    }),
  );
}

async function uploadBlobToTarget(
  url: string,
  method: "PUT",
  headers: Record<string, string>,
  body: Blob,
) {
  const target = new URL(
    url,
    typeof window === "undefined" ? "http://canvas.local" : window.location.href,
  );
  try {
    return await fetch(target, {
      method,
      headers,
      body,
      credentials:
        target.origin ===
        (typeof window === "undefined" ? "http://canvas.local" : window.location.origin)
          ? "include"
          : "omit",
    });
  } catch {
    throw new CanvasApiError(0, "MEDIA_UPLOAD_INTERRUPTED", "素材上传连接中断，请重试");
  }
}

async function reconcileMultipartMedia(
  reconcileUrl: string,
  initial: Awaited<ReturnType<typeof mediaMultipartCompleteResponseSchema.parse>>["data"],
  fallbackMedia: PublicMedia,
) {
  let state = initial;
  const deadline = Date.now() + MULTIPART_RECONCILE_TIMEOUT_MS;
  let delayMs = MULTIPART_RECONCILE_INITIAL_DELAY_MS;

  while (state.media.status !== "ready") {
    if (state.phase === "failed" || state.phase === "aborted" || state.media.status === "failed") {
      throw new CanvasApiError(
        409,
        state.media.error?.code ?? "MEDIA_MULTIPART_FAILED",
        state.media.error?.message ?? "素材分片上传未完成",
      );
    }
    if (Date.now() >= deadline) {
      throw new CanvasApiError(
        504,
        "MEDIA_MULTIPART_PROCESSING_TIMEOUT",
        "素材上传已完成，服务端校验超时，请稍后重试",
      );
    }
    await delay(delayMs);
    delayMs = Math.min(3_000, Math.round(delayMs * 1.5));
    const response = await request(reconcileUrl, mediaMultipartUploadStateResponseSchema);
    state = response.data;
  }
  return state.media ?? fallbackMedia;
}

async function abortMultipartUpload(abortUrl: string) {
  try {
    await request(abortUrl, mediaMultipartUploadStateResponseSchema, jsonRequest("DELETE", {}));
  } catch {
    // Preserve the upload error. The server also expires unfinished sessions.
  }
}

export function createRequestKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function subscribeGenerationJob(
  jobId: string,
  handlers: {
    onJob: (job: PublicGenerationJob) => void;
    onSessionExpired?: () => void;
    onObservationExhausted?: () => void;
  },
) {
  let active = true;
  let source: EventSource | null = null;
  let pollTimer: number | null = null;
  let eventWatchdogTimer: number | null = null;
  let eventFailures = 0;
  let transportFailures = 0;
  let pollDelay = 2_000;
  let highestVersion = -1;
  let unknownSince: number | null = null;
  let lastSnapshotSignature: string | null = null;
  let noProgressDeliveries = 0;
  let noProgressSince: number | null = null;

  const unknownFastRetryInterval = 3_000;
  const unknownSlowRetryInterval = 30_000;
  const unknownFastRetryWindow = 2 * 60_000;

  const recordTransportSuccess = () => {
    transportFailures = 0;
  };

  // SSE 429/5xx/disconnects and poll fetch timeouts back off with a cap; once
  // the consecutive transport-failure budget is spent, observation stops and
  // releases the EventSource/fetch/timers instead of polling forever.
  const recordTransportFailure = () => {
    transportFailures += 1;
    if (transportFailures >= OBSERVATION_MAX_TRANSPORT_FAILURES) {
      handlers.onObservationExhausted?.();
      stop();
    }
  };

  const observationStagnationWindowMs = (status: string) =>
    OBSERVATION_STAGNATION_WINDOW_BY_STATUS[status] ?? OBSERVATION_STAGNATION_WINDOW_MS;

  // A successful fetch of the same nonterminal version is transport success but
  // not job progress: it must not reset the no-progress/exhaustion deadline
  // indefinitely. A snapshot whose version/status/progress signature never
  // changes accrues a conservative state-aware stagnation window and a
  // delivery-count backstop; any advance resets both.
  const recordSnapshotForProgress = (job: PublicGenerationJob) => {
    if (job.status === "submission_unknown") {
      // submission_unknown keeps its existing read-only recovery semantics and
      // its own fast/slow polling cadence, so it is excluded from the
      // no-progress budget and resets the marker for a later genuine advance.
      lastSnapshotSignature = null;
      noProgressDeliveries = 0;
      noProgressSince = null;
      return;
    }
    const signature = `${job.id}:${job.version}:${job.status}:${job.progress ?? ""}`;
    if (signature === lastSnapshotSignature) {
      noProgressSince ??= Date.now();
      noProgressDeliveries += 1;
      if (
        Date.now() - noProgressSince >= observationStagnationWindowMs(job.status) ||
        noProgressDeliveries >= OBSERVATION_STAGNATION_MAX_DELIVERIES
      ) {
        handlers.onObservationExhausted?.();
        stop();
      }
      return;
    }
    lastSnapshotSignature = signature;
    noProgressDeliveries = 0;
    noProgressSince = null;
  };

  const deliver = (job: PublicGenerationJob) => {
    if (!active) return;
    if (job.version > highestVersion) {
      highestVersion = job.version;
      handlers.onJob(job);
    }
    if (isFinalJob(job)) {
      stop();
      return;
    }
    if (job.status === "submission_unknown") {
      unknownSince ??= Date.now();
      recordTransportSuccess();
      recordSnapshotForProgress(job);
      return;
    }
    unknownSince = null;
    recordTransportSuccess();
    recordSnapshotForProgress(job);
  };

  const schedulePoll = (delay = pollDelay) => {
    if (!active) return;
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => void poll(), delay);
  };

  const clearEventWatchdog = () => {
    if (eventWatchdogTimer !== null) window.clearTimeout(eventWatchdogTimer);
    eventWatchdogTimer = null;
  };

  const armEventWatchdog = () => {
    clearEventWatchdog();
    if (!active || !source) return;
    eventWatchdogTimer = window.setTimeout(() => {
      eventWatchdogTimer = null;
      startPolling();
    }, GENERATION_EVENT_SILENCE_TIMEOUT_MS);
  };

  const poll = async () => {
    if (!active) return;
    try {
      const job = await fetchGenerationJob(jobId);
      pollDelay = 2_000;
      deliver(job);
      if (active)
        schedulePoll(job.status === "submission_unknown" ? unknownPollDelay() : pollDelay);
    } catch (cause) {
      if (cause instanceof CanvasApiError && cause.status === 401) {
        handlers.onSessionExpired?.();
        stop();
        return;
      }
      recordTransportFailure();
      if (!active) return;
      const retryAfter =
        cause instanceof CanvasApiError && cause.retryAfterSeconds !== null
          ? cause.retryAfterSeconds * 1_000
          : 0;
      pollDelay = Math.max(
        retryAfter,
        Math.min(OBSERVATION_MAX_BACKOFF_MS, Math.round(pollDelay * 1.6)),
      );
      schedulePoll(pollDelay);
    }
  };

  const startPolling = () => {
    clearEventWatchdog();
    source?.close();
    source = null;
    schedulePoll(0);
  };

  const unknownPollDelay = () =>
    unknownSince !== null && Date.now() - unknownSince >= unknownFastRetryWindow
      ? unknownSlowRetryInterval
      : unknownFastRetryInterval;

  const startEvents = () => {
    if (typeof EventSource === "undefined") {
      startPolling();
      return;
    }
    source = new EventSource(`/api/v1/generation-jobs/${encodeURIComponent(jobId)}/events`, {
      withCredentials: true,
    });
    source.onopen = armEventWatchdog;
    source.addEventListener("job", (event) => {
      try {
        const payload = generationJobEventSchema.parse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        eventFailures = 0;
        deliver(payload.job);
        if (active && payload.job.status === "submission_unknown") startPolling();
        else armEventWatchdog();
      } catch {
        startPolling();
      }
    });
    source.addEventListener("status-error", startPolling);
    source.onerror = () => {
      eventFailures += 1;
      recordTransportFailure();
      if (!active) return;
      if (eventFailures >= 2) startPolling();
      else armEventWatchdog();
    };
    armEventWatchdog();
  };

  const stop = () => {
    if (!active) return;
    active = false;
    source?.close();
    source = null;
    clearEventWatchdog();
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
  };

  startEvents();
  return stop;
}

function isFinalJob(job: PublicGenerationJob) {
  return job.status === "completed" || job.status === "failed";
}

function isTransientRequestError(error: unknown) {
  return (
    error instanceof CanvasApiError &&
    (error.code === "NETWORK_UNAVAILABLE" ||
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500)
  );
}

async function requestWithTransientRetry<T>(
  path: string,
  schema: Parser<T>,
  init: RequestInit = {},
) {
  for (let attempt = 0; attempt <= TRANSIENT_REQUEST_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await request(path, schema, {
        ...init,
        signal: AbortSignal.timeout(TRANSIENT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (!isTransientRequestError(error) || attempt === TRANSIENT_REQUEST_RETRY_DELAYS_MS.length)
        throw error;
      await delay(TRANSIENT_REQUEST_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
  throw new CanvasApiError(0, "NETWORK_UNAVAILABLE", "无法连接画布服务");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function jsonRequest(method: "POST" | "PUT" | "DELETE", value: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

async function request<T>(path: string, schema: Parser<T>, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      signal: init.signal ?? AbortSignal.timeout(20_000),
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch {
    throw new CanvasApiError(0, "NETWORK_UNAVAILABLE", "无法连接画布服务");
  }
  if (!response.ok) throw await responseError(response);
  try {
    return schema.parse(await response.json());
  } catch {
    throw new CanvasApiError(response.status, "INVALID_RESPONSE", "画布服务返回了无法识别的数据");
  }
}

async function responseError(response: Response) {
  let code = "REQUEST_FAILED";
  let message = response.status >= 500 ? "服务暂时不可用" : "请求没有完成";
  try {
    const parsed = apiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
    }
  } catch {
    // Keep the public fallback and never surface raw service bodies.
  }
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfter = retryAfterHeader === null ? null : Number(retryAfterHeader);
  const currentRevisionHeader = response.headers.get("X-Canvas-Current-Revision");
  const currentRevision = currentRevisionHeader === null ? null : Number(currentRevisionHeader);
  return new CanvasApiError(
    response.status,
    code,
    message,
    retryAfter !== null && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
    currentRevision !== null && Number.isSafeInteger(currentRevision) && currentRevision > 0
      ? currentRevision
      : null,
  );
}
