import {
  cardLibraryCardListResponseSchema,
  cardLibraryGroupListResponseSchema,
  cardLibraryMediaSignResponseSchema,
  cardLibraryTagListResponseSchema,
  type CardLibraryCard,
  type CardLibraryCardList,
  type CardLibraryGroupList,
  type CardLibraryTagList,
} from "@kachang/contracts";

export type CardLibraryListFilters = { page?: number; limit?: number; query?: string; group?: string; tag?: string };
export type CardLibraryListOptions = { cacheScope?: string; force?: boolean };
export type CachedCardLibraryCards = { data: CardLibraryCardList; fresh: boolean };
export type CachedCardLibraryGroups = { data: CardLibraryGroupList; fresh: boolean };
export type CachedCardLibraryTags = { data: CardLibraryTagList; fresh: boolean };

const CARD_LIST_CACHE_TTL_MS = 5 * 60_000;
const CARD_LIST_CACHE_LIMIT = 32;
const GROUP_LIST_CACHE_LIMIT = 32;
/** 远端原图可能体积很大（4K/多图），收藏下载走独立的宽松超时。 */
const CARD_IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** 签名 URL 短时有效，缓存比列表短一档即可减少收藏时的重复签名请求。 */
const MEDIA_SIGN_CACHE_TTL_MS = 2 * 60_000;
const MEDIA_SIGN_CACHE_LIMIT = 96;

type CardListCacheEntry = {
  cachedAt: number;
  data: CardLibraryCardList;
  scope: string;
};

type GroupListCacheEntry = {
  cachedAt: number;
  data: CardLibraryGroupList;
  scope: string;
};

type TagListCacheEntry = {
  cachedAt: number;
  data: CardLibraryTagList;
  scope: string;
};

type ScopedRequest<T> = {
  request: Promise<T>;
  scope: string;
};

const cardListCache = new Map<string, CardListCacheEntry>();
const cardListRequests = new Map<string, ScopedRequest<CardLibraryCardList>>();
const groupListCache = new Map<string, GroupListCacheEntry>();
const groupListRequests = new Map<string, ScopedRequest<CardLibraryGroupList>>();
const tagListCache = new Map<string, TagListCacheEntry>();
const tagListRequests = new Map<string, ScopedRequest<CardLibraryTagList>>();
const mediaSignCache = new Map<string, { cachedAt: number; url: string }>();
const mediaSignRequests = new Map<string, Promise<string | null>>();

export class CardLibraryError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "CardLibraryError";
  }
}

export async function listCardLibraryCards(
  filters: CardLibraryListFilters = {},
  options: CardLibraryListOptions = {},
): Promise<CardLibraryCardList> {
  const normalized = normalizeCardListFilters(filters);
  const key = options.cacheScope ? cardListCacheKey(options.cacheScope, normalized) : null;

  if (key && !options.force) {
    const cached = readCardListCache(key);
    if (cached?.fresh) return cached.data;
  }
  if (key) {
    const pending = cardListRequests.get(key)?.request;
    if (pending) return pending;
  }

  const request = requestCardLibraryCards(normalized);
  if (!key || !options.cacheScope) return request;

  cardListRequests.set(key, { request, scope: options.cacheScope });
  try {
    const data = await request;
    if (cardListRequests.get(key)?.request === request) {
      cardListCache.set(key, { cachedAt: Date.now(), data, scope: options.cacheScope });
      trimCache(cardListCache, CARD_LIST_CACHE_LIMIT);
    }
    return data;
  } finally {
    if (cardListRequests.get(key)?.request === request) cardListRequests.delete(key);
  }
}

