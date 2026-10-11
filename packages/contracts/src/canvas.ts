import { z } from "zod";

import { generationJobStatusSchema } from "./generation-job.js";

export const CANVAS_SCHEMA_VERSION = 1 as const;

/** 内置节点类型（闭合集合；插件节点走 plugin: 前缀命名空间，不进这里）。 */
export const builtinCanvasNodeKinds = ["text", "image", "video", "audio", "config", "edit"] as const;
export type BuiltinCanvasNodeKind = typeof builtinCanvasNodeKinds[number];
/** 插件注册的节点类型：`plugin:<pluginId>:<name>`（plugin-host 强制命名空间）。 */
export type PluginNodeKind = `plugin:${string}`;
/**
 * 持久化的节点类型：内置闭合枚举 + 插件命名空间。历史 note/music 在读取时
 * 映射回 text/audio；不认识的 plugin: kind 在宿主渲染层回落通用卡面。
 */
const persistedCanvasNodeKindSchema = z.union([
  z.enum([...builtinCanvasNodeKinds, "note", "music"]),
  z.string().regex(/^plugin:[a-z0-9][a-z0-9._-]*$/),
]);
export const canvasNodeKindSchema = persistedCanvasNodeKindSchema.transform((kind): BuiltinCanvasNodeKind | PluginNodeKind =>
  kind === "note" ? "text" : kind === "music" ? "audio" : (kind as BuiltinCanvasNodeKind | PluginNodeKind));
export type CanvasNodeKind = z.infer<typeof canvasNodeKindSchema>;

export const canvasNodeStatusSchema = z.enum(["idle", "running", "success", "error"]);
export type CanvasNodeStatus = z.infer<typeof canvasNodeStatusSchema>;

export const canvasMediaSourceSchema = z.enum(["local", "server"]);
export type CanvasMediaSource = z.infer<typeof canvasMediaSourceSchema>;

export const canvasReferenceModeSchema = z.enum(["auto", "explicit"]);
export type CanvasReferenceMode = z.infer<typeof canvasReferenceModeSchema>;

export const referenceImagePurposeSchema = z.enum(["images", "styleImages", "elementImages"]);
export type ReferenceImagePurpose = z.infer<typeof referenceImagePurposeSchema>;

export const canvasMediaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().nonnegative(),
  source: canvasMediaSourceSchema.default("local"),
  serverId: z.string().min(1).nullable().default(null),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  durationMs: z.number().int().positive().nullable().default(null),
});
export type CanvasMedia = z.infer<typeof canvasMediaSchema>;

const persistedCanvasNodeGenerationSchema = z.object({
  modelId: z.string().min(1).nullable().default(null),
  parameters: z.record(z.string(), z.unknown()).default({}),
  referenceImagePurposes: z.record(z.string(), referenceImagePurposeSchema).default({}),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).nullable().default(null),
  referenceMode: canvasReferenceModeSchema.optional(),
  referenceNodeIds: z.array(z.string().min(1).max(128)).max(32).default([]),
  jobId: z.string().min(1).nullable().default(null),
  jobVersion: z.number().int().nonnegative().nullable().default(null),
  jobCreatedAt: z.string().datetime({ offset: true }).nullable().default(null),
  jobStatus: generationJobStatusSchema.nullable().default(null),
  artifactId: z.string().min(1).optional(),
  error: z.string().min(1).nullable().default(null),
  // True only when the creator explicitly picked the aspect ratio (or picked a
  // model) on this node. Auto-written model defaults must never claim it, so
  // node geometry restores stay loyal to the creator's 默认画幅 setting.
  aspectExplicit: z.boolean().optional(),
});

export const canvasNodeGenerationSchema = persistedCanvasNodeGenerationSchema.transform((generation) => ({
  ...generation,
  referenceMode: generation.referenceMode ?? (generation.referenceNodeIds.length ? "explicit" : "auto"),
})).default({
  modelId: null,
  parameters: {},
  referenceImagePurposes: {},
  maxOutputTokens: null,
  referenceMode: "auto",
  referenceNodeIds: [],
  jobId: null,
  jobVersion: null,
  jobCreatedAt: null,
  jobStatus: null,
  error: null,
});
export type CanvasNodeGeneration = z.infer<typeof canvasNodeGenerationSchema>;

/**
 * Configuration nodes own media-generation settings. Text nodes are canvas
 * writing surfaces that can also be text-generation targets through their own
 * studio; the config node modality selector intentionally excludes text so
 * reusable settings stay on the media modalities.
 *
 * The preprocess keeps projects saved before this boundary readable by
 * mapping the removed text configuration to the historical default (image).
 */
export const canvasConfigModalitySchema = z.enum(["image", "video", "audio"]);
export type CanvasConfigModality = z.infer<typeof canvasConfigModalitySchema>;

export const canvasNodeConfigSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return record.modality === "text" ? { ...record, modality: "image" } : value;
  },
  z.object({ modality: canvasConfigModalitySchema }).nullable().default(null),
);
export type CanvasNodeConfig = z.infer<typeof canvasNodeConfigSchema>;

export const canvasDirectorCaptureSchema = z.object({
  shotId: z.string().min(1),
  slot: z.number().int().positive(),
  prompt: z.string().default(""),
});
export type CanvasDirectorCapture = z.infer<typeof canvasDirectorCaptureSchema>;

