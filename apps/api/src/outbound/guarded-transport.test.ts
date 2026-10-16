import { createServer, type Server } from "node:http";
import type { LookupAddress } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetch as undiciFetch } from "undici";

import {
  BlockedTargetAddressError,
  createGuardedDispatcher,
  createGuardedLookup,
  filterResolvedAddresses,
} from "./guarded-transport.js";

const servers: Server[] = [];

async function listen(): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.end("INTERNAL");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, hits: () => hits };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const loopbackResolver = async (): Promise<LookupAddress[]> => [
  { address: "127.0.0.1", family: 4 },
];

/** undici 会把连接器错误包进 `TypeError: fetch failed`，这里顺着 cause 链找根因。 */
async function blockedRootCause(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      if (current instanceof BlockedTargetAddressError) return current;
      current = (current as { cause?: unknown }).cause;
    }
    return null;
  }
}

describe("filterResolvedAddresses", () => {
  it("keeps public addresses and drops private/special ones", () => {
    const kept = filterResolvedAddresses([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
      { address: "169.254.169.254", family: 4 },
      { address: "2606:4700::1111", family: 6 },
      { address: "::ffff:10.0.0.7", family: 6 },
      { address: "fd00::1", family: 6 },
    ]);
    expect(kept.map((entry) => entry.address)).toEqual(["93.184.216.34", "2606:4700::1111"]);
  });
});

describe("createGuardedLookup", () => {
  it("hands only validated addresses to the connection layer", async () => {
    const lookup = createGuardedLookup(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const result = await new Promise<{ error: Error | null; addresses: unknown }>((resolve) => {
      lookup("cdn.example.com", { all: true } as never, (error, addresses) =>
        resolve({ error, addresses }),
      );
    });
    expect(result.error).toBeNull();
    expect(result.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("fails the connection when every resolved address is internal", async () => {
    const lookup = createGuardedLookup(loopbackResolver);
    const error = await new Promise<Error | null>((resolve) => {
      lookup("rebind.example.com", { all: true } as never, (err) => resolve(err));
    });
    expect(error).toBeInstanceOf(BlockedTargetAddressError);
  });

  it("supports the single-address lookup shape", async () => {
    const lookup = createGuardedLookup(async () => [{ address: "9.9.9.9", family: 4 }]);
    const result = await new Promise<{ address: unknown; family: unknown }>((resolve) => {
      lookup("dns.example.com", {} as never, (_error, address, family) =>
        resolve({ address, family }),
      );
    });
    expect(result).toEqual({ address: "9.9.9.9", family: 4 });
  });
});

describe("createGuardedDispatcher (DNS rebinding)", () => {
  it("refuses to connect to an address the resolver reports as internal", async () => {
    const { port, hits } = await listen();
    const dispatcher = createGuardedDispatcher({ resolve: loopbackResolver, timeoutMs: 2_000 });
    // 攻击者控制的域名在"校验时"答公网、"连接时"答回环——受控连接器必须在建连前拒绝。
    const cause = await blockedRootCause(
      undiciFetch(`http://rebind.example.com:${port}/`, { dispatcher }),
    );
    expect(cause).toBeInstanceOf(BlockedTargetAddressError);
    expect(hits()).toBe(0);
    await dispatcher.close();
  });

  it("refuses internal targets given as an IP literal", async () => {
    const { port, hits } = await listen();
    const dispatcher = createGuardedDispatcher({ timeoutMs: 2_000 });
    expect(
      await blockedRootCause(undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher })),
    ).toBeInstanceOf(BlockedTargetAddressError);
    expect(
      await blockedRootCause(undiciFetch(`http://[::ffff:10.0.0.7]:${port}/`, { dispatcher })),
    ).toBeInstanceOf(BlockedTargetAddressError);
    expect(hits()).toBe(0);
    await dispatcher.close();
  });

  it("allows public targets through the guarded transport", async () => {
    // 只在本机显式允许联网时运行（CI/人工验证用），避免默认测试踩公网。
    if (process.env.CANVAS_TEST_PUBLIC_NETWORK !== "1") {
      expect(process.env.CANVAS_TEST_PUBLIC_NETWORK).not.toBe("1");
      return;
    }
    const dispatcher = createGuardedDispatcher({ timeoutMs: 10_000 });
    const response = await undiciFetch("https://example.com/", { dispatcher });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    await dispatcher.close();
  });
});
