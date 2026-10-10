import { createHmac, timingSafeEqual } from "node:crypto";

import {
  type CardLibraryCardList,
  type CardLibraryGroupList,
  type CardLibraryTagList,
  type CommunityFeedPage,
  type IdentityCapabilities,
  type MembershipTaskAction,
  type MembershipTaskCenter,
  type PublicIdentityUser,
  type WalletCheckoutRequest,
  type WalletOrder,
  type WalletRedeemRequest,
  type WalletSummary,
} from "@kachang/contracts";

import {
  WalletProviderError,
  type MembershipTaskProvider,
  type WalletCreditOperationInput,
  type WalletCreditOperationResult,
  type WalletLedgerItem,
  type WalletProductCatalog,
  type WalletProvider,
  type WalletProviderResult,
} from "../wallet/provider.js";
import {
  type IdentityProvider,
  type IdentityRegistrationResult,
  type IssuedIdentitySession,
  type ResolvedIdentitySession,
} from "./provider.js";

// 本地开发专用测试账号。仅非生产环境才可能被装配（server.ts 双重校验），
// 生产部署的代码路径与环境里都不存在这条登录通道。
// 账号常量与登录页共用 contracts 里的同一份，避免两端各自手写造成漂移。
import { DEV_TEST_ACCOUNT_EMAIL, DEV_TEST_ACCOUNT_PASSWORD } from "@kachang/contracts";
export { DEV_TEST_ACCOUNT_EMAIL, DEV_TEST_ACCOUNT_PASSWORD };
export const DEV_TEST_USER_EMAIL = "admin@dev.local";

const DEV_TOKEN_PREFIX = "d1.";
const DEV_TEST_USER_ID = "00000000-0000-4000-8000-c0ffee000001";
const DEV_TEST_DISPLAY_NAME = "本地测试";
const DEV_TEST_STARTING_CREDITS = 6800;
const DEFAULT_DEV_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * 与 PromptHubProvider 结构等价的完整账号/钱包/会员/卡片库 provider。
 * 测试包装器对它做逐方法转发，保证本地真实账号的行为完全不变。
 */
export type PromptHubLikeProvider = IdentityProvider & WalletProvider & MembershipTaskProvider & {
  listCards(token: string | undefined, input: { page: number; limit: number; query?: string; group?: string; tag?: string }): Promise<WalletProviderResult<CardLibraryCardList>>;
  listGroups(token: string | undefined): Promise<WalletProviderResult<CardLibraryGroupList>>;
  listTags(token: string | undefined): Promise<WalletProviderResult<CardLibraryTagList>>;
  signCardMedia(token: string | undefined, input: { ref: string; variant: "thumb" | "full" }): Promise<WalletProviderResult<{ url: string; expiresIn?: number; cdn?: boolean }>>;
  getCommunityFeed(input: { limit: number; offset: number }): Promise<WalletProviderResult<CommunityFeedPage>>;
  communityImageUrl(image: string | null | undefined): string | null;
  resolveUpstreamAccess(token: string | undefined, options?: { force?: boolean }): Promise<WalletProviderResult<{ accessToken: string }>>;
};

/**
 * 本地测试账号包装器：
 * - admin / 123456 → 直接签发本地会话，钱包/会员/任务/卡片库返回内置假数据
 *   （专业版会员 + 积分），完全不依赖上游服务，供本地预览充值面板等 UI；
 * - 其余邮箱密码 → 原样转发给真实 provider，本地同样可以使用真实账号；
 * - 测试会话令牌带 "d1." 前缀，与真实令牌（"v1."）互不误认；
 * - 支付、云端生成等必须依赖真实上游账号的能力，对测试账号给出明确报错。
 */
