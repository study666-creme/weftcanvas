import { describe, expect, it } from "vitest";

import { createGuardedDispatcher } from "./guarded-transport.js";
import { guardedFetch, type GuardedFetchFailure } from "./guarded-fetch.js";

type Call = { url: string; init: RequestInit & { dispatcher?: unknown } };

function scriptedFetch(responses: Array<Response | (() => Response)>) {
  const calls: Call[] = [];
  let index = 0;
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: (init ?? {}) as Call["init"] });
    const next = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return typeof next === "function" ? next() : (next as Response);
  };
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

const fail = (failure: GuardedFetchFailure) => new Error(failure);
const baseOptions = {
  accept: "audio/*",
  signal: new AbortController().signal,
  userAgent: "weftcanvas-test",
  fail,
};

describe("guardedFetch", () => {
  it("returns the first non-redirect response", async () => {
    const { impl, calls } = scriptedFetch([new Response("ok", { status: 200 })]);
    const response = await guardedFetch("https://93.184.216.34/a.mp3", {
      ...baseOptions,
      fetch: impl,
    });
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://93.184.216.34/a.mp3"]);
  });

  it("re-validates every hop and blocks a redirect into an internal address", async () => {
    const { impl, calls } = scriptedFetch([
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    ]);
    await expect(
      guardedFetch("https://93.184.216.34/a.mp3", { ...baseOptions, fetch: impl }),
    ).rejects.toThrow("blocked");
    expect(calls).toHaveLength(1);
  });

  it("blocks a redirect into a private IPv6 literal", async () => {
    const { impl } = scriptedFetch([
      new Response(null, { status: 307, headers: { location: "http://[::ffff:10.0.0.7]/x" } }),
    ]);
    await expect(
      guardedFetch("https://93.184.216.34/a.mp3", { ...baseOptions, fetch: impl }),
    ).rejects.toThrow("blocked");
  });

  it("follows a legitimate CDN redirect and carries Range to the next hop", async () => {
    const { impl, calls } = scriptedFetch([
      new Response(null, {
        status: 302,
        headers: { location: "https://203.0.113.7/b.mp3" },
      }),
      new Response("body", { status: 206 }),
    ]);
    const response = await guardedFetch("https://93.184.216.34/a.mp3", {
      ...baseOptions,
      range: "bytes=0-1023",
      fetch: impl,
    });
    expect(response.status).toBe(206);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.headers).toMatchObject({ Range: "bytes=0-1023", Accept: "audio/*" });
    expect(calls[1]?.init.headers).toMatchObject({ Range: "bytes=0-1023" });
  });

  it("enforces a per-hop host allowlist across redirects", async () => {
    const { impl, calls } = scriptedFetch([
      new Response(null, { status: 302, headers: { location: "https://93.184.216.34/b.mp3" } }),
      new Response("body", { status: 200 }),
    ]);
    await expect(
      guardedFetch("https://93.184.216.34/a.mp3", {
        ...baseOptions,
        allowHost: (hostname) => hostname === "93.184.216.34" && calls.length === 0,
        fetch: impl,
      }),
    ).rejects.toThrow("host-not-allowed");
  });

  it("reports missing location, invalid redirect and non-http redirects", async () => {
    const missing = scriptedFetch([new Response(null, { status: 302 })]);
    await expect(
      guardedFetch("https://93.184.216.34/a.mp3", { ...baseOptions, fetch: missing.impl }),
    ).rejects.toThrow("missing-location");

    const invalid = scriptedFetch([
      new Response(null, { status: 302, headers: { location: "http://[::1" } }),
    ]);
    await expect(
      guardedFetch("https://93.184.216.34/a.mp3", { ...baseOptions, fetch: invalid.impl }),
    ).rejects.toThrow("invalid-redirect");

    const protocol = scriptedFetch([
      new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }),
    ]);
    await expect(
      guardedFetch("https://93.184.216.34/a.mp3", { ...baseOptions, fetch: protocol.impl }),
    ).rejects.toThrow("redirect-protocol");
  });

  it("stops after the redirect budget", async () => {
    const { impl } = scriptedFetch([
      new Response(null, { status: 302, headers: { location: "https://93.184.216.34/next" } }),
    ]);
    await expect(
      guardedFetch("https://93.184.216.34/a.mp3", {
        ...baseOptions,
        maxRedirects: 2,
        fetch: impl,
      }),
    ).rejects.toThrow("too-many-redirects");
  });

  it("sends every hop through the guarded transport by default", async () => {
    const { impl, calls } = scriptedFetch([new Response("ok", { status: 200 })]);
    await guardedFetch("https://93.184.216.34/a.mp3", { ...baseOptions, fetch: impl });
    // 未显式注入时，请求必须带上受控 dispatcher（而不是裸 fetch）。
    expect(calls[0]?.init.dispatcher).toBeDefined();
  });

  it("honors an explicitly injected dispatcher", async () => {
    const { impl, calls } = scriptedFetch([new Response("ok", { status: 200 })]);
    const dispatcher = createGuardedDispatcher({ timeoutMs: 1_000 });
    try {
      await guardedFetch("https://93.184.216.34/a.mp3", {
        ...baseOptions,
        fetch: impl,
        dispatcher,
      });
      expect(calls[0]?.init.dispatcher).toBe(dispatcher);
    } finally {
      await dispatcher.close();
    }
  });
});
