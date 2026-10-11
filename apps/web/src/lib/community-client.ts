import { communityFeedResponseSchema, type CommunityFeedPost } from "@kachang/contracts";

import { downloadRemoteImage, signCardLibraryMediaUrl } from "./card-library-client";
import { storeMedia } from "./media-store";
import type { InsertableAsset } from "../components/resource-drawer";

/**
 * prompt-hub 公开社区流（画布左栏「社区卡片」弹层）。
 * 数据经画布 API 同源代理（/api/v1/community/feed）拉取，图片走与卡片库
 * 相同的 media-sign / media-proxy 链路，无跨域依赖。
 */

const COMMUNITY_FEED_TTL_MS = 5 * 60_000;

let feedCache: { posts: CommunityFeedPost[]; at: number } | null = null;
let feedPending: Promise<CommunityFeedPost[]> | null = null;

/** 拉取社区帖子（带 5 分钟缓存与在途去重）。force=true 跳过缓存（重试用）。 */
export async function fetchCommunityPosts(limit = 30, force = false): Promise<CommunityFeedPost[]> {
  if (!force && feedCache && Date.now() - feedCache.at < COMMUNITY_FEED_TTL_MS) return feedCache.posts;
  if (!force && feedPending) return feedPending;
  const pending = (async () => {
    const response = await fetch("/api/v1/community/feed?limit=" + encodeURIComponent(String(limit)), {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    const parsed = communityFeedResponseSchema.safeParse(payload);
    if (!response.ok || !parsed.success) throw new Error("社区数据加载失败");
    const posts = parsed.data.data.posts.filter((post) => (post.image ?? "").trim() !== "");
    feedCache = { posts, at: Date.now() };
    return posts;
  })();
  feedPending = pending.finally(() => {
    feedPending = null;
  });
  return pending;
}

/** 社区排序（对齐社区页口径：随机 / 热门 / 最新；公开接口在前端排序）。 */
export type CommunitySort = "random" | "hot" | "new";

export function sortCommunityPosts(posts: CommunityFeedPost[], sort: CommunitySort): CommunityFeedPost[] {
  const list = [...posts];
  if (sort === "hot") return list.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
  if (sort === "new") return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  // random：随机 key 排序（避免索引交换写法，noUncheckedIndexedAccess 下会触发 TS2719）
  return list
    .map((post) => ({ post, key: Math.random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ post }) => post);
}

/** 弹层网格缩略图：优先用代理富化的公开 CDN URL（免签名）；https 图直接用。 */
export async function communityThumbUrl(post: CommunityFeedPost): Promise<string | null> {
  const enriched = (post.imageUrl ?? "").trim();
  if (enriched) return enriched;
  const ref = (post.image ?? "").trim();
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  return signCardLibraryMediaUrl(ref, "thumb");
}

/** 社区大图预览展示 URL：富化 CDN 图 → https 原图 → media-sign full。
    返回空数组表示原图解析不可得，由预览层回退缩略图。 */
export async function communityLargeImageUrl(post: CommunityFeedPost): Promise<string[]> {
  const enriched = (post.imageUrl ?? "").trim();
  if (enriched) return [enriched];
  const ref = (post.image ?? "").trim();
  if (!ref) return [];
  if (/^https?:\/\//i.test(ref)) return [ref];
  const signed = await signCardLibraryMediaUrl(ref, "full");
  return signed ? [signed] : [];
}

/** 插画布用原图字节：公开 CDN 直连（失败走同源代理代拉），media-sign 作兜底。 */
export async function downloadCommunityImage(post: CommunityFeedPost): Promise<Blob | null> {
  const ref = (post.image ?? "").trim();
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return downloadRemoteImage(ref);
  const enriched = (post.imageUrl ?? "").trim();
  if (enriched) {
    const blob = await downloadRemoteImage(enriched).catch(() => null);
    if (blob) return blob;
  }
  const signed = await signCardLibraryMediaUrl(ref, "full");
  if (!signed) return null;
  return downloadRemoteImage(signed);
}

/** 社区帖 → 画布插入对象：图片入 IndexedDB 媒体库；图片不可得时降级纯 prompt 文本节点。 */
export async function communityPostToInsertable(post: CommunityFeedPost): Promise<InsertableAsset | null> {
  const body = (post.prompt || post.title || "").trim();
  const fallbackText: InsertableAsset | null = body ? { kind: "text", body, media: null, extraMedia: [] } : null;
  const blob = await downloadCommunityImage(post).catch(() => null);
  if (!blob) return fallbackText;
  const media = await storeMedia(
    new File([blob], communityImageFileName(post, blob.type), { type: blob.type }),
    "image",
  );
  return { kind: "image", body, media, extraMedia: [] };
}

function communityImageFileName(post: CommunityFeedPost, mimeType: string) {
  const extension = ({ "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif" } as Record<string, string>)[mimeType] || "jpg";
  const base = (post.title || post.prompt || "社区图片").trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60) || "社区图片";
  return `${base}.${extension}`;
}