export async function listCardLibraryGroups(
  options: CardLibraryListOptions = {},
): Promise<CardLibraryGroupList> {
  const key = options.cacheScope || null;

  if (key && !options.force) {
    const cached = readGroupListCache(key);
    if (cached?.fresh) return cached.data;
  }
  if (key) {
    const pending = groupListRequests.get(key)?.request;
    if (pending) return pending;
  }

  const request = requestCardLibraryGroups();
  if (!key || !options.cacheScope) return request;

  groupListRequests.set(key, { request, scope: options.cacheScope });
  try {
    const data = await request;
    if (groupListRequests.get(key)?.request === request) {
      groupListCache.set(key, { cachedAt: Date.now(), data, scope: options.cacheScope });
      trimCache(groupListCache, GROUP_LIST_CACHE_LIMIT);
    }
    return data;
  } finally {
    if (groupListRequests.get(key)?.request === request) groupListRequests.delete(key);
  }
}

export async function listCardLibraryTags(
  options: CardLibraryListOptions = {},
): Promise<CardLibraryTagList> {
  const key = options.cacheScope || null;

  if (key && !options.force) {
    const cached = readTagListCache(key);
    if (cached?.fresh) return cached.data;
  }
  if (key) {
    const pending = tagListRequests.get(key)?.request;
    if (pending) return pending;
  }

  const request = requestCardLibraryTags();
  if (!key || !options.cacheScope) return request;

  tagListRequests.set(key, { request, scope: options.cacheScope });
  try {
    const data = await request;
    if (tagListRequests.get(key)?.request === request) {
      tagListCache.set(key, { cachedAt: Date.now(), data, scope: options.cacheScope });
      trimCache(tagListCache, GROUP_LIST_CACHE_LIMIT);
    }
    return data;
  } finally {
    if (tagListRequests.get(key)?.request === request) tagListRequests.delete(key);
  }
}

export function getCachedCardLibraryCards(
  filters: CardLibraryListFilters,
  cacheScope: string,
): CachedCardLibraryCards | null {
  return readCardListCache(cardListCacheKey(cacheScope, normalizeCardListFilters(filters)));
}

export function getCachedCardLibraryGroups(cacheScope: string): CachedCardLibraryGroups | null {
  return readGroupListCache(cacheScope);
}

export function getCachedCardLibraryTags(cacheScope: string): CachedCardLibraryTags | null {
  return readTagListCache(cacheScope);
}

export function clearCardLibraryCardsCache(cacheScope?: string) {
  if (!cacheScope) {
    cardListCache.clear();
    cardListRequests.clear();
    groupListCache.clear();
    groupListRequests.clear();
    tagListCache.clear();
    tagListRequests.clear();
    return;
  }
  cardListCache.forEach((entry, key) => {
    if (entry.scope === cacheScope) cardListCache.delete(key);
  });
  cardListRequests.forEach((entry, key) => {
    if (entry.scope === cacheScope) cardListRequests.delete(key);
  });
  groupListCache.forEach((entry, key) => {
    if (entry.scope === cacheScope) groupListCache.delete(key);
  });
  groupListRequests.forEach((entry, key) => {
    if (entry.scope === cacheScope) groupListRequests.delete(key);
  });
  tagListCache.forEach((entry, key) => {
    if (entry.scope === cacheScope) tagListCache.delete(key);
  });
  tagListRequests.forEach((entry, key) => {
    if (entry.scope === cacheScope) tagListRequests.delete(key);
  });
}

/**
 * 收藏下载一张卡片原图。远端媒体域通常不开 CORS（跨域 fetch 一律失败），
 * 顺序是：直连（仅同源 URL 能成）→ 走同源 /api/v1/card-library/media-proxy
 * 由服务端代拉。服务端持有登录会话，返回的是与源站一致的图片字节。
 */
export async function downloadCardLibraryImage(card: CardLibraryCard) {
  return downloadImageByRef(card, card.imageRef.trim(), card.thumbUrl);
}

/** 收藏多图卡片时按顺序下载全部图片；单张失败不阻断其余图片。 */
export async function downloadCardLibraryImages(card: CardLibraryCard): Promise<Blob[]> {
  const refs = cardImageRefs(card);
  const blobs: Blob[] = [];
  for (const ref of refs) {
    const blob = await downloadImageByRef(card, ref, ref === refs[0] ? card.thumbUrl : "");
    if (blob) blobs.push(blob);
  }
  if (blobs.length) return blobs;
  throw new CardLibraryError("卡片图片暂时无法读取");
}

