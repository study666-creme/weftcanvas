import type { Context } from "hono";
import { getCookie } from "hono/cookie";

import type { MediaUploadIntent } from "@weftcanvas/contracts";

import { refreshIdentityCookie, type IdentityCookie } from "../identity/http-session.js";
import { cloudProjectsUnavailable, type ProjectApi } from "../project/api.js";
import type { CloudProjectEntitlementResolver } from "../project/types.js";

/**
 * 素材路由与项目域共用的访问解析（从 app.ts 抽出，纯搬移）：项目作用域下的
 * 素材归属、配额与上传意图里的项目参数。
 */
export type MediaAccessDependencies = {
  entitlements?: CloudProjectEntitlementResolver;
  projects?: Pick<ProjectApi, "resolveMediaAccess">;
};

export type ProjectMediaAccess = {
  ownerId: string;
  mediaStorageBytes?: number;
  token?: string;
};

export async function resolveMediaQuotaBytes(
  context: Context,
  dependencies: MediaAccessDependencies,
  ownerId: string,
  token: string | undefined,
  cookie: IdentityCookie,
) {
  if (!dependencies.entitlements) return 0;
  const resolved = await dependencies.entitlements.resolve(ownerId, token);
  refreshIdentityCookie(context, cookie, resolved);
  return resolved.data.mediaStorageBytes;
}

export async function resolveProjectMediaAccess(
  context: Context,
  dependencies: MediaAccessDependencies,
  cookie: IdentityCookie,
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

export function scopeMediaUploadIntent(
  intent: MediaUploadIntent,
  projectId?: string,
): MediaUploadIntent {
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

export function mediaProjectUrl(value: string, projectId?: string) {
  if (!projectId) return value;
  const internalOrigin = "http://canvas.internal";
  const url = new URL(value, internalOrigin);
  if (url.origin !== internalOrigin) return value;
  url.searchParams.set("projectId", projectId);
  return `${url.pathname}${url.search}${url.hash}`;
}
