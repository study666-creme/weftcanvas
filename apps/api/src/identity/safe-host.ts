import { lookup } from "node:dns/promises";
import net from "node:net";

const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const DNS_CACHE = new Map<string, { allowed: boolean; expiry: number }>();

/** `a00:1` 形式的最后 32 位（v4-mapped / NAT64 的十六进制写法）还原成点分 IPv4。 */
function embeddedIpv4FromHex(groups: string): string | null {
  const parts = groups.split(":");
  if (parts.length !== 2) return null;
  const high = Number.parseInt(parts[0] ?? "", 16);
  const low = Number.parseInt(parts[1] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  if (high < 0 || high > 0xffff || low < 0 || low > 0xffff) return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

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
    if (
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    )
      return true;
    if (lower.startsWith("::ffff:")) {
      const tail = lower.slice(7);
      if (net.isIPv4(tail)) return isPrivateIp(tail);
      // ::ffff:a00:1 这类十六进制写法同样内嵌 IPv4，不能只认点分形式。
      const embedded = embeddedIpv4FromHex(tail);
      if (embedded) return isPrivateIp(embedded);
      return true;
    }
    // 6to4（2002::/16）与 NAT64（64:ff9b::/96）把 IPv4 藏在里面，可能借道访问内网。
    if (lower.startsWith("2002:")) {
      const groups = lower.split(":");
      const embedded = embeddedIpv4FromHex(`${groups[1] ?? ""}:${groups[2] ?? ""}`);
      if (embedded) return isPrivateIp(embedded);
      return true;
    }
    if (lower.startsWith("64:ff9b:")) {
      const tail = lower.slice(8).replace(/^:+/, "");
      if (net.isIPv4(tail)) return isPrivateIp(tail);
      const embedded = embeddedIpv4FromHex(tail);
      if (embedded) return isPrivateIp(embedded);
      return true;
    }
    if (lower.startsWith("::")) return true;
    return false;
  }
  return false;
}

/**
 * SSRF guard for server-side fetches of user-supplied URLs. Returns a
 * human-readable block reason, or null when the target is safe to fetch.
 *
 * 这一层只做 URL 层面的判断（协议、主机名、以及"域名解析到内网"的预检）。
 * **真正兜底的是传输层**：`outbound/guarded-transport.ts` 让实际建连的地址必然
 * 经过同一套内网过滤，因为本函数的解析与 fetch 的解析是两次独立解析，单独依赖它
 * 会留下 DNS rebinding 窗口（解析答公网、连接答内网）。
 */
export async function isBlockedTargetUrl(value: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "目标地址不是合法 URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "仅支持 http/https 协议";

  // WHATWG URL 的 IPv6 主机名带方括号（`[::1]`），net.isIP 不认，必须先去括号，
  // 否则内网 IPv6 字面量会掉进"域名解析失败"的兜底分支而不是按地址判定。
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
