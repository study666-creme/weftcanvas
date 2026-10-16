import { lookup as defaultLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector } from "undici";

import { isPrivateIp } from "../identity/safe-host.js";

/**
 * 受控出网传输：把 SSRF 校验绑到**真正用于建连的那次解析**上。
 *
 * 为什么需要这一层：`isBlockedTargetUrl` 先解析域名、判断内网，之后由 fetch 自己
 * 再解析一次——两次解析之间就是 DNS rebinding 的窗口（第一次答公网、第二次答
 * 169.254.169.254），缓存还会把这个窗口拉长到 TTL。这里换成把守卫装进 undici 的
 * 连接器：域名解析的结果先过滤掉内网/特殊地址，只有过滤后的地址会被交给
 * `net.connect`/`tls.connect`，因此"校验目标"与"连接目标"必然是同一批地址。
 *
 * TLS 语义不受影响：连接仍按主机名建（`servername`/SNI 与证书校验都用主机名），
 * 我们只替换 DNS 解析这一步。
 */

export const GUARDED_CONNECT_TIMEOUT_MS = 10_000;

export class BlockedTargetAddressError extends Error {
  constructor(
    readonly hostname: string,
    message: string,
  ) {
    super(message);
    this.name = "BlockedTargetAddressError";
  }
}

/** 域名 → 地址列表。默认走系统解析器；测试可注入以模拟 rebinding。 */
export type AddressResolver = (
  hostname: string,
  options: LookupOptions,
) => Promise<LookupAddress[]>;

const defaultResolver: AddressResolver = (hostname, options) =>
  new Promise((resolve, reject) => {
    defaultLookup(
      hostname,
      { family: options.family ?? 0, hints: options.hints ?? 0, all: true },
      (error, addresses) => {
        if (error) reject(error);
        else resolve((addresses as LookupAddress[]) ?? []);
      },
    );
  });

/** 丢掉内网/特殊地址；空结果表示这次解析没有任何可以连接的合法目标。 */
export function filterResolvedAddresses(addresses: LookupAddress[]): LookupAddress[] {
  return addresses.filter((entry) => !isPrivateIp(entry.address));
}

/**
 * 守卫式 lookup：解析 → 过滤 → 只把剩下的地址交给连接层。
 * 全部被过滤掉时直接让连接失败，绝不回退到未校验的地址。
 */
export function createGuardedLookup(resolve: AddressResolver = defaultResolver): LookupFunction {
  return (hostname, options, callback) => {
    const fail = (error: unknown) =>
      callback(
        (error instanceof Error ? error : new Error(String(error))) as NodeJS.ErrnoException,
        [],
      );
    resolve(hostname, options).then(
      (addresses) => {
        const safe = filterResolvedAddresses(addresses);
        if (!safe.length) {
          fail(
            new BlockedTargetAddressError(hostname, `解析结果全部是内网或特殊地址：${hostname}`),
          );
          return;
        }
        if (options?.all) {
          callback(null, safe);
          return;
        }
        const first = safe[0]!;
        callback(null, first.address, first.family);
      },
      (error: unknown) => fail(error),
    );
  };
}

export type GuardedConnectorOptions = {
  resolve?: AddressResolver;
  timeoutMs?: number;
};

/**
 * 守卫式连接器。字面量 IP（`http://169.254.169.254/`）不走 DNS，Node 直接建连、
 * lookup 根本不会被调用，所以这里补一道同等的字面量检查——两道合起来才是完整覆盖。
 */
export function createGuardedConnector(options: GuardedConnectorOptions = {}) {
  const base = buildConnector({
    lookup: createGuardedLookup(options.resolve),
    timeout: options.timeoutMs ?? GUARDED_CONNECT_TIMEOUT_MS,
  });
  return (
    connectOptions: Parameters<ReturnType<typeof buildConnector>>[0],
    callback: Parameters<ReturnType<typeof buildConnector>>[1],
  ) => {
    // undici 传进来的是去括号的主机名，这里仍做一次归一（防御性，不依赖上游形状）。
    const hostname = (connectOptions.hostname || "").replace(/^\[|\]$/g, "");
    if (hostname && isIP(hostname) !== 0 && isPrivateIp(hostname)) {
      callback(
        new BlockedTargetAddressError(hostname, `禁止连接内网或特殊地址：${hostname}`),
        null,
      );
      return;
    }
    base(connectOptions, callback);
  };
}

let sharedDispatcher: Agent | null = null;

/** 进程级共享的受控 dispatcher（连接池按 origin 复用，跨主机不会串）。 */
export function guardedDispatcher(): Agent {
  sharedDispatcher ??= new Agent({ connect: createGuardedConnector() });
  return sharedDispatcher;
}

/** 测试用：按需造一个独立 dispatcher（不污染进程共享实例）。 */
export function createGuardedDispatcher(options: GuardedConnectorOptions = {}): Agent {
  return new Agent({ connect: createGuardedConnector(options) });
}
