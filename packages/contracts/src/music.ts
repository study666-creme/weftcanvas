import { z } from "zod";

/**
 * 音乐链接解析（画布音乐节点的粘贴链接入口）。
 *
 * 服务端代为抓取分享页/直链并判定可用性：
 * - kind "audio"：拿到了可服务端代拉的音频直链（streamUrl），
 *   同时给出同源代理路径 streamPath，浏览器只请求代理路径；
 * - kind "link"：平台有防盗链/DRM（QQ音乐、汽水音乐等），
 *   只返回标题/封面元信息与页面地址，由前端生成外链卡片。
 */
export const musicLinkSources = ["netease", "qq", "qishui", "direct", "link"] as const;
export const musicLinkSourceSchema = z.enum(musicLinkSources);
export type MusicLinkSource = z.infer<typeof musicLinkSourceSchema>;

export const musicLinkResolveRequestSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
});
export type MusicLinkResolveRequest = z.infer<typeof musicLinkResolveRequestSchema>;

export const musicLinkResolveDataSchema = z.object({
  source: musicLinkSourceSchema,
  kind: z.enum(["audio", "link"]),
  title: z.string().max(200).default(""),
  artist: z.string().max(200).default(""),
  pageUrl: z.string().max(2_048),
  /** 原始音频直链，仅供服务端代拉，浏览器不得直接请求。 */
  streamUrl: z.string().max(2_048).nullable().default(null),
  /** 原始封面直链，仅供服务端代拉。 */
  coverUrl: z.string().max(2_048).nullable().default(null),
  /** 同源代理播放路径（/api/v1/music/stream?...），可直接喂给 <audio>。 */
  streamPath: z.string().max(2_048).nullable().default(null),
  /** 同源代理封面路径（/api/v1/music/cover?...），可直接喂给 <img>。 */
  coverPath: z.string().max(2_048).nullable().default(null),
});
export type MusicLinkResolveData = z.infer<typeof musicLinkResolveDataSchema>;

export const musicLinkResolveResponseSchema = z.object({
  ok: z.literal(true),
  data: musicLinkResolveDataSchema,
});
export type MusicLinkResolveResponse = z.infer<typeof musicLinkResolveResponseSchema>;