async function downloadImageByRef(card: CardLibraryCard, ref: string, thumbUrl: string): Promise<Blob | null> {
  if (ref.startsWith("https://") || ref.startsWith("http://")) {
    const blob = await fetchImageBlobTimed(ref);
    if (blob) return blob;
    const viaProxy = await fetchImageBlobTimed(proxiedUrl(ref), { credentials: "include" });
    if (viaProxy) return viaProxy;
  } else if (ref) {
    const signed = await signedFullUrl(ref);
    if (signed) {
      const blob = await fetchImageBlobTimed(signed);
      if (blob) return blob;
      const viaProxy = await fetchImageBlobTimed(proxiedUrl(signed), { credentials: "include" });
      if (viaProxy) return viaProxy;
    }
  }
  if (thumbUrl) return fetchImageBlobTimed(thumbUrl);
  return null;
}

function cardImageRefs(card: CardLibraryCard): string[] {
  const refs = [card.imageRef, ...(card.imageRefs ?? [])]
    .map((ref) => ref.trim())
    .filter(Boolean);
  return [...new Set(refs)].slice(0, 8);
}

function proxiedUrl(url: string) {
  return "/api/v1/card-library/media-proxy?url=" + encodeURIComponent(url);
}

async function fetchImageBlobTimed(url: string, init: RequestInit = {}): Promise<Blob | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(CARD_IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size && blob.type.startsWith("image/")) return blob;
    return null;
  } catch {
    return null;
  }
}

/** 签名结果短缓存 + 在途去重，避免同一张卡片反复触发上游签名。 */
async function signedFullUrl(ref: string, variant: "thumb" | "full" = "full"): Promise<string | null> {
  if (!ref) return null;
  const cacheKey = `${variant}#${ref}`;
  const cached = mediaSignCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < MEDIA_SIGN_CACHE_TTL_MS) return cached.url;
  const pending = mediaSignRequests.get(cacheKey);
  if (pending) return pending;
  const request = (async () => {
    try {
      const query = new URLSearchParams({ ref, variant });
      const response = await canvasFetch("/api/v1/card-library/media-sign?" + query.toString());
      const payload = await readJson(response);
      const parsed = cardLibraryMediaSignResponseSchema.safeParse(payload);
      if (!response.ok || !parsed.success) return null;
      const url = parsed.data.data.url;
      mediaSignCache.set(cacheKey, { cachedAt: Date.now(), url });
      while (mediaSignCache.size > MEDIA_SIGN_CACHE_LIMIT) {
        const oldest = mediaSignCache.keys().next().value;
        if (oldest === undefined) break;
        mediaSignCache.delete(oldest);
      }
      return url;
    } catch {
      // Older cards may still provide a public thumbnail fallback.
      return null;
    } finally {
      mediaSignRequests.delete(cacheKey);
    }
  })();
  mediaSignRequests.set(cacheKey, request);
  return request;
}

/**
 * 给画布内其他模块（社区弹层等）复用：把 prompt-hub 媒体 ref 换成可直接
 * 访问的 URL（走同源 media-sign，带短缓存）。thumb 走社区网格小图，full 是原图。
 */
export function signCardLibraryMediaUrl(ref: string, variant: "thumb" | "full" = "full"): Promise<string | null> {
  return signedFullUrl(ref, variant);
}

/**
 * 卡片大图预览用展示 URL（卡片库 + 社区弹层的预览层共用）。与下载不同：
 * 只解析 URL 交给 <img> 原生加载（远端媒体域无 CORS，fetch 会双倍流量）。
 * https 直连，storage ref 逐张签名（单张失败跳过）；全部不可得时回退
 * 缩略图。最多 8 张，与下载一致。
 */
export async function cardLibraryDisplayImageUrls(card: CardLibraryCard): Promise<string[]> {
  const urls: string[] = [];
  for (const ref of cardImageRefs(card)) {
    if (/^https?:\/\//i.test(ref)) {
      urls.push(ref);
      continue;
    }
    const signed = await signedFullUrl(ref, "full");
    if (signed) urls.push(signed);
  }
  if (!urls.length && card.thumbUrl) urls.push(card.thumbUrl);
  return urls;
}