export class DevTestAccountProvider implements
  IdentityProvider,
  WalletProvider,
  MembershipTaskProvider,
  Pick<PromptHubLikeProvider, "listCards" | "listGroups" | "listTags" | "signCardMedia" | "getCommunityFeed" | "communityImageUrl" | "resolveUpstreamAccess"> {
  private readonly sessionKey: Buffer;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  /** 本地测试账号的积分记账（仅内存，重启即回到初始值）。 */
  private readonly devConsumedRefs = new Set<string>();
  private readonly devRefundedRefs = new Set<string>();
  private devSpent = 0;

  constructor(
    private readonly fallback: PromptHubLikeProvider,
    options: { sessionSecret: string; sessionTtlMs?: number; now?: () => number },
  ) {
    this.sessionKey = createHmac("sha256", "kachang-canvas-dev-test-account").update(options.sessionSecret, "utf8").digest();
    this.sessionTtlMs = options.sessionTtlMs && options.sessionTtlMs > 0 ? options.sessionTtlMs : DEFAULT_DEV_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get capabilities(): IdentityCapabilities {
    // devTestAccount 让登录页知道可以提供 admin/123456 的一键填充；
    // 生产环境不存在本包装器，该标记不会出现。
    return { ...this.fallback.capabilities, devTestAccount: true };
  }

  async register(value: unknown): Promise<IdentityRegistrationResult> {
    return this.fallback.register(value);
  }

  async login(value: unknown): Promise<IssuedIdentitySession> {
    // 注意：这里刻意先做宽松匹配、再走 schema 校验——测试账号 "admin" 不是
    // 邮箱格式，提前 parse 会直接拒绝它。
    const raw = (value && typeof value === "object" ? value : {}) as { email?: unknown; password?: unknown };
    const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
    const password = typeof raw.password === "string" ? raw.password : "";
    if (email === DEV_TEST_ACCOUNT_EMAIL && password === DEV_TEST_ACCOUNT_PASSWORD) {
      return this.issue(this.now());
    }
    return this.fallback.login(value);
  }

  async authenticate(token: string | undefined): Promise<ResolvedIdentitySession | null> {
    if (isDevToken(token)) {
      const payload = this.verify(token!);
      return payload
        ? { user: devTestUser(), expiresAt: new Date(payload.exp).toISOString() }
        : null;
    }
    return this.fallback.authenticate(token);
  }

  async logout(token: string | undefined): Promise<void> {
    if (isDevToken(token)) return; // 本地测试会话无服务端状态，清 Cookie 即可
    await this.fallback.logout(token);
  }

  async getSummary(token: string | undefined): Promise<WalletProviderResult<WalletSummary>> {
    if (isDevToken(token)) return { data: devTestSummary(this.devCreditsBalance()) };
    return this.fallback.getSummary(token);
  }

  async getLedger(token: string | undefined, limit: number): Promise<WalletProviderResult<WalletLedgerItem[]>> {
    if (isDevToken(token)) return { data: devTestLedger().slice(0, Math.max(1, Math.min(limit, 50))) };
    return this.fallback.getLedger(token, limit);
  }

  async getProducts(token: string | undefined): Promise<WalletProviderResult<WalletProductCatalog>> {
    if (isDevToken(token)) return { data: devTestProductCatalog() };
    return this.fallback.getProducts(token);
  }

  async createCheckout(token: string | undefined, input: WalletCheckoutRequest): Promise<WalletProviderResult<{ orderNo: string; checkoutUrl: string }>> {
    if (isDevToken(token)) throw devTestUnsupported("本地测试账号不支持支付操作，请使用真实账号登录");
    return this.fallback.createCheckout(token, input);
  }

  async getOrder(token: string | undefined, orderNo: string): Promise<WalletProviderResult<WalletOrder>> {
    if (isDevToken(token)) throw devTestUnsupported("本地测试账号不支持订单查询，请使用真实账号登录");
    return this.fallback.getOrder(token, orderNo);
  }

  async redeem(token: string | undefined, input: WalletRedeemRequest): Promise<WalletProviderResult<{ message: string; summary: WalletSummary | null }>> {
    if (isDevToken(token)) throw devTestUnsupported("本地测试账号不支持兑换码，请使用真实账号登录");
    return this.fallback.redeem(token, input);
  }

  /**
   * 本地测试账号的钱包操作不走上游：在内存里按 refId 幂等地记账，
   * 让本地 Agent 每轮扣费可用且可复现（余额也会同步反映到 /api/v1/wallet）。
   */
  async consumeCredit(token: string | undefined, input: WalletCreditOperationInput): Promise<WalletProviderResult<WalletCreditOperationResult>> {
    if (isDevToken(token)) return { data: this.devCreditOperation("consume", input) };
    return this.fallback.consumeCredit(token, input);
  }

  async refundCredit(token: string | undefined, input: WalletCreditOperationInput): Promise<WalletProviderResult<WalletCreditOperationResult>> {
    if (isDevToken(token)) return { data: this.devCreditOperation("refund", input) };
    return this.fallback.refundCredit(token, input);
  }

  private devCreditOperation(kind: "consume" | "refund", input: WalletCreditOperationInput): WalletCreditOperationResult {
    const applied = kind === "consume" ? this.devConsumedRefs : this.devRefundedRefs;
    const replayed = applied.has(input.refId);
    if (!replayed) {
      applied.add(input.refId);
      this.devSpent += kind === "consume" ? input.amount : -input.amount;
    }
    return { balance: this.devCreditsBalance(), replayed };
  }

  private devCreditsBalance(): number {
    return Math.max(0, DEV_TEST_STARTING_CREDITS - this.devSpent);
  }

  async resolveUpstreamAccess(token: string | undefined, options?: { force?: boolean }): Promise<WalletProviderResult<{ accessToken: string }>> {
    if (isDevToken(token)) throw devTestUnsupported("本地测试账号不支持云端生成，请使用真实账号登录");
    return this.fallback.resolveUpstreamAccess(token, options);
  }

  async getMembershipTasks(token: string | undefined): Promise<WalletProviderResult<MembershipTaskCenter>> {
    if (isDevToken(token)) return { data: devTestMembershipTasks() };
    return this.fallback.getMembershipTasks(token);
  }

  async claimMembershipTask(token: string | undefined, taskKey: string): Promise<WalletProviderResult<MembershipTaskAction>> {
    if (isDevToken(token)) return { data: { message: "本地测试账号默认拥有专业版权益，无需领取", granted: false } };
    return this.fallback.claimMembershipTask(token, taskKey);
  }

  async recordCanvasNodeCreated(token: string | undefined): Promise<WalletProviderResult<MembershipTaskAction>> {
    if (isDevToken(token)) return { data: { message: "本地测试账号已记录节点创建", granted: false } };
    return this.fallback.recordCanvasNodeCreated(token);
  }

  async listCards(token: string | undefined, input: { page: number; limit: number; query?: string; group?: string; tag?: string }): Promise<WalletProviderResult<CardLibraryCardList>> {
    if (isDevToken(token)) return { data: { cards: [], total: 0, page: input.page, limit: input.limit } };
    return this.fallback.listCards(token, input);
  }

  async listGroups(token: string | undefined): Promise<WalletProviderResult<CardLibraryGroupList>> {
    if (isDevToken(token)) return { data: { groups: [] } };
    return this.fallback.listGroups(token);
  }

  async listTags(token: string | undefined): Promise<WalletProviderResult<CardLibraryTagList>> {
    if (isDevToken(token)) return { data: { tags: [] } };
    return this.fallback.listTags(token);
  }

  async signCardMedia(token: string | undefined, input: { ref: string; variant: "thumb" | "full" }): Promise<WalletProviderResult<{ url: string; expiresIn?: number; cdn?: boolean }>> {
    if (isDevToken(token)) throw devTestUnsupported("本地测试账号不支持卡片库素材签名，请使用真实账号登录");
    return this.fallback.signCardMedia(token, input);
  }

  /** 社区流是公开数据，测试账号也直接走真实上游（无账号语义）。 */
  async getCommunityFeed(input: { limit: number; offset: number }): Promise<WalletProviderResult<CommunityFeedPage>> {
    return this.fallback.getCommunityFeed(input);
  }

  communityImageUrl(image: string | null | undefined): string | null {
    return this.fallback.communityImageUrl(image);
  }

  private issue(now: number): IssuedIdentitySession {
    const exp = now + this.sessionTtlMs;
    const payload = Buffer.from(JSON.stringify({ exp }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.sessionKey).update(`${DEV_TOKEN_PREFIX}${payload}`, "utf8").digest("base64url");
    return {
      token: `${DEV_TOKEN_PREFIX}${payload}.${signature}`,
      user: devTestUser(now),
      expiresAt: new Date(exp).toISOString(),
    };
  }

  private verify(token: string): { exp: number } | null {
    const [prefix, payload, signature, ...rest] = token.split(".");
    if (prefix !== "d1" || !payload || !signature || rest.length) return null;
    const expected = createHmac("sha256", this.sessionKey).update(`${DEV_TOKEN_PREFIX}${payload}`, "utf8").digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof parsed.exp !== "number" || !Number.isSafeInteger(parsed.exp) || parsed.exp <= this.now()) return null;
      return { exp: parsed.exp };
    } catch {
      return null;
    }
  }
}

