import { describe, expect, it } from "vitest";

import { isBlockedTargetUrl, isPrivateIp, redactUrl } from "./safe-host.js";

describe("isPrivateIp", () => {
  it("blocks IPv4 private, loopback, link-local and reserved ranges", () => {
    for (const ip of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "127.9.9.9",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1",
      "11.0.0.1",
      "93.184.216.34",
      "203.0.113.7",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("blocks IPv6 loopback, unique-local, link-local and v4-mapped forms", () => {
    for (const ip of [
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.7",
      "::ffff:a00:1", // 十六进制写法的 10.0.0.1
      "2002:7f00:1::", // 6to4 内嵌 127.0.0.1
      "64:ff9b::7f00:1", // NAT64 内嵌 127.0.0.1
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    for (const ip of ["2606:4700::1111", "2001:4860:4860::8888"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("does not treat a hostname as an IP", () => {
    expect(isPrivateIp("example.com")).toBe(false);
  });
});

describe("isBlockedTargetUrl", () => {
  it("rejects non-http protocols and malformed URLs", async () => {
    expect(await isBlockedTargetUrl("file:///etc/passwd")).toContain("http/https");
    expect(await isBlockedTargetUrl("ftp://example.com/x")).toContain("http/https");
    expect(await isBlockedTargetUrl("not a url")).toContain("合法 URL");
  });

  it("rejects local hostnames", async () => {
    expect(await isBlockedTargetUrl("http://localhost:8787/x")).toContain("本地主机名");
    expect(await isBlockedTargetUrl("http://api.localhost/x")).toContain("本地主机名");
    expect(await isBlockedTargetUrl("http://printer.local/x")).toContain("本地主机名");
  });

  it("rejects private and special IP literals, including IPv6 forms", async () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://10.1.2.3/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/x",
      "http://[::ffff:10.0.0.7]/x",
      "http://[2002:7f00:1::]/x",
      "http://[64:ff9b::7f00:1]/x",
      "http://0x7f000001/x",
      "http://2130706433/x",
      "http://127.1/x",
    ]) {
      expect(await isBlockedTargetUrl(url), url).toContain("内网");
    }
  });

  it("accepts public IP literals without needing DNS", async () => {
    expect(await isBlockedTargetUrl("https://93.184.216.34/a.png")).toBeNull();
    expect(await isBlockedTargetUrl("https://[2606:4700::1111]/a.png")).toBeNull();
  });

  it("redacts credentials and query strings for logs", () => {
    expect(redactUrl("https://user:pass@example.com/a?token=secret#frag")).toBe(
      "https://example.com/a",
    );
    expect(redactUrl("not a url")).toBe("(invalid URL)");
  });
});
