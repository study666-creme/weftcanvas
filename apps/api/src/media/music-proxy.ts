import { type MusicLinkResolveData, type MusicLinkSource } from "@weftcanvas/contracts";

import type { ApiErrorStatus } from "../http/errors.js";
import { MEDIA_PROXY_MAX_REDIRECT_HOPS, guardedFetch } from "../outbound/guarded-fetch.js";

// 音乐链接代拉：流式播放不能整段限时（一首歌 3-5 分钟），超时只管连接与取头；
// 大小上限与本地上传音频一致（100MB）。
export const MUSIC_RESOLVE_TIMEOUT_MS = 15_000;
export const MUSIC_COVER_TIMEOUT_MS = 30_000;
export const MUSIC_PAGE_MAX_BYTES = 512 * 1024;
export const MUSIC_STREAM_MAX_BYTES = 100 * 1024 * 1024;
export const MUSIC_COVER_MAX_BYTES = 10 * 1024 * 1024;
export const MUSIC_AUDIO_URL_PATTERN = /\.(mp3|flac|wav|wave|ogg|oga|m4a|aac|opus|weba)$/i;
export const MUSIC_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class MusicProxyError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MusicProxyError";
  }
}

/** 用户粘贴的链接允许省略协议；仅接受 http/https。 */
export function normalizeMusicInputUrl(value: string): URL {
  const trimmed = value.trim();
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("protocol not allowed");
  return url;
}

export function detectMusicSource(url: URL): MusicLinkSource {
  const host = url.hostname.toLowerCase();
  if (host === "music.163.com" || host.endsWith(".music.163.com")) return "netease";
  if (host === "qq.com" || host.endsWith(".qq.com")) return "qq";
  if (host === "qishui.douyin.com" || host.endsWith(".qishui.douyin.com")) return "qishui";
  return "link";
}

/**
 * 音乐链接代拉：守卫逻辑在 `outbound/guarded-fetch.ts`（第三方画布素材代拉共用
 * 同一套逐跳校验），这里只负责把失败原因翻成音乐自己的错误码与文案。
 */
export async function musicGuardedFetch(
  url: string,
  init: { accept: string; signal: AbortSignal; range?: string },
) {
  return guardedFetch(url, {
    accept: init.accept,
    signal: init.signal,
    range: init.range,
    userAgent: MUSIC_FETCH_UA,
    maxRedirects: MEDIA_PROXY_MAX_REDIRECT_HOPS,
    fail: (failure) => {
      if (failure === "missing-location")
        return new MusicProxyError(503, "MUSIC_FETCH_FAILED", "链接没有返回内容");
      if (failure === "invalid-redirect")
        return new MusicProxyError(400, "MUSIC_URL_BLOCKED", "重定向目标不合法");
      if (failure === "redirect-protocol")
        return new MusicProxyError(400, "MUSIC_URL_BLOCKED", "重定向协议不允许");
      if (failure === "too-many-redirects")
        return new MusicProxyError(503, "MUSIC_FETCH_FAILED", "重定向次数过多");
      return new MusicProxyError(400, "MUSIC_URL_BLOCKED", "该链接不可用");
    },
  });
}

/** 音频魔数（WAV/FLAC/MP3/AAC/Ogg/MP4-M4A）；MP4 容器音频视频共用，由声明类型把关。 */
export function sniffAudioBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const asciiAt = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  if (asciiAt(0, 4) === "RIFF" && asciiAt(8, 4) === "WAVE") return true;
  if (asciiAt(0, 4) === "fLaC") return true;
  if (asciiAt(0, 3) === "ID3") return true;
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true; // MP3 帧同步
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return true; // ADTS AAC
  if (asciiAt(0, 4) === "OggS") return true;
  if (asciiAt(4, 4) === "ftyp") return true;
  return false;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 音频直链探测：Range 取头部小段，声明类型 + 魔数双重确认后立即断开，
 * 不为探测拉完整文件。过小文件（平台的“版权保护”提示音等占位）判不可用。
 */
async function probeMusicAudio(url: string, signal: AbortSignal) {
  const response = await musicGuardedFetch(url, {
    accept: "audio/*,*/*;q=0.5",
    signal,
    range: "bytes=0-1023",
  });
  if (!response.ok && response.status !== 206) return false;
  const declaredType =
    (response.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() ?? "";
  let audioExtension = false;
  try {
    audioExtension = MUSIC_AUDIO_URL_PATTERN.test(new URL(url).pathname);
  } catch {
    audioExtension = false;
  }
  const declaredAudio =
    declaredType.startsWith("audio/") ||
    declaredType === "application/ogg" ||
    (declaredType === "application/octet-stream" && audioExtension);
  if (!declaredAudio) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  let head = new Uint8Array();
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const { value } = await reader.read();
      if (value) head = value;
    } catch {
      head = new Uint8Array();
    }
    await reader.cancel().catch(() => undefined);
  }
  if (head.length && !sniffAudioBytes(head)) return false;
  // 占位提示音检查看的是完整文件大小：Range 响应的 Content-Length 是分片
  // 大小（如 1024），完整大小在 Content-Range 的 “/total” 里。
  const contentRangeTotal = Number(response.headers.get("content-range")?.split("/")[1] || 0);
  const fullLength =
    contentRangeTotal > 0 ? contentRangeTotal : Number(response.headers.get("content-length") || 0);
  if (fullLength > 0 && fullLength < 8_192) return false;
  return true;
}

function neteaseSongId(url: URL): string | null {
  if (!/\/song/.test(url.pathname)) return null;
  const fromQuery = url.searchParams.get("id");
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
  return url.pathname.match(/\/song\/(\d+)/)?.[1] ?? null;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'");
}

