import type { Context } from "hono";

import { cloudProjectPrincipalIdSchema } from "@weftcanvas/contracts";

import type { CloudProjectCollaborationService } from "./collaboration-service.js";
import type { CloudProjectService } from "./service.js";
import { errorResponse } from "../http/errors.js";

/**
 * 云项目与协作的结构类型（从 app.ts 抽出，纯搬移）：路由只依赖这里列出的
 * 方法，注入的测试替身不必实现整个服务。
 */
export type ProjectApi = Pick<CloudProjectService, "list" | "get" | "create" | "save" | "delete"> &
  Partial<Pick<CloudProjectService, "getForActor" | "saveForActor" | "resolveMediaAccess">>;

export type CollaborationApi = Pick<
  CloudProjectCollaborationService,
  | "listMembers"
  | "invite"
  | "listInvitations"
  | "acceptInvitation"
  | "removeMember"
  | "revokeInvitation"
  | "declineInvitation"
>;

export function cloudProjectsUnavailable(context: Context) {
  return errorResponse(
    context,
    503,
    "CLOUD_PROJECTS_UNAVAILABLE",
    "Cloud project storage is not configured",
  );
}

export function collaborationUnavailable(context: Context) {
  return errorResponse(
    context,
    503,
    "COLLABORATION_UNAVAILABLE",
    "Project collaboration is not configured",
  );
}

export function setCloudProjectEtag(context: Context, projectId: string, revision: number) {
  context.header("ETag", `"${projectId}:${revision}"`);
}

export function optionalProjectOwnerId(value: string | undefined) {
  return value === undefined ? undefined : cloudProjectPrincipalIdSchema.parse(value);
}
