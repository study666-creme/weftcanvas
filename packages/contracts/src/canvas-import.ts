import { z } from "zod";

/**
 * 第三方画布导入（LibTV / TapNow / UpDream）。
 *
 * 服务端一次请求把对方画布读成中间表示：节点、连线、跳过项、提醒。浏览器只做
 * 两件事——把素材经同源代理路径拉下来存进本地媒体库，再用画布自己的插入动作
 * 落成节点与连线。节点里不落任何第三方媒体直链，与本仓库音乐节点同一约定：
 * 会话校验、SSRF 守卫与内容嗅探都在 /api/v1/canvas-import/* 服务端完成。
 *
 * 三个来源的凭证形态不同，契约只描述"读到了什么"，不描述怎么读：
 * - libtv：需要服务端配置的画布令牌，标识是 32 位画布 UUID；
 * - tapnow：公开分享链接，标识是分享 ID；
 * - updream：公开分享口令（`share://…`），标识是口令本身。
 */
export const canvasImportProviders = ["libtv", "tapnow", "updream"] as const;
export const canvasImportProviderSchema = z.enum(canvasImportProviders);
export type CanvasImportProvider = z.infer<typeof canvasImportProviderSchema>;

export const canvasImportProviderLabels: Record<CanvasImportProvider, string> = {
  libtv: "LibTV",
  tapnow: "TapNow",
  updream: "UpDream",
};

export const canvasImportProviderHints: Record<CanvasImportProvider, string> = {
  libtv: "粘贴 LibTV 画布链接或 32 位画布 UUID",
  tapnow: "粘贴 TapNow 分享链接或分享 ID",
  updream: "粘贴 UpDream 分享口令（share://…）",
};

export const canvasImportRequestSchema = z.object({
  provider: canvasImportProviderSchema,
  /** 用户粘贴的原始内容：画布链接、UUID、分享 ID 或分享口令。 */
  reference: z.string().trim().min(1).max(2_048),
});
export type CanvasImportRequest = z.infer<typeof canvasImportRequestSchema>;

/** 导入后的节点类型：只落在画布已有的取材节点上，不认识的一律跳过并记录原因。 */
export const canvasImportNodeKindSchema = z.enum(["text", "image", "video", "audio"]);
export type CanvasImportNodeKind = z.infer<typeof canvasImportNodeKindSchema>;

export const canvasImportAssetSchema = z.object({
  /** 同源代理路径（/api/v1/canvas-import/asset?…）；代拉时逐跳重新守卫。 */
  path: z.string().min(1).max(4_096),
  mimeType: z.string().min(1).max(128),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  durationMs: z.number().int().positive().nullable().default(null),
});
export type CanvasImportAsset = z.infer<typeof canvasImportAssetSchema>;

export const canvasImportNodeSchema = z.object({
  /** 来源画布内的节点标识，用于把连线端点接回本画布的新节点。 */
  key: z.string().min(1).max(192),
  kind: canvasImportNodeKindSchema,
  title: z.string().max(200).default(""),
  /** 图片/视频节点的来源提示词会存进 body：节点上不显示，但预览与后续复用都读得到。 */
  body: z.string().max(20_000).default(""),
  prompt: z.string().max(8_000).default(""),
  model: z.string().max(200).default(""),
  position: z.object({ x: z.number(), y: z.number() }),
  width: z.number().positive(),
  height: z.number().positive(),
  /**
   * 素材尚未落地的节点（对方还没出结果的占位、或最近一次任务失败）如实标成
   * idle / error，不会被伪装成成功。
   */
  status: z.enum(["idle", "success", "error"]).default("idle"),
  error: z.string().max(2_000).default(""),
  /** 对方自己的节点类型（如 material-style、agent），写进节点来源备查。 */
  sourceType: z.string().max(64).default(""),
  asset: canvasImportAssetSchema.nullable().default(null),
});
export type CanvasImportNode = z.infer<typeof canvasImportNodeSchema>;

export const canvasImportEdgeSchema = z.object({
  key: z.string().min(1).max(192),
  /** 端点用节点 key，不暴露对方内部的连线 ID。 */
  source: z.string().min(1).max(192),
  target: z.string().min(1).max(192),
});
export type CanvasImportEdge = z.infer<typeof canvasImportEdgeSchema>;

export const canvasImportNoticeSchema = z.object({
  id: z.string().max(192).default(""),
  message: z.string().min(1).max(300),
});
export type CanvasImportNotice = z.infer<typeof canvasImportNoticeSchema>;

export const canvasImportPreviewSchema = z.object({
  provider: canvasImportProviderSchema,
  /** 画布标识（LibTV UUID / TapNow 分享 ID / UpDream 口令），回写进节点来源。 */
  sourceId: z.string().min(1).max(192),
  projectName: z.string().max(200).default(""),
  batchId: z.string().min(1).max(128),
  nodes: z.array(canvasImportNodeSchema).max(500),
  edges: z.array(canvasImportEdgeSchema).max(2_000),
  /** 跳过的节点/连线：逐条说明原因，前端按可读文案汇总，不做静默丢弃。 */
  skipped: z.array(canvasImportNoticeSchema).max(200).default([]),
  warnings: z.array(canvasImportNoticeSchema).max(200).default([]),
});
export type CanvasImportPreview = z.infer<typeof canvasImportPreviewSchema>;

export const canvasImportPreviewResponseSchema = z.object({
  ok: z.literal(true),
  data: canvasImportPreviewSchema,
});
export type CanvasImportPreviewResponse = z.infer<typeof canvasImportPreviewResponseSchema>;

/**
 * 来源可用性：LibTV 需要服务端令牌，未配置时如实报不可用，前端据此禁用入口并
 * 说明还差哪一步，而不是让用户点进去再撞一次失败。
 */
export const canvasImportProviderStatusSchema = z.object({
  provider: canvasImportProviderSchema,
  available: z.boolean(),
  /** 不可用时的原因（已经是可以直接展示的中文短句）。 */
  reason: z.string().max(200).default(""),
});
export type CanvasImportProviderStatus = z.infer<typeof canvasImportProviderStatusSchema>;

export const canvasImportProvidersResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ providers: z.array(canvasImportProviderStatusSchema) }),
});
export type CanvasImportProvidersResponse = z.infer<typeof canvasImportProvidersResponseSchema>;
