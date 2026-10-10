import {
  cardLibraryCardListResponseSchema,
  cardLibraryGroupListResponseSchema,
  cardLibraryMediaSignResponseSchema,
  cardLibraryTagListResponseSchema,
  communityFeedResponseSchema,
  identityLoginRequestSchema,
  identityRegisterRequestSchema,
  membershipTaskActionResponseSchema,
  membershipTaskCenterResponseSchema,
  publicIdentityUserSchema,
  walletCheckoutRequestSchema,
  walletCheckoutResponseSchema,
  walletLedgerUpstreamResponseSchema,
  walletOrderResponseSchema,
  walletProductsResponseSchema,
  walletRedeemRequestSchema,
  walletResponseSchema,
  type IdentityCapabilities,
  type PublicIdentityUser,
  type WalletCheckoutRequest,
  type WalletRedeemRequest,
} from "@kachang/contracts";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

import {
  IdentityProviderError,
  type IdentityProvider,
  type IdentityRegistrationResult,
  type IssuedIdentitySession,
  type ResolvedIdentitySession,
} from "./provider.js";
import {
  WalletProviderError,
  type MembershipTaskProvider,
  type WalletCreditOperationInput,
  type WalletProvider,
  type WalletProviderResult,
} from "../wallet/provider.js";

const authUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable().optional(),
  created_at: z.string().datetime({ offset: true }).optional(),
  user_metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const authTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullable().optional(),
  expires_at: z.number().finite().positive().optional(),
  expires_in: z.number().finite().positive().optional(),
  user: authUserSchema,
}).passthrough();

const authSignupPendingSchema = z.union([
  authUserSchema,
  z.object({ user: authUserSchema }).passthrough(),
]);

const profileIdentitySchema = z.object({
  ok: z.literal(true),
  data: z.object({ displayName: z.string().trim().min(1).max(48) }),
});

const sessionEnvelopeSchema = z.object({
  version: z.literal(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  accessExpiresAt: z.number().int().positive(),
  sessionExpiresAt: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(48).nullable().optional(),
});
type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

/** Agent 轮次扣费/退款：金额为积分整数，与 Prompt Hub 钱包接口校验一致。 */
const walletCreditOperationBodySchema = z.object({
  amount: z.number().int().min(1).max(1000),
  reason: z.string().trim().min(1).max(64),
  refId: z.string().trim().min(1).max(128),
});

const walletCreditOperationResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    balance: z.number().finite(),
    replayed: z.boolean(),
  }),
});

type ResolvedAccess = {
  envelope: SessionEnvelope;
  refreshedToken?: string;
};

