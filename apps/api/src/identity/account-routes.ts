import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { ZodError } from "zod";

import {
  identityLogoutResponseSchema,
  identityRegistrationResponseSchema,
  identitySessionResponseSchema,
  identitySessionStateResponseSchema,
  membershipTaskActionResponseSchema,
  membershipTaskCenterResponseSchema,
  membershipTaskKeySchema,
  walletCheckoutRequestSchema,
  walletCheckoutResponseSchema,
  walletLedgerResponseSchema,
  walletOrderResponseSchema,
  walletProductsResponseSchema,
  walletRedeemRequestSchema,
  walletRedeemResponseSchema,
  walletResponseSchema,
} from "@weftcanvas/contracts";

import { errorResponse, optionalQueryInteger } from "../http/errors.js";
import { readJsonBody } from "../http/json-body.js";
import { rateLimitedResponse } from "../http/rate-limit.js";
import { isTrustedBrowserRequest } from "../http/browser-request.js";
import {
  authenticateIdentity,
  clearIdentityCookie,
  identityUnavailable,
  publicIssuedSession,
  refreshIdentityCookie,
  setIdentityCookie,
  type IdentityCookie,
} from "./http-session.js";
import type {
  IdentityProvider,
  IdentityRegistrationResult,
  IssuedIdentitySession,
} from "./provider.js";
import {
  WalletProviderError,
  type WalletProvider,
  type MembershipTaskProvider,
} from "../wallet/provider.js";

export type AccountRouteDependencies = {
  identity: IdentityProvider | undefined;
  wallet: WalletProvider | undefined;
  membershipTasks: MembershipTaskProvider | undefined;
  allowedOrigins?: readonly string[];
  identityCookie: IdentityCookie;
  /** 注册/登录/兑换共享的限速守卫实例（app.ts 注入）。 */
  sensitiveActionGuard: { consume(key: string, limit: number, durationMs: number): number | null };
  /** 可信代理边界内的客户端标识（app.ts 注入）。 */
  clientIdentifier: (context: Context) => string;
};

export function walletUnavailable(context: Context) {
  return errorResponse(context, 503, "WALLET_UNAVAILABLE", "积分服务暂未配置");
}

export function identityCapabilities(identity: IdentityProvider | undefined) {
  return (
    identity?.capabilities ?? {
      available: false,
      registration: "disabled" as const,
      registrationUrl: null,
      passwordResetUrl: null,
    }
  );
}

export function identityRequestErrorResponse(
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

/**
 * 账号域路由（从 app.ts 抽出，纯搬移）：注册 / 登录 / 会话 / 登出、钱包
 * （余额 / 流水 / 商品 / 下单 / 订单 / 兑换）与会员任务。限速与可信代理判定
 * 沿用 app.ts 注入的同一个守卫实例与 clientIdentifier。
 */
export function registerAccountDomainRoutes(app: Hono, deps: AccountRouteDependencies) {
  const {
    identity,
    wallet,
    membershipTasks,
    allowedOrigins,
    identityCookie,
    sensitiveActionGuard,
    clientIdentifier,
  } = deps;

  app.post("/api/v1/auth/register", async (context) => {
    if (!identity) return identityUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
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
      result = await identity.register(body);
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
          capabilities: identityCapabilities(identity),
        }),
        201,
      );
    }
    return context.json(
      identityRegistrationResponseSchema.parse({
        ok: true,
        status: "verification_required",
        data: { email: result.email },
        capabilities: identityCapabilities(identity),
      }),
      201,
    );
  });

  app.post("/api/v1/auth/login", async (context) => {
    if (!identity) return identityUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
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
      issued = await identity.login(body);
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
        capabilities: identityCapabilities(identity),
      }),
    );
  });

  app.get("/api/v1/auth/session", async (context) => {
    if (!identity) {
      return context.json(
        identitySessionStateResponseSchema.parse({
          ok: true,
          data: null,
          capabilities: identityCapabilities(undefined),
        }),
      );
    }
    const session = await authenticateIdentity(context, identity, identityCookie);
    return context.json(
      identitySessionStateResponseSchema.parse({
        ok: true,
        data: session,
        capabilities: identityCapabilities(identity),
      }),
    );
  });

  app.post("/api/v1/auth/logout", async (context) => {
    if (!identity) return identityUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
      return errorResponse(
        context,
        403,
        "CROSS_SITE_REQUEST_REJECTED",
        "无法从其他站点提交退出请求",
      );
    }
    try {
      await identity.logout(getCookie(context, identityCookie.name));
    } finally {
      // Never leave a locally valid cookie behind when upstream revocation fails.
      clearIdentityCookie(context, identityCookie);
    }
    return context.json(identityLogoutResponseSchema.parse({ ok: true }));
  });

  app.get("/api/v1/wallet", async (context) => {
    if (!wallet) return walletUnavailable(context);
    const result = await wallet.getSummary(getCookie(context, identityCookie.name));
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(walletResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.get("/api/v1/wallet/ledger", async (context) => {
    if (!wallet) return walletUnavailable(context);
    const limit = optionalQueryInteger(context, context.req.query("limit"), 20);
    if (limit instanceof Response) return limit;
    if (limit < 1 || limit > 50)
      return errorResponse(context, 400, "INVALID_LIMIT", "积分流水数量范围不正确");
    const result = await wallet.getLedger(getCookie(context, identityCookie.name), limit);
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(
      walletLedgerResponseSchema.parse({ ok: true, data: { items: result.data } }),
    );
  });

  app.get("/api/v1/wallet/products", async (context) => {
    if (!wallet) return walletUnavailable(context);
    const result = await wallet.getProducts(getCookie(context, identityCookie.name));
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
    if (!membershipTasks) return walletUnavailable(context);
    const result = await membershipTasks.getMembershipTasks(
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    context.header("Cache-Control", "private, no-store");
    return context.json(membershipTaskCenterResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/membership/tasks/canvas-create-node", async (context) => {
    if (!membershipTasks) return walletUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
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
    const result = await membershipTasks.recordCanvasNodeCreated(
      getCookie(context, identityCookie.name),
    );
    refreshIdentityCookie(context, identityCookie, result);
    context.header("Cache-Control", "private, no-store");
    return context.json(membershipTaskActionResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/membership/tasks/:taskKey/claim", async (context) => {
    if (!membershipTasks) return walletUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
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
    const result = await membershipTasks.claimMembershipTask(
      getCookie(context, identityCookie.name),
      taskKey,
    );
    refreshIdentityCookie(context, identityCookie, result);
    context.header("Cache-Control", "private, no-store");
    return context.json(membershipTaskActionResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/wallet/checkout", async (context) => {
    if (!wallet) return walletUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
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
    const result = await wallet.createCheckout(getCookie(context, identityCookie.name), input);
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(walletCheckoutResponseSchema.parse({ ok: true, data: result.data }), 201);
  });

  app.get("/api/v1/wallet/orders/:orderNo", async (context) => {
    if (!wallet) return walletUnavailable(context);
    const result = await wallet.getOrder(
      getCookie(context, identityCookie.name),
      context.req.param("orderNo"),
    );
    refreshIdentityCookie(context, identityCookie, result);
    return context.json(walletOrderResponseSchema.parse({ ok: true, data: result.data }));
  });

  app.post("/api/v1/wallet/redeem", async (context) => {
    if (!wallet) return walletUnavailable(context);
    if (!isTrustedBrowserRequest(context.req.raw, allowedOrigins)) {
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
      result = await wallet.redeem(getCookie(context, identityCookie.name), input);
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
}
