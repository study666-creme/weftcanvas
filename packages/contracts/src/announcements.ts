import { z } from "zod";

/**
 * 站点公告：运营在后台发布的站点级消息（功能更新、维护通知、开源说明这类）。
 * 公开读接口匿名可用，写只走运营密钥；正文由前端解析成节点渲染，不注入 HTML。
 */
export const announcementLevelSchema = z.enum(["info", "important"]);

/** 画布前端拿到的公告条目（已按可见性过滤并按展示顺序排好）。 */
export const publicAnnouncementSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  /**
   * 正文。支持的标记很少：空行分段、行内 `**加粗**` 与 `[文字](链接)`、
   * 独立成行的 `![说明](图片)`；其余一律按纯文本展示。
   */
  body: z.string().min(1).max(4000),
  level: announcementLevelSchema,
  pinned: z.boolean(),
  /** 发布时间（ISO）。晚于当前时间的条目到点才可见（定时公告）。 */
  publishedAt: z.string().datetime({ offset: true }),
});

export const announcementListSchema = z.object({ items: z.array(publicAnnouncementSchema) });

export const announcementListResponseSchema = z.object({
  ok: z.literal(true),
  data: announcementListSchema,
});

export type AnnouncementLevel = z.infer<typeof announcementLevelSchema>;
export type PublicAnnouncement = z.infer<typeof publicAnnouncementSchema>;
export type AnnouncementList = z.infer<typeof announcementListSchema>;
