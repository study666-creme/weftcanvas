import type { Hono } from "hono";

import type { IdentityProvider } from "../identity/provider.js";

/**
 * 账号侧内容库（收藏卡片 + 公开社区流）的路由挂载契约 —— **公开骨架**
 * （docs/PLUGIN-ROADMAP.md §5：开源版不留内容库功能）。
 *
 * 实现与全部路由都在私有 overlay（account-routes/weftcanvas-routes.ts，公开树经
 * boundary 排除并由一个签名兼容的空壳替代：路由不注册，这些端点在
 * 开源构建里不存在——不是"存在但 503"，而是功能整体不挂载）。
 */
export type AccountRouteKit = {
  identity: IdentityProvider | undefined;
  identityCookie: { name: string; secure: boolean };
};

export type AccountRouteRegistrar = (app: Hono, kit: AccountRouteKit) => void;
