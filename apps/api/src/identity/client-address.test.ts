import { describe, expect, it } from "vitest";

import {
  clientIdentifierFromRequest,
  normalizeRemoteAddress,
  TrustedProxyList,
} from "./client-address.js";

const loopback = new TrustedProxyList("loopback");

function headersOf(entries: Record<string, string>) {
  return { get: (name: string) => entries[name.toLowerCase()] ?? null };
}

describe("TrustedProxyList", () => {
  it("understands the loopback shorthand and CIDR rules for v4/v6", () => {
    expect(loopback.check("127.0.0.1")).toBe(true);
    expect(loopback.check("127.9.9.9")).toBe(true);
    expect(loopback.check("::1")).toBe(true);
    expect(loopback.check("10.0.0.1")).toBe(false);

    const list = new TrustedProxyList("10.0.0.0/8, 2400:cb00::/32, 192.0.2.9");
    expect(list.check("10.5.5.5")).toBe(true);
    expect(list.check("11.0.0.1")).toBe(false);
    expect(list.check("2400:cb00:1::1")).toBe(true);
    expect(list.check("2606:4700::1111")).toBe(false);
    expect(list.check("192.0.2.9")).toBe(true);
    expect(list.check("192.0.2.10")).toBe(false);
  });

  it("collects unsupported tokens instead of silently trusting them", () => {
    const list = new TrustedProxyList("example.com, 10.0.0.0/40, 203.0.113.7");
    expect(list.ignored).toEqual(["example.com", "10.0.0.0/40"]);
    expect(list.check("203.0.113.7")).toBe(true);
  });

  it("never matches a non-IP string", () => {
    expect(loopback.check("not-an-ip")).toBe(false);
    expect(loopback.check("")).toBe(false);
  });
});

describe("normalizeRemoteAddress", () => {
  it("unwraps v4-mapped IPv6 into plain IPv4", () => {
    expect(normalizeRemoteAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeRemoteAddress(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(normalizeRemoteAddress("::1")).toBe("::1");
    expect(normalizeRemoteAddress(undefined)).toBeUndefined();
  });
});

describe("clientIdentifierFromRequest", () => {
  it("uses the socket address for direct access and ignores every forwarded header", () => {
    const identifier = clientIdentifierFromRequest({
      remoteAddress: "203.0.113.9",
      headers: headersOf({
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-for": "5.6.7.8",
        "x-real-ip": "9.9.9.9",
      }),
      trusted: loopback,
    });
    expect(identifier).toBe("203.0.113.9");
  });

  it("returns anonymous when there is no socket address", () => {
    expect(
      clientIdentifierFromRequest({
        headers: headersOf({ "cf-connecting-ip": "1.2.3.4" }),
        trusted: loopback,
      }),
    ).toBe("anonymous");
  });

  it("reads the first untrusted hop from the right of X-Forwarded-For", () => {
    // 客户端伪造的左侧条目影响不到结果：从右往左第一个不可信地址才是客户端。
    const identifier = clientIdentifierFromRequest({
      remoteAddress: "127.0.0.1",
      headers: headersOf({
        "x-forwarded-for": "1.2.3.4, 198.51.100.7, 127.0.0.1",
      }),
      trusted: loopback,
    });
    expect(identifier).toBe("198.51.100.7");
  });

  it("skips non-IP entries instead of trusting them", () => {
    const identifier = clientIdentifierFromRequest({
      remoteAddress: "127.0.0.1",
      headers: headersOf({ "x-forwarded-for": "not-an-ip, 198.51.100.8" }),
      trusted: loopback,
    });
    expect(identifier).toBe("198.51.100.8");
  });

  it("falls back to CF-Connecting-IP when the whole chain is trusted", () => {
    const identifier = clientIdentifierFromRequest({
      remoteAddress: "127.0.0.1",
      headers: headersOf({
        "x-forwarded-for": "127.0.0.1",
        "cf-connecting-ip": "198.51.100.9",
      }),
      trusted: loopback,
    });
    expect(identifier).toBe("198.51.100.9");
  });

  it("uses CF-Connecting-IP directly when there is no XFF header", () => {
    const identifier = clientIdentifierFromRequest({
      remoteAddress: "127.0.0.1",
      headers: headersOf({ "cf-connecting-ip": "198.51.100.10" }),
      trusted: loopback,
    });
    expect(identifier).toBe("198.51.100.10");
  });

  it("ignores a non-IP CF-Connecting-IP and falls back to the proxy itself", () => {
    const identifier = clientIdentifierFromRequest({
      remoteAddress: "127.0.0.1",
      headers: headersOf({ "cf-connecting-ip": "garbage" }),
      trusted: loopback,
    });
    expect(identifier).toBe("127.0.0.1");
  });

  it("never trusts X-Real-IP", () => {
    const identifier = clientIdentifierFromRequest({
      remoteAddress: "127.0.0.1",
      headers: headersOf({ "x-real-ip": "1.2.3.4" }),
      trusted: loopback,
    });
    expect(identifier).toBe("127.0.0.1");
  });

  it("normalizes v4-mapped remote addresses before matching", () => {
    const identifier = clientIdentifierFromRequest({
      remoteAddress: "::ffff:127.0.0.1",
      headers: headersOf({ "x-forwarded-for": "198.51.100.11" }),
      trusted: loopback,
    });
    expect(identifier).toBe("198.51.100.11");
  });
});
