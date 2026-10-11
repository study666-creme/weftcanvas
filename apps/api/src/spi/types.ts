import type { PublicGenerationJob } from "@kachang/contracts";

import type { KachangCatalogAdapter } from "../catalog/adapter.js";
import type { HostedGenerationResult } from "../generation/hosted-result.js";
import type { MediaService } from "../media/service.js";
import type { MembershipTaskProvider, WalletProvider } from "../wallet/provider.js";

/**
 * 画布 API 的 Provider SPI（docs/PLUGIN-ROADMAP.md §5 P2）。
 *
 * app.ts 只依赖这里声明的结构化接口，不 import 任何具体 provider 实现；
 * server.ts 按 `CANVAS_API_PROVIDER`（dev-test / kachang，见 spi/assembly.ts）
 * 装配。IdentityProvider 已在 identity/provider.ts 定义，这里是转出口。
 */
export type { IdentityProvider } from "../identity/provider.js";
export { IdentityProviderError } from "../identity/provider.js";

/** 模型目录 + 报价：KachangCatalogAdapter 是参考实现，任何等价对象都可装配。 */
export type CatalogProvider = Pick<
  KachangCatalogAdapter,
  "getCatalog" | "getModel" | "getExecutionRoute"
>;

/**
 * 媒体（上传/签名 URL/清理）：媒体栈本身已经 provider 无关
 * （media/object-store-factory 抽象了存储后端），MediaService 是参考实现。
 */
export type MediaProvider = MediaService;

/**
 * 托管账号 bundle：钱包 + 会员任务。收藏卡片/公开社区流不走这里——
 * 那是账号侧内容库，经 AccountRouteRegistrar 由私有 overlay 挂载
 * （account-routes/contract.ts），开源构建整体不挂载。
 */
export type HostedAccountProvider = WalletProvider & MembershipTaskProvider;

/**
 * 生成服务的结构化接口：原生 durable 任务返回裸 job，托管任务返回
 * HostedGenerationResult 信封。原为 app.ts 内联类型，随 P2 上收到 SPI。
 */
export type GenerationProvider = {
  submit(ownerId: string, value: unknown, token?: string): Promise<PublicGenerationJob | HostedGenerationResult<PublicGenerationJob>>;
  get(ownerId: string, jobId: string, token?: string): Promise<PublicGenerationJob | HostedGenerationResult<PublicGenerationJob>>;
  list(
    ownerId: string,
    value: { projectId?: string; limit?: number },
    token?: string,
  ): Promise<PublicGenerationJob[] | HostedGenerationResult<PublicGenerationJob[]>>;
  /** Resolve one durable request by its existing idempotency identity (read-only). */
  resolveByIdempotency?(
    ownerId: string,
    key: string,
    token?: string,
  ): Promise<PublicGenerationJob | HostedGenerationResult<PublicGenerationJob> | null>;
  openMedia?(
    ownerId: string,
    mediaId: string,
    token?: string,
    range?: string,
    projectId?: string,
    signal?: AbortSignal,
  ): Promise<HostedGenerationResult<Response>>;
  createReferenceUpload?(
    ownerId: string,
    value: unknown,
    token?: string,
  ): Promise<HostedGenerationResult<unknown>>;
  uploadReference?(
    ownerId: string,
    mediaId: string,
    source: AsyncIterable<Uint8Array>,
    token?: string,
    contentType?: string,
    contentLength?: number | null,
    projectId?: string,
  ): Promise<HostedGenerationResult<unknown>>;
  getReference?(ownerId: string, mediaId: string): Promise<unknown>;
  createProviderReference?(
    ownerId: string,
    mediaId: string,
    kind: "image" | "video" | "audio",
    token?: string,
    projectId?: string,
  ): Promise<HostedGenerationResult<{ url: string }>>;
};
