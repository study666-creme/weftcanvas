import { z } from "zod";

export const cardLibraryCardSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""),
  prompt: z.string().default(""),
  imageRef: z.string().default(""),
  /** 多图卡片的其余图片引用（不含封面，封面在 imageRef）。 */
  imageRefs: z.array(z.string()).default([]),
  thumbUrl: z.string().default(""),
  hasImage: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  group: z.string().nullable().default(null),
  genJobId: z.string().nullable().optional(),
  isMidjourney: z.boolean().optional(),
  updatedAt: z.number().nonnegative().default(0),
});
export type CardLibraryCard = z.infer<typeof cardLibraryCardSchema>;

export const cardLibraryCardListSchema = z.object({
  cards: z.array(cardLibraryCardSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
});
export type CardLibraryCardList = z.infer<typeof cardLibraryCardListSchema>;

export const cardLibraryCardListResponseSchema = z.object({
  ok: z.literal(true),
  data: cardLibraryCardListSchema,
});

export const cardLibraryGroupListSchema = z.object({
  groups: z.array(z.string().trim().min(1).max(120)).max(500),
});
export type CardLibraryGroupList = z.infer<typeof cardLibraryGroupListSchema>;

export const cardLibraryGroupListResponseSchema = z.object({
  ok: z.literal(true),
  data: cardLibraryGroupListSchema,
});

export const cardLibraryTagListSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(120)).max(500),
});
export type CardLibraryTagList = z.infer<typeof cardLibraryTagListSchema>;

export const cardLibraryTagListResponseSchema = z.object({
  ok: z.literal(true),
  data: cardLibraryTagListSchema,
});

export const cardLibraryMediaSignResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    url: z.string().url(),
    expiresIn: z.number().nonnegative().optional(),
    cdn: z.boolean().optional(),
  }),
});
