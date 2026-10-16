import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { errorResponse } from "../http/errors.js";
import type { IdentityProvider, IssuedIdentitySession } from "./provider.js";

/** 会话 Cookie 形状（结构类型：app.ts 的 identityCookie 配置同形，避免反向依赖）。 */
export type IdentityCookie = { name: string; secure: boolean };

/**
 * 身份会话的 HTTP 层（从 app.ts 抽出，纯搬运）：Cookie 读写、令牌轮换与
 * 「必须登录」的门。公开接口保持原样：app.ts 继续 re-export
 * requireIdentitySession / refreshIdentityCookie，既有导入路径不变。
 */
export function identityUnavailable(context: Context) {
  return errorResponse(context, 503, "IDENTITY_UNAVAILABLE", "账号服务暂未配置");
}

export function publicIssuedSession({ token: _token, ...session }: IssuedIdentitySession) {
  return session;
}

export function setIdentityCookie(
  context: Context,
  cookie: NonNullable<IdentityCookie>,
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

export function clearIdentityCookie(context: Context, cookie: NonNullable<IdentityCookie>) {
  deleteCookie(context, cookie.name, {
    secure: cookie.secure,
    sameSite: "Strict",
    path: "/",
  });
}

export function refreshIdentityCookie(
  context: Context,
  cookie: NonNullable<IdentityCookie>,
  result: { refreshedToken?: string; expiresAt?: string },
) {
  if (!result.refreshedToken || !result.expiresAt) return;
  setIdentityCookie(context, cookie, {
    token: result.refreshedToken,
    expiresAt: result.expiresAt,
  });
}

export function refreshIdentityCookieFromError(
  context: Context,
  cookie: NonNullable<IdentityCookie>,
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

export async function authenticateIdentity(
  context: Context,
  identity: IdentityProvider,
  cookie: NonNullable<IdentityCookie>,
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

export async function requireIdentitySession(
  context: Context,
  identity: IdentityProvider | undefined,
  cookie: NonNullable<IdentityCookie>,
) {
  if (!identity) return identityUnavailable(context);
  const session = await authenticateIdentity(context, identity, cookie);
  if (session) return session;
  return errorResponse(context, 401, "UNAUTHENTICATED", "请先登录");
}
