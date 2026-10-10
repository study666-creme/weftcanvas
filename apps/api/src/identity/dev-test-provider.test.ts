import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { WalletProviderError } from "../wallet/provider.js";
import {
  DevTestAccountProvider,
  DEV_TEST_ACCOUNT_EMAIL,
  DEV_TEST_ACCOUNT_PASSWORD,
  type PromptHubLikeProvider,
} from "./dev-test-provider.js";
import type { IssuedIdentitySession } from "./provider.js";

function createFallbackStub() {
  return {
    capabilities: { available: true, registration: "native", registrationUrl: null, passwordResetUrl: null },
    register: vi.fn(),
    login: vi.fn(async () => ({
      token: "v1.fallback-token",
      user: { id: "00000000-0000-4000-8000-0000000000ff", email: "real@example.com", displayName: "真实用户", createdAt: new Date().toISOString() },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })),
    authenticate: vi.fn(async () => null),
    logout: vi.fn(async () => undefined),
    getSummary: vi.fn(async () => ({ data: { upstream: true } })),
    getLedger: vi.fn(async () => ({ data: [] })),
    getProducts: vi.fn(async () => ({ data: { products: [], customCreditTopUp: null } })),
    createCheckout: vi.fn(),
    getOrder: vi.fn(),
    redeem: vi.fn(),
    resolveUpstreamAccess: vi.fn(),
    getMembershipTasks: vi.fn(),
    claimMembershipTask: vi.fn(),
    recordCanvasNodeCreated: vi.fn(),
    listCards: vi.fn(async () => ({ data: { cards: [], total: 0, page: 1, limit: 20 } })),
    listGroups: vi.fn(async () => ({ data: { groups: ["upstream"] } })),
    listTags: vi.fn(async () => ({ data: { tags: ["upstream"] } })),
    signCardMedia: vi.fn(),
    getCommunityFeed: vi.fn(async () => ({ data: { posts: [], limit: 6, offset: 0, nextOffset: 0, hasMore: false } })),
    communityImageUrl: vi.fn(() => null),
  };
}

type Stub = ReturnType<typeof createFallbackStub>;

function createProvider(stub: Stub = createFallbackStub(), options: { now?: () => number } = {}) {
  return new DevTestAccountProvider(stub as unknown as PromptHubLikeProvider, {
    sessionSecret: randomBytes(32).toString("hex"),
    ...options,
  });
}

describe("DevTestAccountProvider", () => {
  it("admin/123456 直接签发本地会话且不触碰真实 provider", async () => {
    const stub = createFallbackStub();
    const provider = createProvider(stub);
    const issued = await provider.login({ email: " Admin ", password: DEV_TEST_ACCOUNT_PASSWORD });
    expect(issued.token.startsWith("d1.")).toBe(true);
    expect(issued.user.email).toBe("admin@dev.local");
    expect(issued.user.displayName).toBe("本地测试");
    expect(stub.login).not.toHaveBeenCalled();
  });

  it("非测试账号原样转发给真实 provider", async () => {
    const stub = createFallbackStub();
    const provider = createProvider(stub);
    await provider.login({ email: "someone@example.com", password: "wrong-password" });
    expect(stub.login).toHaveBeenCalledTimes(1);
    expect(stub.login).toHaveBeenCalledWith({ email: "someone@example.com", password: "wrong-password" });
  });

  it("测试会话令牌可完成认证，非法令牌返回 null 且不外转", async () => {
    const provider = createProvider();
    const issued = await provider.login({ email: DEV_TEST_ACCOUNT_EMAIL, password: DEV_TEST_ACCOUNT_PASSWORD });
    const session = await provider.authenticate(issued.token);
    expect(session?.user.id).toBe(issued.user.id);
    expect(await provider.authenticate("d1.not-a-real-token.abc")).toBeNull();
    expect(await provider.authenticate(undefined)).toBeNull();
  });

  it("会话按 TTL 过期", async () => {
    let now = 1_000_000;
    const provider = createProvider(createFallbackStub(), { now: () => now });
    const issued = await provider.login({ email: DEV_TEST_ACCOUNT_EMAIL, password: DEV_TEST_ACCOUNT_PASSWORD });
    now += 60_000;
    expect((await provider.authenticate(issued.token))?.user.email).toBe("admin@dev.local");
    now += 25 * 60 * 60 * 1_000;
    expect(await provider.authenticate(issued.token)).toBeNull();
  });

  it("钱包/会员走内置假数据，支付与云端生成明确拒绝", async () => {
    const stub = createFallbackStub();
    const provider = createProvider(stub);
    const issued: IssuedIdentitySession = await provider.login({ email: DEV_TEST_ACCOUNT_EMAIL, password: DEV_TEST_ACCOUNT_PASSWORD });

    const summary = await provider.getSummary(issued.token);
    expect(summary.data.membership.tier).toBe("pro");
    expect(summary.data.credits).toBeGreaterThan(0);
    const catalog = await provider.getProducts(issued.token);
    expect(catalog.data.products.length).toBeGreaterThan(0);
    const tasks = await provider.getMembershipTasks(issued.token);
    expect(tasks.data.items.length).toBeGreaterThan(0);

    await expect(provider.createCheckout(issued.token, { productId: "dev-credits-6", paymentMethod: "alipay" })).rejects.toBeInstanceOf(WalletProviderError);
    await expect(provider.resolveUpstreamAccess(issued.token)).rejects.toBeInstanceOf(WalletProviderError);
    expect(stub.getSummary).not.toHaveBeenCalled();
  });

  it("真实令牌的请求全部转发", async () => {
    const stub = createFallbackStub();
    const provider = createProvider(stub);
    await provider.getSummary("v1.real-token");
    await provider.getProducts("v1.real-token");
    await provider.listGroups("v1.real-token");
    await provider.logout("v1.real-token");
    expect(stub.getSummary).toHaveBeenCalledTimes(1);
    expect(stub.getProducts).toHaveBeenCalledTimes(1);
    expect(stub.listGroups).toHaveBeenCalledTimes(1);
    expect(stub.logout).toHaveBeenCalledTimes(1);
  });
});
