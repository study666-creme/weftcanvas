/**
 * 托管（hosted）生成结果的中立信封（docs/PLUGIN-ROADMAP.md §5 P2）：
 * app 的 GenerationApi 既服务原生 durable 任务（返回裸 job），也服务
 * provider 托管任务（返回带 refreshedToken/expiresAt 的信封）。信封形状
 * 本身是 provider 无关的，单独成模块，避免 app 依赖任何具体 provider 实现。
 */
export type HostedGenerationResult<T> = {
  data: T;
  refreshedToken?: string;
  expiresAt?: string;
};

export type HostedMediaResponse = HostedGenerationResult<Response>;
