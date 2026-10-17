import type { PublicGenerationJob } from "@weftcanvas/contracts";

import type { HostedGenerationResult } from "./hosted-result.js";

/**
 * 生成 API 的结构类型（从 app.ts 抽出，纯搬移）：既服务原生 durable 任务
 * （返回裸 job），也服务托管提供方（结果包在 HostedGenerationResult 里，
 * 可携带轮换后的会话令牌）。各域模块按需引用本类型。
 */
export type GenerationApi = {
  submit(
    ownerId: string,
    value: unknown,
    token?: string,
  ): Promise<PublicGenerationJob | HostedGenerationResult<PublicGenerationJob>>;
  get(
    ownerId: string,
    jobId: string,
    token?: string,
  ): Promise<PublicGenerationJob | HostedGenerationResult<PublicGenerationJob>>;
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