function isDevToken(token: string | undefined): boolean {
  return typeof token === "string" && token.startsWith(DEV_TOKEN_PREFIX);
}

function devTestUnsupported(message: string) {
  return new WalletProviderError(400, "DEV_TEST_UNSUPPORTED", message);
}

function devTestUser(now = Date.now()): PublicIdentityUser {
  return {
    id: DEV_TEST_USER_ID,
    email: DEV_TEST_USER_EMAIL,
    displayName: DEV_TEST_DISPLAY_NAME,
    createdAt: new Date(now).toISOString(),
  };
}

// 假数据统一走函数（而非模块常量），保证过期时间/时间戳随调用时刻刷新。
function devTestSummary(credits = DEV_TEST_STARTING_CREDITS): WalletSummary {
  return {
    credits,
    creditsPermanent: credits,
    dailyCredits: 0,
    creditGrantMode: "bundle",
    dailyCreditsNote: null,
    membership: {
      tier: "pro",
      until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString(),
      queuedTier: null,
      queuedUntil: null,
      active: true,
      genDiscount: "专业版生成 8 折",
    },
    lifetimeCreditsSpent: 1240,
  };
}

function devTestLedger(): WalletLedgerItem[] {
  const now = Date.now();
  return [
    { id: "dev-ledger-3", delta: -200, balanceAfter: 6800, reason: "generation", reasonLabel: "图片生成", refId: null, meta: null, createdAt: new Date(now - 3_600_000).toISOString() },
    { id: "dev-ledger-2", delta: -860, balanceAfter: 7000, reason: "generation", reasonLabel: "视频生成", refId: null, meta: null, createdAt: new Date(now - 7_200_000).toISOString() },
    { id: "dev-ledger-1", delta: 7000, balanceAfter: 7860, reason: "signup-bonus", reasonLabel: "新用户赠送", refId: null, meta: null, createdAt: new Date(now - 86_400_000).toISOString() },
  ];
}

