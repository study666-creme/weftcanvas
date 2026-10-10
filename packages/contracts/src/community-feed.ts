import { z } from "zod";

/**
 * prompt-hub 公开社区流（GET /api/v1/community/feed）的最小契约。
 * 只取画布「社区卡片」弹层用得到的字段；image 是 prompt-hub 的媒体 ref
 * （storage://card-images/... 或 https URL），需要经 media-sign 换成可访问 URL。
 */
export const communityFeedPostSchema = z.object({
  id: z.string().min(1),
  sourceCardId: z.string().nullable().optional(),
  authorId: z.string().optional(),
  authorName: z.string().optional(),
  title: z.string().optional(),
  prompt: z.string().optional(),
  image: z.string().nullable().optional(),
  likes: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  /** 画布 API 代理时富化：由 image ref 直接推导的公开 CDN 图 URL（免签名）。 */
  imageUrl: z.string().optional(),
});

export const communityFeedPageSchema = z.object({
  posts: z.array(communityFeedPostSchema),
  limit: z.number(),
  offset: z.number(),
  nextOffset: z.number(),
  hasMore: z.boolean(),
});

export const communityFeedResponseSchema = z.object({
  ok: z.literal(true),
  data: communityFeedPageSchema,
});

export type CommunityFeedPost = z.infer<typeof communityFeedPostSchema>;
export type CommunityFeedPage = z.infer<typeof communityFeedPageSchema>;