function readMetaTag(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const property = tag
      .match(/\b(?:property|name|itemprop)=["']([^"']*)["']/i)?.[1]
      ?.toLowerCase();
    if (property !== key.toLowerCase()) continue;
    const content = tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? "";
    if (content.trim()) return decodeHtmlEntities(content).trim();
  }
  return "";
}

// 平台页标题的尾部后缀（「- 单曲 - 网易云音乐」「- QQ音乐-千万正版…」等）。
const MUSIC_TITLE_TAIL_PATTERN =
  /^(单曲|歌曲|专辑|歌单|电台|主播|声音|网易云音乐|qq音乐|汽水音乐|抖音|音乐|高品?质|无损|hi-?res|flac|mp3|.*千万正版音乐.*|.*海量无损曲库.*|.*音乐平台.*|.*music.*)$/i;

/** 从分享页 HTML 提取标题/歌手/封面；各平台 og 标签或 <title> 尽力而为。 */
function parseMusicPageMeta(html: string): { title: string; artist: string; cover: string | null } {
  const rawTitle =
    readMetaTag(html, "og:title") ||
    readMetaTag(html, "title") ||
    decodeHtmlEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
  const cover = readMetaTag(html, "og:image") || readMetaTag(html, "twitter:image") || null;
  let artist = readMetaTag(html, "og:music:artist") || readMetaTag(html, "author");
  const parts = rawTitle
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length > 1 && MUSIC_TITLE_TAIL_PATTERN.test(parts[parts.length - 1] ?? ""))
    parts.pop();
  let title = parts[0] ?? "";
  if (!artist && parts.length >= 2) artist = parts[1] ?? "";
  return {
    title: title.slice(0, 200),
    artist: artist.slice(0, 200),
    cover: cover ? cover.slice(0, 2_048) : null,
  };
}

async function fetchMusicPageMeta(url: string, signal: AbortSignal) {
  const response = await musicGuardedFetch(url, {
    accept: "text/html,application/xhtml+xml",
    signal,
  });
  if (!response.ok) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MUSIC_PAGE_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const html = new TextDecoder("utf-8", { fatal: false }).decode(concatBytes(chunks));
  return parseMusicPageMeta(html);
}

function musicProxyPaths(streamUrl: string | null, coverUrl: string | null) {
  return {
    streamPath: streamUrl ? `/api/v1/music/stream?u=${encodeURIComponent(streamUrl)}` : null,
    coverPath: coverUrl ? `/api/v1/music/cover?u=${encodeURIComponent(coverUrl)}` : null,
  };
}

function musicResolveData(input: {
  source: MusicLinkSource;
  kind: "audio" | "link";
  title: string;
  artist: string;
  pageUrl: string;
  streamUrl: string | null;
  coverUrl: string | null;
}): MusicLinkResolveData {
  return {
    source: input.source,
    kind: input.kind,
    title: input.title.slice(0, 200),
    artist: input.artist.slice(0, 200),
    pageUrl: input.pageUrl.slice(0, 2_048),
    streamUrl: input.streamUrl,
    coverUrl: input.coverUrl,
    ...musicProxyPaths(input.streamUrl, input.coverUrl),
  };
}

export async function resolveMusicLink(input: {
  target: URL;
  source: MusicLinkSource;
  signal: AbortSignal;
}): Promise<MusicLinkResolveData> {
  const pageUrl = input.target.toString().slice(0, 2_048);
  if (input.source === "netease") {
    const songId = neteaseSongId(input.target);
    if (songId) {
      const streamUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
      const playable = await probeMusicAudio(streamUrl, input.signal).catch(() => false);
      if (playable) {
        const meta = await fetchMusicPageMeta(pageUrl, input.signal).catch(() => null);
        return musicResolveData({
          source: "netease",
          kind: "audio",
          title: meta?.title || `网易云音乐歌曲 ${songId}`,
          artist: meta?.artist ?? "",
          pageUrl,
          streamUrl,
          coverUrl: meta?.cover ?? null,
        });
      }
    }
    const meta = await fetchMusicPageMeta(pageUrl, input.signal).catch(() => null);
    return musicResolveData({
      source: "netease",
      kind: "link",
      title: meta?.title || "",
      artist: meta?.artist ?? "",
      pageUrl,
      streamUrl: null,
      coverUrl: meta?.cover ?? null,
    });
  }
  if (input.source === "qq" || input.source === "qishui") {
    // 平台播放链接有签名防盗链/DRM，只做外链卡片（元信息 + 跳转）。
    const meta = await fetchMusicPageMeta(pageUrl, input.signal).catch(() => null);
    return musicResolveData({
      source: input.source,
      kind: "link",
      title: meta?.title || "",
      artist: meta?.artist ?? "",
      pageUrl,
      streamUrl: null,
      coverUrl: meta?.cover ?? null,
    });
  }
  const probe = await probeMusicAudio(pageUrl, input.signal).catch(() => false);
  if (probe) {
    const fileName = decodeURIComponent(input.target.pathname.split("/").pop() || "").trim();
    return musicResolveData({
      source: "direct",
      kind: "audio",
      title: fileName || "音频直链",
      artist: "",
      pageUrl,
      streamUrl: pageUrl,
      coverUrl: null,
    });
  }
  const meta = await fetchMusicPageMeta(pageUrl, input.signal).catch(() => null);
  return musicResolveData({
    source: "link",
    kind: "link",
    title: meta?.title || input.target.hostname,
    artist: meta?.artist ?? "",
    pageUrl,
    streamUrl: null,
    coverUrl: meta?.cover ?? null,
  });
}
