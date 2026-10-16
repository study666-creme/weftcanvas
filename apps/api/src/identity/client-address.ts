import net from "node:net";

/**
 * 可信代理边界：决定"什么时候才允许读请求头里的客户端 IP"。
 *
 * 原则：**直连对端是可信代理时才读它转发的头**；直连访问一律用 socket 上的
 * 真实对端地址。所有头里的值都必须是合法 IP 才会被采用——随便一段字符串既不能
 * 冒充客户端，也不该成为限流桶的键。
 *
 * 取值顺序（对端已确认可信之后）：
 * 1. `X-Forwarded-For` 从右往左数，**第一个不可信的地址**就是客户端。这一条对
 *    Nginx（追加真实对端）和 Cloudflare（追加真实客户端）都成立，客户端伪造的
 *    左侧条目影响不到结果；
 * 2. 头里只有 `CF-Connecting-IP`（Cloudflare 会**覆盖**这个头，左侧伪造无效）时用它；
 * 3. 都没有就退回代理自己的地址（全部用户共用一个桶，总好过采信伪造头）。
 *
 * `X-Real-IP` 特意不采信：我们的 nginx 不设置它，客户端可以随便带，而它没有任何
 * "由可信方追加"的结构保证。
 */

export const DEFAULT_TRUSTED_PROXY_SPEC = "loopback";

export class TrustedProxyList {
  private readonly blockList = new net.BlockList();
  private entries = 0;
  /** 解析失败被忽略的原始片段，给运维看配置有没有写对。 */
  readonly ignored: string[] = [];

  constructor(readonly source: string) {
    for (const token of source.split(/[\s,]+/)) {
      const value = token.trim().toLowerCase();
      if (!value) continue;
      if (value === "loopback") {
        this.blockList.addSubnet("127.0.0.0", 8, "ipv4");
        this.blockList.addAddress("::1", "ipv6");
        this.entries += 2;
        continue;
      }
      const subnet = value.split("/");
      if (subnet.length === 2) {
        const [network, bitsText] = subnet as [string, string];
        const bits = Number.parseInt(bitsText, 10);
        const family = net.isIP(network);
        if (
          family &&
          Number.isSafeInteger(bits) &&
          bits >= 0 &&
          bits <= (family === 4 ? 32 : 128)
        ) {
          this.blockList.addSubnet(network, bits, family === 4 ? "ipv4" : "ipv6");
          this.entries += 1;
          continue;
        }
        this.ignored.push(token);
        continue;
      }
      const family = net.isIP(value);
      if (family) {
        this.blockList.addAddress(value, family === 4 ? "ipv4" : "ipv6");
        this.entries += 1;
        continue;
      }
      this.ignored.push(token);
    }
  }

  get size() {
    return this.entries;
  }

  check(address: string): boolean {
    const family = net.isIP(address);
    if (!family) return false;
    try {
      return this.blockList.check(address, family === 4 ? "ipv4" : "ipv6");
    } catch {
      return false;
    }
  }
}

/** Node 有时把 IPv4 报成 v4-mapped IPv6（`::ffff:127.0.0.1`），归一成纯 IPv4 好比对子网。 */
export function normalizeRemoteAddress(address: string | undefined): string | undefined {
  const value = address?.trim();
  if (!value) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) return mapped[1];
  return value;
}

function firstValidIp(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && net.isIP(normalizeRemoteAddress(trimmed) ?? trimmed)) {
      return normalizeRemoteAddress(trimmed)!;
    }
  }
  return undefined;
}

export type ClientAddressInput = {
  /** socket 上的直连对端；测试/无 socket 环境下可能拿不到。 */
  remoteAddress?: string | undefined;
  headers: { get(name: string): string | undefined | null };
  trusted: TrustedProxyList;
};

/**
 * 求这个请求在限流/风控意义上的"客户端标识"。
 * 返回的一定是合法 IP 字符串或 "anonymous"——不会把头里的任意文本当标识。
 */
export function clientIdentifierFromRequest(input: ClientAddressInput): string {
  const remote = normalizeRemoteAddress(input.remoteAddress);
  if (!remote || !net.isIP(remote)) return "anonymous";
  if (!input.trusted.check(remote)) return remote; // 直连访问：转发头一律不采信
  const chainValue = input.headers.get("x-forwarded-for");
  const chain = chainValue
    ? chainValue
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  // 从最右（离我们最近的代理亲手追加的那一条）往左找第一个不可信地址。
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = firstValidIp(chain[index]);
    if (!candidate) continue;
    if (input.trusted.check(candidate)) continue;
    return candidate;
  }
  const cloudflare = firstValidIp(input.headers.get("cf-connecting-ip"));
  if (cloudflare) return cloudflare;
  return remote;
}
