import type { CanvasImportProvider } from "@weftcanvas/contracts";

/**
 * 三个来源的标识解析与素材域名白名单。
 *
 * 标识一律从用户粘贴的任意文本里解析出**受约束的**形式：链接要落在对方自己的
 * 主机上，UUID/分享 ID 要匹配固定字符集。素材域名白名单是代拉的唯一放行依据，
 * 不放行按前缀猜的近似域名——同名域会把外部 URL 带进服务端出网链路。
 */
export const LIBTV_DETAIL_URL = "https://api.liblib.tv/api/canvas/project/detail";
export const LIBTV_PROJECT_UUID_PATTERN = /^[a-f0-9]{32}$/i;
export const LIBTV_HOSTS = ["liblib.tv", "www.liblib.tv", "liblib.art", "www.liblib.art"] as const;
/** 素材域名：LibTV 的生成资源都挂在 liblib.art 的 OSS 域上。 */
export const LIBTV_MEDIA_HOST_SUFFIXES = [".liblib.art", ".liblib.tv"] as const;

export const TAPNOW_SHARE_HOST = "app.tapnow.media";
export const TAPNOW_SHARE_URL_PREFIX = "https://app.tapnow.media/api/conversation/v1/canvas-share/";
export const TAPNOW_SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 素材域名：已核验的官方文件域。 */
export const TAPNOW_MEDIA_HOST_SUFFIXES = [".tapnow.media"] as const;

export const UPDREAM_SHARE_URL_PREFIX = "https://www.updream.cn/api/share/";
export const UPDREAM_SHARE_CODE_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
/** 分享口令：`share://<code>`，口令本体只可能是 base62 类字符（解析时再放宽到 `:`）。 */
export const UPDREAM_SHARE_URI_PATTERN = /share:\/\/([A-Za-z0-9:_-]{1,128})/i;
export const UPDREAM_HOSTS = ["updream.cn", "www.updream.cn"] as const;
/** 素材域名：UpDream 的媒体落在 B 站 CDN 域上。 */
export const UPDREAM_MEDIA_HOST_SUFFIXES = [
  ".hdslb.com",
  ".bilivideo.com",
  ".bilibili.com",
] as const;

export const canvasImportMediaHostSuffixes: Record<CanvasImportProvider, readonly string[]> = {
  libtv: LIBTV_MEDIA_HOST_SUFFIXES,
  tapnow: TAPNOW_MEDIA_HOST_SUFFIXES,
  updream: UPDREAM_MEDIA_HOST_SUFFIXES,
};

/** LibTV 画布标识：32 位十六进制 UUID，可以直接粘，也可以粘画布/分享链接。 */
export function parseLibTVReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let candidate = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return "";
    }
    // 只认对方自己的主机：贴了别家链接不该被当成本平台的画布。
    if (!isAllowedHost(parsed.hostname, LIBTV_HOSTS)) return "";
    candidate =
      parsed.searchParams.get("projectId") ??
      parsed.searchParams.get("projectUuid") ??
      parsed.searchParams.get("uuid") ??
      parsed.pathname.split("/").filter(Boolean).at(-1) ??
      "";
  }
  return LIBTV_PROJECT_UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : "";
}

/** TapNow 分享标识：分享链接（/tapflow/view/<id>）或裸分享 ID。 */
export function parseTapNowReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let candidate = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return "";
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (host !== TAPNOW_SHARE_HOST) return "";
    if (!/^\/tapflow\/view\/?[^/]*\/?$/.test(parsed.pathname)) return "";
    candidate = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
  }
  return TAPNOW_SHARE_ID_PATTERN.test(candidate) ? candidate : "";
}

/**
 * UpDream 分享口令：`share://<code>`（可能被整段复制，里面还带说明文字），
 * 也接受直接粘贴口令本体。没有可浏览的分享链接——口令只在对方应用内消费。
 */
export function parseUpDreamReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const matched = UPDREAM_SHARE_URI_PATTERN.exec(trimmed);
  const candidate = (matched?.[1] ?? trimmed).trim();
  return UPDREAM_SHARE_CODE_PATTERN.test(candidate) ? candidate : "";
}

export function parseCanvasImportReference(provider: CanvasImportProvider, value: string): string {
  if (provider === "libtv") return parseLibTVReference(value);
  if (provider === "tapnow") return parseTapNowReference(value);
  return parseUpDreamReference(value);
}

/** 素材代拉放行：域名必须精确等于白名单域名，或是其后缀子域。 */
export function isAllowedMediaHost(provider: CanvasImportProvider, hostname: string): boolean {
  return isAllowedHost(hostname, canvasImportMediaHostSuffixes[provider]);
}

function isAllowedHost(hostname: string, rules: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return rules.some((rule) => (rule.startsWith(".") ? host.endsWith(rule) : host === rule));
}