/**
 * 下载一张远端图：先直连（仅同源/开 CORS 的域能成），失败走同源
 * media-proxy 由服务端代拉。返回 null 表示不可得。
 */
export async function downloadRemoteImage(url: string): Promise<Blob | null> {
  const direct = await fetchImageBlobTimed(url);
  if (direct) return direct;
  return fetchImageBlobTimed(proxiedUrl(url), { credentials: "include" });
}

async function canvasFetch(path: string) {
  return fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
}

async function requestCardLibraryCards(filters: Required<Pick<CardLibraryListFilters, "page" | "limit">> & { query: string; group: string; tag: string }) {
  const query = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) });
  if (filters.query) query.set("q", filters.query);
  if (filters.group) query.set("group", filters.group);
  if (filters.tag) query.set("tag", filters.tag);
  const response = await canvasFetch("/api/v1/card-library/cards?" + query.toString());
  const payload = await readJson(response);
  if (!response.ok) throw requestError(payload, response.status, "卡片加载失败");
  const parsed = cardLibraryCardListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new CardLibraryError("卡片库返回了无法识别的数据");
  return parsed.data.data;
}

async function requestCardLibraryGroups() {
  const response = await canvasFetch("/api/v1/card-library/groups");
  const payload = await readJson(response);
  if (!response.ok) throw requestError(payload, response.status, "卡片分类加载失败");
  const parsed = cardLibraryGroupListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new CardLibraryError("卡片库返回了无法识别的分类数据");
  return parsed.data.data;
}

async function requestCardLibraryTags() {
  const response = await canvasFetch("/api/v1/card-library/tags");
  const payload = await readJson(response);
  if (!response.ok) throw requestError(payload, response.status, "卡片标签加载失败");
  const parsed = cardLibraryTagListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new CardLibraryError("卡片库返回了无法识别的标签数据");
  return parsed.data.data;
}

function normalizeCardListFilters(filters: CardLibraryListFilters) {
  return {
    page: Math.max(1, filters.page || 1),
    limit: Math.min(48, Math.max(1, filters.limit || 24)),
    query: filters.query?.trim() ?? "",
    group: filters.group?.trim() ?? "",
    tag: filters.tag?.trim() ?? "",
  };
}

function cardListCacheKey(scope: string, filters: ReturnType<typeof normalizeCardListFilters>) {
  return JSON.stringify([scope, filters.page, filters.limit, filters.query, filters.group, filters.tag]);
}

function readCardListCache(key: string): CachedCardLibraryCards | null {
  const cached = cardListCache.get(key);
  if (!cached) return null;
  return { data: cached.data, fresh: Date.now() - cached.cachedAt < CARD_LIST_CACHE_TTL_MS };
}

function readGroupListCache(key: string): CachedCardLibraryGroups | null {
  const cached = groupListCache.get(key);
  if (!cached) return null;
  return { data: cached.data, fresh: Date.now() - cached.cachedAt < CARD_LIST_CACHE_TTL_MS };
}

function readTagListCache(key: string): CachedCardLibraryTags | null {
  const cached = tagListCache.get(key);
  if (!cached) return null;
  return { data: cached.data, fresh: Date.now() - cached.cachedAt < CARD_LIST_CACHE_TTL_MS };
}

function trimCache<T extends { cachedAt: number }>(cache: Map<string, T>, limit: number) {
  if (cache.size <= limit) return;
  const oldest = [...cache.entries()]
    .sort((left, right) => left[1].cachedAt - right[1].cachedAt)
    .slice(0, cache.size - limit);
  oldest.forEach(([key]) => cache.delete(key));
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function requestError(payload: unknown, status: number, fallback: string) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const message = typeof nested.message === "string"
    ? nested.message
    : typeof record.message === "string" ? record.message : fallback;
  return new CardLibraryError(message, status);
}
