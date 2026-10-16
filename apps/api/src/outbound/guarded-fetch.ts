import { isBlockedTargetUrl } from "../identity/safe-host.js";

/**
 * 手动跟随重定向的守卫式抓取：每一跳重新过 SSRF 守卫与协议检查。
 * `redirect:"follow"` 只校验初始 URL，302 到 169.254.169.254 的绕过就发生在这。
 *
 * 调用方（音乐代拉、第三方画布素材代拉）各自把失败原因翻成自己的错误类型与文案，
 * 这里只负责"每一跳都重新校验"这一条不变量。
 */
export const MEDIA_PROXY_MAX_REDIRECT_HOPS = 5;

export type GuardedFetchFailure =
  | "blocked"
  | "host-not-allowed"
  | "missing-location"
  | "invalid-redirect"
  | "redirect-protocol"
  | "too-many-redirects";

export type GuardedFetchOptions = {
  accept: string;
  signal: AbortSignal;
  /** 透传 Range：视频/音频拖动进度条依赖 206。 */
  range?: string;
  userAgent: string;
  maxRedirects?: number;
  fetch?: typeof globalThis.fetch;
  /**
   * 额外的按跳主机校验（例如"只允许对方 CDN 的域名"）。缺省只做 SSRF 守卫：
   * 首跳由调用方自己校验过了，但重定向会换主机，所以有域名白名单的调用方必须
   * 传这一项，否则 302 到别家主机就能绕过白名单。
   */
  allowHost?: (hostname: string) => boolean;
  fail: (failure: GuardedFetchFailure) => Error;
};

export async function guardedFetch(url: string, options: GuardedFetchOptions): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? MEDIA_PROXY_MAX_REDIRECT_HOPS;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const blocked = await isBlockedTargetUrl(current);
    if (blocked) throw options.fail("blocked");
    if (options.allowHost && !options.allowHost(new URL(current).hostname)) {
      throw options.fail("host-not-allowed");
    }
    const attempt = await doFetch(current, {
      headers: {
        Accept: options.accept,
        "User-Agent": options.userAgent,
        ...(options.range ? { Range: options.range } : {}),
      },
      redirect: "manual",
      signal: options.signal,
    });
    if (![301, 302, 303, 307, 308].includes(attempt.status)) return attempt;
    await attempt.body?.cancel().catch(() => undefined);
    const location = attempt.headers.get("location");
    if (!location) throw options.fail("missing-location");
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw options.fail("invalid-redirect");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw options.fail("redirect-protocol");
    }
    current = next.toString();
  }
  throw options.fail("too-many-redirects");
}