/**
 * 剪辑节点的时间线素材。时间线按轨（video/audio）顺序排列，startMs 不落盘，
 * 由顺序与裁剪区间计算得到；inMs/outMs 是素材源时间范围（半开区间）。
 * 图片素材没有源时长，默认按 3 秒展示。
 */
export const canvasEditClipTrackSchema = z.enum(["video", "audio"]);
export type CanvasEditClipTrack = z.infer<typeof canvasEditClipTrackSchema>;

export const canvasEditClipKindSchema = z.enum(["video", "image", "audio"]);
export type CanvasEditClipKind = z.infer<typeof canvasEditClipKindSchema>;

export const canvasEditClipSchema = z.object({
  id: z.string().min(1),
  track: canvasEditClipTrackSchema,
  nodeId: z.string().min(1),
  mediaId: z.string().min(1),
  name: z.string().min(1),
  kind: canvasEditClipKindSchema,
  /** 视频/音频的源时长；图片为 null，展示时长由默认图片时长决定。 */
  sourceDurationMs: z.number().int().positive().nullable().default(null),
  inMs: z.number().int().nonnegative(),
  outMs: z.number().int().positive(),
});
export type CanvasEditClip = z.infer<typeof canvasEditClipSchema>;

export const canvasEditDataSchema = z.object({
  clips: z.array(canvasEditClipSchema).default([]),
});
export type CanvasEditData = z.infer<typeof canvasEditDataSchema>;

/**
 * 音乐能力数据（挂在音频节点上，不再单独设 music kind：贴链接放歌是
 * 音频节点的一种取材方式）。streamPath 非空 = 有可播放的音频流（同源
 * 代理路径）；为空 = 外链卡片模式（平台有防盗链/DRM，只提供标题封面与
 * 跳转）。节点不持久化任何第三方媒体直链：流与封面都走同源代理路径，
 * 会话校验、SSRF 守卫与内容嗅探在 /api/v1/music/* 服务端完成。
 */
export const canvasMusicDataSchema = z.object({
  /** 原始分享/页面地址，外链卡片跳转与重新解析用。 */
  pageUrl: z.string().max(2048).default(""),
  streamPath: z.string().max(2048).nullable().default(null),
  coverPath: z.string().max(2048).nullable().default(null),
  title: z.string().max(200).default(""),
  artist: z.string().max(200).default(""),
  source: z.enum(["netease", "qq", "qishui", "direct", "link"]).default("link"),
  resolvedAt: z.number().int().nonnegative().default(0),
});
export type CanvasMusicData = z.infer<typeof canvasMusicDataSchema>;

export const canvasGroupFrameSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type CanvasGroupFrame = z.infer<typeof canvasGroupFrameSchema>;

export const canvasGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(32),
  color: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).default([]),
  frame: canvasGroupFrameSchema.nullable().default(null),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type CanvasGroup = z.infer<typeof canvasGroupSchema>;

export const canvasNodeDataSchema = z.object({
  kind: canvasNodeKindSchema,
  body: z.string().default(""),
  accent: z.string().default("jade"),
  status: canvasNodeStatusSchema.default("idle"),
  progress: z.number().int().min(0).max(100).nullable().default(null),
  media: canvasMediaSchema.nullable().default(null),
  /**
   * 素材正在上传/落库中：节点已建好（用户立刻看得见），字节还在路上。
   * 载入完成后由调用方置回 false。可选字段，旧项目与测试夹具无需改写；
   * 落盘时若仍是 true（例如上传中途刷新），下次打开按无素材的空节点处理，
   * 不会卡在加载态。
   */
  uploading: z.boolean().optional(),
  directorCapture: canvasDirectorCaptureSchema.nullable().default(null),
  config: canvasNodeConfigSchema,
  edit: canvasEditDataSchema.nullable().default(null),
  music: canvasMusicDataSchema.nullable().default(null),
  generation: canvasNodeGenerationSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type CanvasNodeData = z.infer<typeof canvasNodeDataSchema> & Record<string, unknown>;

export const canvasViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().positive(),
});
export type CanvasViewport = z.infer<typeof canvasViewportSchema>;

export const canvasNodeRecordSchema = z.object({
  id: z.string().min(1),
  type: z.literal("kachang"),
  position: z.object({ x: z.number(), y: z.number() }),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  selected: z.boolean().optional(),
  data: canvasNodeDataSchema,
});
export type CanvasNodeRecord = z.infer<typeof canvasNodeRecordSchema>;

export const canvasEdgeRecordSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
  selected: z.boolean().optional(),
});
export type CanvasEdgeRecord = z.infer<typeof canvasEdgeRecordSchema>;

export const canvasProjectSchema = z.object({
  schemaVersion: z.literal(CANVAS_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(canvasNodeRecordSchema),
  edges: z.array(canvasEdgeRecordSchema),
  groups: z.array(canvasGroupSchema).default([]),
  viewport: canvasViewportSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type CanvasProject = z.infer<typeof canvasProjectSchema>;

export const canvasNodeLabels: Record<BuiltinCanvasNodeKind, string> = {
  text: "文本节点",
  image: "图片节点",
  video: "视频节点",
  audio: "音频节点",
  config: "配置节点",
  edit: "剪辑节点",
};
