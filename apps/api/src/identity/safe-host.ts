import { lookup } from "node:dns/promises";
import net from "node:net";

const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const DNS_CACHE = new Map<string, { allowed: boolean; expiry: number }>();

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const first = parts[0] ?? -1;
    const second = parts[1] ?? -1;
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 0) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 198 && (second === 18 || second === 19)) return true;
    if (first >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
    if (lower.startsWith("::")) return true;
    return false;
  }
  return false;
}

/**
 * SSRF guard for server-side fetches of user-supplied URLs. Returns a
 * human-readable block reason, or null when the target is safe to fetch.
 */
export async function isBlockedTargetUrl(value: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "目标地址不是合法 URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "仅支持 http/https 协议";

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return "目标地址缺少主机名";
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return "禁止访问本地主机名";
  }

  if (net.isIP(hostname)) {
    return isPrivateIp(hostname) ? "禁止访问内网地址" : null;
  }

  const cached = DNS_CACHE.get(hostname);
  if (cached) {
    if (cached.expiry < Date.now()) DNS_CACHE.delete(hostname);
    else return cached.allowed ? null : "域名解析到内网地址";
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    const allowed = addresses.length > 0 && addresses.every(({ address }) => !isPrivateIp(address));
    DNS_CACHE.set(hostname, { allowed, expiry: Date.now() + DNS_CACHE_TTL_MS });
    return allowed ? null : "域名解析到内网地址";
  } catch {
    return "域名解析失败";
  }
}

export function redactUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "(invalid URL)";
  }
}