type PromptHubProviderOptions = {
  apiBaseUrl: string;
  authBaseUrl: string;
  anonKey: string;
  sessionSecret: string;
  siteUrl: string;
  sessionTtlMs?: number;
  requestTimeoutMs?: number;
  loginRetryDelayMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_LOGIN_RETRY_DELAY_MS = 250;
// 签名接口可能触发上游 _grid 生成/回源（单张实测 4-8s），比常规账号接口慢得多，
// 必须单独放宽超时，否则收藏/翻页会因签名超时而整体失败。
const CARD_MEDIA_SIGN_TIMEOUT_MS = 45_000;
const COMMUNITY_FEED_TIMEOUT_MS = 15_000;
const REFRESH_REUSE_GRACE_MS = 5_000;
const MAX_SESSION_COOKIE_BYTES = 3_800;

export class PromptHubProvider implements IdentityProvider, WalletProvider, MembershipTaskProvider {
  readonly capabilities: IdentityCapabilities;
  private readonly apiBaseUrl: string;
  private readonly authBaseUrl: string;
  private readonly anonKey: string;
  private readonly sessionKey: Buffer;
  private readonly sessionTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly loginRetryDelayMs: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly refreshInFlight = new Map<string, Promise<ResolvedAccess | null>>();
  /**
   * 已登出的密封令牌：sha256(token) -> 该令牌原本的过期时刻。
   * 上游 GoTrue 的 logout 只撤 refresh session，已签发的 access token（JWT）
   * 在自然过期前一直有效，所以登出必须在本侧把这枚令牌直接判失效。
   * 进程内计数：单实例部署完全覆盖；多实例时以其它实例登出的令牌为准的窗口
   * 由上游 refresh 吊销兜底。
   */
  private readonly revokedTokens = new Map<string, number>();

  constructor(options: PromptHubProviderOptions) {
    this.apiBaseUrl = normalizeBase(options.apiBaseUrl);
    this.authBaseUrl = normalizeBase(options.authBaseUrl);
    this.anonKey = required(options.anonKey, "Prompt Hub anonymous key");
    this.sessionKey = createHash("sha256").update(required(options.sessionSecret, "identity session secret"), "utf8").digest();
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, "sessionTtlMs");
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.loginRetryDelayMs = nonNegativeInteger(options.loginRetryDelayMs ?? DEFAULT_LOGIN_RETRY_DELAY_MS, "loginRetryDelayMs");
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    const siteUrl = normalizeBase(options.siteUrl);
    this.capabilities = {
      available: true,
      registration: "native",
      registrationUrl: null,
      passwordResetUrl: siteUrl,
    };
  }

  async register(value: unknown): Promise<IdentityRegistrationResult> {
    const input = identityRegisterRequestSchema.parse(value);
    const { response, payload } = await this.requestJson(`${this.authBaseUrl}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: this.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.email, password: input.password }),
    });
    if (!response.ok) throw registrationRequestError(response.status, payload, retryAfterSeconds(response.headers));

    const authenticated = authTokenSchema.safeParse(payload);
    if (authenticated.success) {
      const requestedDisplayName = input.displayName && isPromptHubDisplayName(input.displayName)
        ? await this.writeProfileDisplayName(authenticated.data.access_token, input.displayName).catch(() => null)
        : null;
      const displayName = requestedDisplayName
        ?? await this.readProfileDisplayName(authenticated.data.access_token).catch(() => null);
      return { status: "authenticated", session: this.issue(authenticated.data, displayName) };
    }

    const pending = authSignupPendingSchema.safeParse(payload);
    if (!pending.success) throw providerUnavailable();
    return { status: "verification_required", email: input.email };
  }

  async login(value: unknown): Promise<IssuedIdentitySession> {
    const input = identityLoginRequestSchema.parse(value);
    const { response, payload } = await this.requestLoginJson(`${this.authBaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: this.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.email, password: input.password }),
    });
    if (!response.ok) throw identityRequestError(response.status, payload, retryAfterSeconds(response.headers));
    const parsed = authTokenSchema.safeParse(payload);
    if (!parsed.success) throw providerUnavailable();
    // The token already carries enough public user data for the first paint.
    // Keep the optional profile API out of the login critical path: on a slow
    // upstream it could add another full timeout after authentication succeeds.
    const displayName = publicUser(parsed.data.user, this.now()).displayName;
    return this.issue(parsed.data, displayName);
  }

  async authenticate(token: string | undefined): Promise<ResolvedIdentitySession | null> {
    const resolved = await this.resolveIdentity(token);
    if (!resolved) return null;
    return {
      user: resolved.user,
      expiresAt: new Date(resolved.envelope.sessionExpiresAt).toISOString(),
      ...(resolved.refreshedToken ? { refreshedToken: resolved.refreshedToken } : {}),
    };
  }

  async logout(token: string | undefined) {
    // Refresh once before logout when the short-lived access token has expired;
    // GoTrue revokes the refresh session only when it receives a valid access token.
    const access = await this.resolveAccess(token).catch(() => null);
    if (token && access) {
      // 本进程内立即判失效，堵住"登出后旧 Cookie 还能用"的窗口。
      this.revokedTokens.set(hashSessionToken(token), access.envelope.sessionExpiresAt);
      this.pruneRevokedTokens();
    }
    if (!access) return;
    await this.fetcher(`${this.authBaseUrl}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: this.anonKey, Authorization: `Bearer ${access.envelope.accessToken}` },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }).catch(() => undefined);
  }

  private pruneRevokedTokens() {
    const now = this.now();
    for (const [key, expiresAtMs] of this.revokedTokens) {
      if (expiresAtMs <= now) this.revokedTokens.delete(key);
    }
  }

  async getSummary(token: string | undefined) {
    return this.accountRequest(token, "/api/v1/me", walletResponseSchema, {}, (value) => value.data);
  }

  async listCards(token: string | undefined, input: { page: number; limit: number; query?: string; group?: string; tag?: string }) {
    const query = new URLSearchParams({ page: String(input.page), limit: String(input.limit) });
    if (input.query) query.set("q", input.query);
    if (input.group) query.set("group", input.group);
    if (input.tag) query.set("tag", input.tag);
    return this.accountRequest(
      token,
      "/api/v1/extension/cards?" + query.toString(),
      cardLibraryCardListResponseSchema,
      {},
      (value) => value.data,
    );
  }

  async listGroups(token: string | undefined) {
    return this.accountRequest(
      token,
      "/api/v1/extension/groups",
      cardLibraryGroupListResponseSchema,
      {},
      (value) => value.data,
    );
  }

  async listTags(token: string | undefined) {
    return this.accountRequest(
      token,
      "/api/v1/extension/tags",
      cardLibraryTagListResponseSchema,
      {},
      (value) => value.data,
    );
  }

  async signCardMedia(token: string | undefined, input: { ref: string; variant: "thumb" | "full" }) {
    const query = new URLSearchParams({ ref: input.ref, variant: input.variant });
    return this.accountRequest(
      token,
      "/api/v1/media/sign?" + query.toString(),
      cardLibraryMediaSignResponseSchema,
      { signal: AbortSignal.timeout(CARD_MEDIA_SIGN_TIMEOUT_MS) },
      (value) => value.data,
    );
  }

  /**
   * 公开社区流（画布「社区卡片」弹层数据源）。上游 GET /api/v1/community/feed
   * 免鉴权，不需要走 accountRequest 的令牌刷新链路；服务端直连还能绕开
   * 浏览器侧的 CORS 依赖（prompt-hub 的 CORS 白名单不含 canvas 域名）。
   */
  async getCommunityFeed(input: { limit: number; offset: number }) {
    const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset) });
    const { response, payload } = await this.requestJson(
      `${this.apiBaseUrl}/api/v1/community/feed?${query.toString()}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(COMMUNITY_FEED_TIMEOUT_MS) },
    );
    if (!response.ok) throw new WalletProviderError(503, "COMMUNITY_FEED_UPSTREAM", "社区数据暂时不可用");
    const parsed = communityFeedResponseSchema.safeParse(payload);
    if (!parsed.success) throw new WalletProviderError(503, "COMMUNITY_FEED_INVALID", "社区数据格式异常");
    return { data: parsed.data.data };
  }

  /**
   * 社区图公开 CDN URL（prompt-hub /api/v1/media/c/<base64url路径>，免签名、
   * 游客可访问）。storage://card-images/<path> 直接推导；https 原样返回；
   * 其他格式返回 null（由调用方走 media-sign 兜底）。
   */
  communityImageUrl(image: string | null | undefined): string | null {
    const ref = (image ?? "").trim();
    if (!ref) return null;
    if (/^https?:\/\//i.test(ref)) return ref;
    const prefix = "storage://card-images/";
    if (!ref.startsWith(prefix)) return null;
    const path = ref.slice(prefix.length).replace(/^\//, "").split("?")[0] || "";
    if (!path || !/\.(jpe?g|png|webp)$/i.test(path)) return null;
    return `${this.apiBaseUrl}/api/v1/media/c/${Buffer.from(path, "utf8").toString("base64url")}`;
  }

  async resolveUpstreamAccess(token: string | undefined, options: { force?: boolean } = {}) {
    const access = await this.resolveAccess(token, options.force === true);
    if (!access) throw new WalletProviderError(401, "UNAUTHENTICATED", "登录已过期，请重新登录");
    return {
      data: { accessToken: access.envelope.accessToken },
      ...(access.refreshedToken ? {
        refreshedToken: access.refreshedToken,
        expiresAt: new Date(access.envelope.sessionExpiresAt).toISOString(),
      } : {}),
    };
  }

  async getLedger(token: string | undefined, limit: number) {
    return this.accountRequest(
      token,
      `/api/v1/me/ledger?limit=${encodeURIComponent(String(limit))}`,
      walletLedgerUpstreamResponseSchema,
      {},
      (value) => value.data.items,
    );
  }

  async getMembershipTasks(token: string | undefined) {
    return this.accountRequest(
      token,
      "/api/v1/membership/tasks",
      membershipTaskCenterResponseSchema,
      {},
      (value) => value.data,
    );
  }

  async claimMembershipTask(token: string | undefined, taskKey: string) {
    return this.accountRequest(
      token,
      `/api/v1/membership/tasks/${encodeURIComponent(taskKey)}/claim`,
      membershipTaskActionResponseSchema,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      (value) => value.data,
    );
  }

  async recordCanvasNodeCreated(token: string | undefined) {
    return this.accountRequest(
      token,
      "/api/v1/membership/tasks/events/canvas-create-node",
      membershipTaskActionResponseSchema,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      (value) => value.data,
    );
  }

  async getProducts(token: string | undefined) {
    return this.accountRequest(
      token,
      "/api/v1/payments/products",
      walletProductsResponseSchema,
      {},
      (value) => ({ products: value.data, customCreditTopUp: value.customCreditTopUp ?? null }),
      "/api/v1/wallet/products",
    );
  }

  async createCheckout(token: string | undefined, input: WalletCheckoutRequest) {
    const body = walletCheckoutRequestSchema.parse(input);
    return this.accountRequest(token, "/api/v1/payments/checkout", walletCheckoutResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, returnTarget: "canvas" }),
    }, (value) => value.data, "/api/v1/wallet/checkout");
  }

  async getOrder(token: string | undefined, orderNo: string) {
    if (!/^PAY[A-Z0-9]+$/.test(orderNo)) throw new WalletProviderError(404, "ORDER_NOT_FOUND", "订单不存在");
    return this.accountRequest(
      token,
      `/api/v1/payments/orders/${encodeURIComponent(orderNo)}`,
      walletOrderResponseSchema,
      {},
      (value) => value.data,
      `/api/v1/wallet/orders/${encodeURIComponent(orderNo)}`,
    );
  }

  async redeem(token: string | undefined, input: WalletRedeemRequest) {
    const body = walletRedeemRequestSchema.parse(input);
    const result = await this.accountRequest(token, "/api/v1/redeem", z.object({
      ok: z.literal(true),
      data: z.object({ message: z.string().trim().min(1).max(500) }),
    }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, (value) => value.data);
    // Redemption is already committed upstream. A transient follow-up balance
    // failure must not turn that success into a retryable-looking error (which
    // would make the next attempt report the code as already redeemed).
    const summary = await this.getSummary(result.refreshedToken ?? token).catch(() => null);
    return {
      data: { message: result.data.message, summary: summary?.data ?? null },
      ...(summary?.refreshedToken || result.refreshedToken ? {
        refreshedToken: summary?.refreshedToken ?? result.refreshedToken,
        expiresAt: summary?.expiresAt ?? result.expiresAt,
      } : {}),
    };
  }

  /**
   * 扣减积分（Agent 每轮固定价）。上游 402 / INSUFFICIENT_CREDITS 由
   * accountRequest → walletRequestError 原样映射为 WalletProviderError
   * (status 402, code INSUFFICIENT_CREDITS)，供上层转成"积分不足"。
   */
  async consumeCredit(token: string | undefined, input: WalletCreditOperationInput) {
    const body = walletCreditOperationBodySchema.parse(input);
    return this.accountRequest(
      token,
      "/api/v1/wallet/consume",
      walletCreditOperationResponseSchema,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      (value) => value.data,
    );
  }

  /** 退款（幂等，按 refId）；上游映射与 consumeCredit 相同。 */
  async refundCredit(token: string | undefined, input: WalletCreditOperationInput) {
    const body = walletCreditOperationBodySchema.parse(input);
    return this.accountRequest(
      token,
      "/api/v1/wallet/refund",
      walletCreditOperationResponseSchema,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      (value) => value.data,
    );
  }

  private issue(value: z.infer<typeof authTokenSchema>, displayName: string | null): IssuedIdentitySession {
    const now = this.now();
    const accessExpiresAt = authExpiry(value, now);
    const sessionExpiresAt = value.refresh_token
      ? now + this.sessionTtlMs
      : Math.min(now + this.sessionTtlMs, accessExpiresAt);
    const envelope: SessionEnvelope = {
      version: 1,
      accessToken: value.access_token,
      refreshToken: value.refresh_token ?? null,
      accessExpiresAt,
      sessionExpiresAt,
      displayName,
    };
    return {
      token: this.seal(envelope),
      user: publicUser(value.user, now, displayName),
      expiresAt: new Date(sessionExpiresAt).toISOString(),
    };
  }

  private async resolveIdentity(token: string | undefined): Promise<(ResolvedAccess & { user: PublicIdentityUser }) | null> {
    const access = await this.resolveAccess(token);
    if (!access) return null;
    let current = access;
    let userResponse = await this.requestJson(`${this.authBaseUrl}/auth/v1/user`, {
      headers: { apikey: this.anonKey, Authorization: `Bearer ${current.envelope.accessToken}` },
    });
    if (userResponse.response.status === 401 && current.envelope.refreshToken && !current.refreshedToken) {
      const refreshed = await this.refresh(current.envelope);
      if (!refreshed) return null;
      current = refreshed;
      userResponse = await this.requestJson(`${this.authBaseUrl}/auth/v1/user`, {
        headers: { apikey: this.anonKey, Authorization: `Bearer ${current.envelope.accessToken}` },
      });
    }
    if (userResponse.response.status === 401) return null;
    if (!userResponse.response.ok) throw providerUnavailable();
    const parsed = authUserSchema.safeParse(userResponse.payload);
    if (!parsed.success) throw providerUnavailable();
    let displayName = current.envelope.displayName ?? null;
    if (!displayName) {
      displayName = await this.readProfileDisplayName(current.envelope.accessToken).catch(() => null);
      if (displayName) {
        const envelope = { ...current.envelope, displayName };
        current = { envelope, refreshedToken: this.seal(envelope) };
      }
    }
    return { ...current, user: publicUser(parsed.data, this.now(), displayName) };
  }

  private async resolveAccess(token: string | undefined, force = false): Promise<ResolvedAccess | null> {
    const envelope = token ? this.open(token) : null;
    if (!envelope || envelope.sessionExpiresAt <= this.now()) return null;
    // 已登出的令牌直接失效（上游只撤 refresh session，access JWT 仍有效）。
    if (token && this.revokedTokens.has(hashSessionToken(token))) return null;
    if (!force && envelope.accessExpiresAt > this.now() + 60_000) return { envelope };
    if (force && !envelope.refreshToken && envelope.accessExpiresAt > this.now()) return { envelope };
    return this.refresh(envelope);
  }

  private async refresh(envelope: SessionEnvelope): Promise<ResolvedAccess | null> {
    if (!envelope.refreshToken) return null;
    const refreshToken = envelope.refreshToken;
    const existing = this.refreshInFlight.get(refreshToken);
    if (existing) return existing;
    const pending = this.performRefresh(envelope);
    this.refreshInFlight.set(refreshToken, pending);
    void pending.then(
      () => {
        const cleanup = setTimeout(() => {
          if (this.refreshInFlight.get(refreshToken) === pending) this.refreshInFlight.delete(refreshToken);
        }, REFRESH_REUSE_GRACE_MS);
        cleanup.unref();
      },
      () => {
        if (this.refreshInFlight.get(refreshToken) === pending) this.refreshInFlight.delete(refreshToken);
      },
    );
    return pending;
  }

  private async performRefresh(envelope: SessionEnvelope): Promise<ResolvedAccess | null> {
    const { response, payload } = await this.requestJson(`${this.authBaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: this.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: envelope.refreshToken }),
    });
    if (response.status === 400 || response.status === 401) return null;
    if (!response.ok) throw providerUnavailable();
    const parsed = authTokenSchema.safeParse(payload);
    if (!parsed.success) throw providerUnavailable();
    const next: SessionEnvelope = {
      ...envelope,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? envelope.refreshToken,
      accessExpiresAt: authExpiry(parsed.data, this.now()),
    };
    return { envelope: next, refreshedToken: this.seal(next) };
  }

  private async accountRequest<TParsed, TData>(
    token: string | undefined,
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: TParsed } | { success: false } },
    init: RequestInit,
    select: (value: TParsed) => TData,
    fallbackPath?: string,
  ): Promise<WalletProviderResult<TData>> {
    let access: ResolvedAccess | null = null;
    let upstream: { response: Response; payload: unknown };
    let activePath = path;
    try {
      access = await this.resolveAccess(token);
      if (!access) throw new WalletProviderError(401, "UNAUTHENTICATED", "请先登录");
      upstream = await this.requestJson(`${this.apiBaseUrl}${activePath}`, withBearer(init, access.envelope.accessToken));
      if (upstream.response.status === 404 && fallbackPath) {
        activePath = fallbackPath;
        upstream = await this.requestJson(`${this.apiBaseUrl}${activePath}`, withBearer(init, access.envelope.accessToken));
      }
      if (upstream.response.status === 401 && access.envelope.refreshToken && !access.refreshedToken) {
        const refreshed = await this.refresh(access.envelope);
        if (!refreshed) throw new WalletProviderError(401, "UNAUTHENTICATED", "登录已过期，请重新登录");
        access = refreshed;
        upstream = await this.requestJson(`${this.apiBaseUrl}${activePath}`, withBearer(init, access.envelope.accessToken));
      }
    } catch (error) {
      if (error instanceof IdentityProviderError && error.code === "IDENTITY_PROVIDER_UNAVAILABLE") {
        throw walletErrorWithRefresh(
          new WalletProviderError(503, "WALLET_PROVIDER_UNAVAILABLE", "积分服务暂时不可用，请稍后重试"),
          access,
        );
      }
      if (error instanceof WalletProviderError) throw walletErrorWithRefresh(error, access);
      throw error;
    }
    if (!upstream.response.ok) {
      throw walletErrorWithRefresh(
        walletRequestError(upstream.response.status, upstream.payload, retryAfterSeconds(upstream.response.headers)),
        access,
      );
    }
    if (isUpstreamErrorEnvelope(upstream.payload)) {
      // A 200 response can still carry an upstream business error envelope
      // ({ ok: false, error: { code, message } }). Surface it as the product
      // error instead of misclassifying it as an unrecognized payload.
      throw walletErrorWithRefresh(
        walletRequestError(upstream.response.status, upstream.payload, retryAfterSeconds(upstream.response.headers)),
        access,
      );
    }
    const parsed = schema.safeParse(upstream.payload);
    if (!parsed.success) {
      throw walletErrorWithRefresh(
        new WalletProviderError(503, "WALLET_INVALID_RESPONSE", "积分服务返回了无法识别的数据"),
        access,
      );
    }
    return {
      data: select(parsed.data),
      ...(access.refreshedToken ? {
        refreshedToken: access.refreshedToken,
        expiresAt: new Date(access.envelope.sessionExpiresAt).toISOString(),
      } : {}),
    };
  }

  private async requestJson(url: string, init: RequestInit) {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs) });
    } catch (cause) {
      logUpstreamFailure(url, cause);
      throw providerUnavailable();
    }
    const payload = await response.json().catch(() => ({})) as unknown;
    if (response.status >= 500) logUpstreamFailure(url, undefined, response.status);
    return { response, payload };
  }

  private async requestLoginJson(url: string, init: RequestInit) {
    const retryDelayMs = Math.min(this.loginRetryDelayMs, Math.floor(this.requestTimeoutMs / 4));
    const attemptTimeoutMs = Math.max(1, Math.floor((this.requestTimeoutMs - retryDelayMs) / 2));
    // 登录是幂等请求：上游瞬时闪断（连接重置、5xx）时重试，共最多 3 次尝试，
    // 比单次重试更能扛住秒级到十几秒级的账号服务波动。
    const backoffAfter = [retryDelayMs, retryDelayMs * 3];
    let lastTransient: Awaited<ReturnType<PromptHubProvider["requestJson"]>> | null = null;
    for (let attempt = 0; attempt <= backoffAfter.length; attempt++) {
      try {
        const result = await this.requestJson(url, { ...init, signal: AbortSignal.timeout(attemptTimeoutMs) });
        if (!isRetryableLoginStatus(result.response.status)) return result;
        lastTransient = result;
      } catch (error) {
        if (!isProviderUnavailable(error)) throw error;
      }
      if (attempt < backoffAfter.length) await delay(backoffAfter[attempt]!);
    }
    if (lastTransient) return lastTransient;
    throw providerUnavailable();
  }

  private async readProfileDisplayName(accessToken: string) {
    const { response, payload } = await this.requestJson(`${this.apiBaseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const parsed = profileIdentitySchema.safeParse(payload);
    return parsed.success ? parsed.data.data.displayName : null;
  }

  private async writeProfileDisplayName(accessToken: string, displayName: string) {
    const { response, payload } = await this.requestJson(`${this.apiBaseUrl}/api/v1/me/display-name`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (!response.ok) return null;
    const parsed = profileIdentitySchema.safeParse(payload);
    return parsed.success ? parsed.data.data.displayName : null;
  }

  private seal(envelope: SessionEnvelope) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sessionKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
    const sealed = `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
    if (Buffer.byteLength(sealed, "utf8") > MAX_SESSION_COOKIE_BYTES) {
      throw providerUnavailable();
    }
    return sealed;
  }

  private open(token: string): SessionEnvelope | null {
    const [version, ivValue, encryptedValue, tagValue, ...rest] = token.split(".");
    if (version !== "v1" || !ivValue || !encryptedValue || !tagValue || rest.length) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.sessionKey, Buffer.from(ivValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      const value = Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      const parsed = sessionEnvelopeSchema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

function publicUser(user: z.infer<typeof authUserSchema>, now: number, profileDisplayName: string | null = null): PublicIdentityUser {
  const email = user.email?.trim().toLowerCase();
  if (!email) throw providerUnavailable();
  const metadata = user.user_metadata ?? {};
  const preferred = [metadata.display_name, metadata.full_name, metadata.name]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const displayName = (profileDisplayName?.trim() || preferred?.trim() || email.slice(0, email.indexOf("@"))).slice(0, 48);
  return publicIdentityUserSchema.parse({
    id: user.id,
    email,
    displayName,
    createdAt: user.created_at ?? new Date(now).toISOString(),
  });
}

function withBearer(init: RequestInit, accessToken: string): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
  };
}

function authExpiry(value: z.infer<typeof authTokenSchema>, now: number) {
  const absolute = value.expires_at ? Math.floor(value.expires_at * 1_000) : 0;
  const relative = value.expires_in ? now + Math.floor(value.expires_in * 1_000) : 0;
  const expiresAt = absolute || relative || now + 60 * 60_000;
  return Math.max(now + 1_000, expiresAt);
}

function identityRequestError(status: number, payload: unknown, retryAfter: number | null) {
  if (status === 400 || status === 401) return new IdentityProviderError("INVALID_CREDENTIALS", "邮箱或密码不正确", 401, retryAfter);
  if (status === 429) return new IdentityProviderError("IDENTITY_RATE_LIMITED", "登录尝试过于频繁，请稍后再试", 429, retryAfter);
  const message = publicUpstreamMessage(payload, "账号服务暂时不可用");
  return new IdentityProviderError("IDENTITY_PROVIDER_UNAVAILABLE", message, 503, retryAfter);
}

function registrationRequestError(status: number, payload: unknown, retryAfter: number | null) {
  if (status === 429) {
    return new IdentityProviderError("IDENTITY_RATE_LIMITED", "注册尝试过于频繁，请稍后再试", 429, retryAfter);
  }
  if (status === 400 || status === 409 || status === 422) {
    const message = publicUpstreamMessage(payload, "这个邮箱暂时无法注册");
    const duplicate = /already|registered|exists|存在|注册/i.test(message);
    return duplicate
      ? new IdentityProviderError("EMAIL_TAKEN", "这个邮箱已经注册", 409, retryAfter)
      : new IdentityProviderError("REGISTRATION_REJECTED", "注册信息未通过账号服务校验", 400, retryAfter);
  }
  return providerUnavailable();
}

function isPromptHubDisplayName(value: string) {
  return /^[\p{Script=Han}A-Za-z0-9_-]{2,20}$/u.test(value);
}

function walletRequestError(status: number, payload: unknown, retryAfter: number | null) {
  if (status === 401) return new WalletProviderError(401, "UNAUTHENTICATED", "登录已过期，请重新登录", undefined, undefined, retryAfter);
  const normalized = status === 400 || status === 402 || status === 404 || status === 409 || status === 429 || status >= 500 ? status : 500;
  const safeStatus = normalized === 400 || normalized === 402 || normalized === 404 || normalized === 409 || normalized === 429 || normalized === 503
    ? normalized
    : 500;
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const code = typeof nested.code === "string" ? nested.code : typeof record.code === "string" ? record.code : "WALLET_REQUEST_FAILED";
  return new WalletProviderError(safeStatus, code, publicUpstreamMessage(payload, "积分操作没有完成"), undefined, undefined, retryAfter);
}

function walletErrorWithRefresh(error: WalletProviderError, access: ResolvedAccess | null) {
  if (error.status === 401 || !access?.refreshedToken) return error;
  return new WalletProviderError(
    error.status,
    error.code,
    error.message,
    access.refreshedToken,
    new Date(access.envelope.sessionExpiresAt).toISOString(),
    error.retryAfterSeconds,
  );
}

function isUpstreamErrorEnvelope(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return record.ok === false && record.error !== null && typeof record.error === "object";
}

function retryAfterSeconds(headers: Headers) {
  const value = Number(headers.get("Retry-After"));
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 86_400) : null;
}

function publicUpstreamMessage(payload: unknown, fallback: string) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const value = [nested.message, record.message, record.msg, record.error_description].find((item) => typeof item === "string");
  return typeof value === "string" && value.trim() ? value.slice(0, 240) : fallback;
}

function providerUnavailable() {
  return new IdentityProviderError("IDENTITY_PROVIDER_UNAVAILABLE", "账号服务暂时不可用", 503);
}

function isProviderUnavailable(error: unknown) {
  return error instanceof IdentityProviderError && error.code === "IDENTITY_PROVIDER_UNAVAILABLE";
}

function isRetryableLoginStatus(status: number) {
  return status >= 500 && status <= 599;
}

function delay(milliseconds: number) {
  return milliseconds > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

function logUpstreamFailure(url: string, cause?: unknown, status?: number) {
  const target = new URL(url);
  const error = cause instanceof Error ? cause : null;
  const nestedCode = error?.cause && typeof error.cause === "object" && "code" in error.cause
    ? String((error.cause as { code?: unknown }).code ?? "")
    : "";
  console.error("Prompt Hub upstream request failed", {
    host: target.host,
    path: target.pathname,
    ...(status ? { status } : {}),
    ...(error ? { error: error.name, code: nestedCode || undefined } : {}),
  });
}

function normalizeBase(value: string) {
  const parsed = new URL(required(value, "service URL"));
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("Identity provider URLs must use HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
}

function required(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

/** 吊销名单只存令牌哈希，不明文保存会话凭据。 */
function hashSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
