import type { Context } from "hono";

import { errorResponse } from "../http/errors.js";
import {
  authenticateIdentity,
  identityUnavailable,
  type IdentityCookie,
} from "../identity/http-session.js";
import type { IdentityProvider } from "../identity/provider.js";
import type { AgentService } from "./service.js";

/**
 * Agent HTTP 面的结构类型与访问解析（从 app.ts 抽出，纯搬移）。各 Agent 域名
 * 模块按需引用；app.ts 继续 re-export `AgentApi`，既有测试导入路径不变。
 */
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

export type AgentAccessDependencies = {
  agent?: AgentApi;
  anonymousAgent?: AgentApi;
  identity?: IdentityProvider;
};

export type AgentAccess = {
  agent: AgentApi;
  ownerId: string;
  anonymous: boolean;
};

export function agentUnavailable(context: Context) {
  return errorResponse(context, 503, "AGENT_UNAVAILABLE", "Agent 服务暂未配置");
}

export async function resolveAgentAccess(
  context: Context,
  dependencies: AgentAccessDependencies,
  identityCookie: IdentityCookie,
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