function devTestProductCatalog(): WalletProductCatalog {
  return {
    customCreditTopUp: null,
    products: [
      { kind: "credits", id: "dev-credits-6", amount: 6, credits: 600 },
      { kind: "credits", id: "dev-credits-30", amount: 30, credits: 3300 },
      { kind: "credits", id: "dev-credits-98", amount: 98, credits: 11800 },
      { kind: "membership", id: "dev-membership-lite", amount: 12, tier: "lite", days: 30 },
      { kind: "membership", id: "dev-membership-basic", amount: 25, tier: "basic", days: 30 },
      { kind: "membership", id: "dev-membership-standard", amount: 48, tier: "standard", days: 30 },
      { kind: "membership", id: "dev-membership-pro", amount: 98, tier: "pro", days: 30 },
    ],
  };
}

function devTestMembershipTasks(): MembershipTaskCenter {
  return {
    items: [
      { key: "daily_checkin", title: "每日签到", description: "连续签到可获得积分奖励", rewardDays: 0, rewardCredits: 20, claimed: false, ready: true, progress: null, kind: "claim" },
      { key: "canvas_first_node", title: "创建第一个画布节点", description: "在画布中创建任意节点即可领取会员天数", rewardDays: 1, rewardCredits: 0, claimed: false, ready: true, progress: null, kind: "claim" },
      { key: "invite_friend", title: "邀请好友", description: "每邀请一位好友注册，双方各得积分", rewardDays: 0, rewardCredits: 200, claimed: false, ready: false, progress: "0/1", kind: "claim" },
    ],
    lifetimeCreditsSpent: 1240,
    nextSpendMilestone: 5000,
    hub: {
      phoneVerified: true,
      signStreak: 3,
      checkedInToday: false,
      daysToStreakBonus: 4,
      dailyBonus: { key: "daily_checkin", claimed: false, ready: true },
      memberDaily: { key: "member_daily", claimed: false, ready: true, amount: 60 },
    },
    phoneVerified: true,
  };
}
