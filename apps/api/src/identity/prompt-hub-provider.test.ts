import { describe, expect, it } from "vitest";

import { PromptHubProvider } from "./prompt-hub-provider.js";
import type { WalletLedgerItem } from "../wallet/provider.js";

const NOW = Date.parse("2026-08-10T08:00:00.000Z");

type MockResponse = { status: number; body: unknown };
type MockRoute = (url: URL, init: RequestInit | undefined) => MockResponse;

const AUTH_TOKEN = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "creator@example.com",
    created_at: "2026-07-15T00:00:00.000Z",
    user_metadata: {},
  },
};

function createProvider(route: MockRoute) {
  return new PromptHubProvider({
    apiBaseUrl: "https://upstream.example.com",
    authBaseUrl: "https://auth.example.com",
    anonKey: "anon-key",
    sessionSecret: "k".repeat(64),
    siteUrl: "https://canvas.example.com",
    now: () => NOW,
    loginRetryDelayMs: 0,
    fetch: async (input, init) => {
      const { status, body } = route(new URL(String(input)), init);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

function ledgerRoute(
  ledgerResponse: MockResponse,
  observed: { limits: number[] } = { limits: [] },
): MockRoute {
  return (url, _init) => {
    if (url.pathname === "/auth/v1/token") return { status: 200, body: AUTH_TOKEN };
    if (url.pathname === "/api/v1/me/ledger") {
      const limit = Number(url.searchParams.get("limit"));
      observed.limits.push(Number.isFinite(limit) ? limit : Number.NaN);
      return ledgerResponse;
    }
    return { status: 404, body: { ok: false, error: { code: "NOT_FOUND", message: "unexpected route" } } };
  };
}

function item(overrides: Record<string, unknown> = {}): WalletLedgerItem {
  return {
    id: "ledger-1",
    delta: -400,
    balanceAfter: 1200,
    reason: "reservation",
    reasonLabel: "生成预留",
    refId: "job-1",
    meta: null,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  } as WalletLedgerItem;
}

async function sessionAndProvider(route: MockRoute) {
  const provider = createProvider(route);
  const issued = await provider.login({ email: "creator@example.com", password: "private-password" });
  return { provider, token: issued.token };
}

describe("PromptHub identity login", () => {
  it("retries two transient 5xx responses before issuing the session", async () => {
    let calls = 0;
    const provider = createProvider(() => {
      calls += 1;
      return calls <= 2
        ? { status: 503, body: { message: "temporarily unavailable" } }
        : { status: 200, body: AUTH_TOKEN };
    });

    await expect(provider.login({ email: "creator@example.com", password: "private-password" }))
      .resolves.toMatchObject({ user: { id: AUTH_TOKEN.user.id, email: AUTH_TOKEN.user.email } });
    expect(calls).toBe(3);
  });

  it("retries two network failures before issuing the session", async () => {
    let calls = 0;
    const provider = createProvider(() => {
      calls += 1;
      if (calls <= 2) throw new TypeError("network unavailable");
      return { status: 200, body: AUTH_TOKEN };
    });

    await expect(provider.login({ email: "creator@example.com", password: "private-password" }))
      .resolves.toMatchObject({ user: { id: AUTH_TOKEN.user.id } });
    expect(calls).toBe(3);
  });

  it("gives up after three consecutive transient failures", async () => {
    let calls = 0;
    const provider = createProvider(() => {
      calls += 1;
      throw new TypeError("network unavailable");
    });

    await expect(provider.login({ email: "creator@example.com", password: "private-password" }))
      .rejects.toMatchObject({ code: "IDENTITY_PROVIDER_UNAVAILABLE", status: 503 });
    expect(calls).toBe(3);
  });

  it.each([400, 401, 429])("does not retry a non-transient %s response", async (status) => {
    let calls = 0;
    const provider = createProvider(() => {
      calls += 1;
      return { status, body: { message: "request rejected" } };
    });

    await expect(provider.login({ email: "creator@example.com", password: "private-password" }))
      .rejects.toMatchObject({
        code: status === 429 ? "IDENTITY_RATE_LIMITED" : "INVALID_CREDENTIALS",
        status: status === 429 ? 429 : 401,
      });
    expect(calls).toBe(1);
  });

  it("keeps all timeout attempts inside the configured login budget", async () => {
    let calls = 0;
    const provider = new PromptHubProvider({
      apiBaseUrl: "https://upstream.example.com",
      authBaseUrl: "https://auth.example.com",
      anonKey: "anon-key",
      sessionSecret: "k".repeat(64),
      siteUrl: "https://canvas.example.com",
      now: () => NOW,
      requestTimeoutMs: 40,
      loginRetryDelayMs: 0,
      fetch: async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    });

    await expect(provider.login({ email: "creator@example.com", password: "private-password" }))
      .rejects.toMatchObject({ code: "IDENTITY_PROVIDER_UNAVAILABLE", status: 503 });
    expect(calls).toBe(3);
  });
});

describe("PromptHub wallet ledger adapter", () => {
  it("reads the current data-array ledger shape into canonical items", async () => {
    const observed: { limits: number[] } = { limits: [] };
    const { provider, token } = await sessionAndProvider(ledgerRoute({
      status: 200,
      body: {
        ok: true,
        data: [
          { ...item(), user_id: "private-user", access_token: "secret" },
          item({ id: "ledger-2", delta: -360, balanceAfter: 840, reason: "settlement", reasonLabel: "生成结算" }),
          item({ id: "ledger-3", delta: 360, balanceAfter: 1200, reason: "refund", reasonLabel: "生成退款" }),
        ],
      },
    }, observed));
    const result = await provider.getLedger(token, 5);
    expect(result.data).toEqual([
      item(),
      item({ id: "ledger-2", delta: -360, balanceAfter: 840, reason: "settlement", reasonLabel: "生成结算" }),
      item({ id: "ledger-3", delta: 360, balanceAfter: 1200, reason: "refund", reasonLabel: "生成退款" }),
    ]);
    expect(observed.limits).toEqual([5]);
  });

  it("still reads the old data.items ledger shape", async () => {
    const { provider, token } = await sessionAndProvider(ledgerRoute({
      status: 200,
      body: { ok: true, data: { items: [item()] } },
    }));
    const result = await provider.getLedger(token, 5);
    expect(result.data).toEqual([item()]);
  });

  it("surfaces an HTTP-200 upstream error envelope as the product error, not WALLET_INVALID_RESPONSE", async () => {
    const { provider, token } = await sessionAndProvider(ledgerRoute({
      status: 200,
      body: { ok: false, error: { code: "LEDGER_DENIED", message: "no permission" } },
    }));
    await expect(provider.getLedger(token, 5)).rejects.toMatchObject({
      code: "LEDGER_DENIED",
      status: 500,
    });
  });

  it("surfaces a non-2xx upstream error as the product error", async () => {
    const { provider, token } = await sessionAndProvider(ledgerRoute({
      status: 400,
      body: { ok: false, error: { code: "BAD_LEDGER_REQUEST", message: "bad limit" } },
    }));
    await expect(provider.getLedger(token, 5)).rejects.toMatchObject({
      code: "BAD_LEDGER_REQUEST",
      status: 400,
    });
  });

  it("rejects malformed ledger payloads with WALLET_INVALID_RESPONSE", async () => {
    const { provider, token } = await sessionAndProvider(ledgerRoute({
      status: 200,
      body: { ok: true, data: { items: [{ id: "incomplete" }] } },
    }));
    await expect(provider.getLedger(token, 5)).rejects.toMatchObject({
      code: "WALLET_INVALID_RESPONSE",
      status: 503,
    });
  });

  it("rejects oversized ledger lists with WALLET_INVALID_RESPONSE", async () => {
    const { provider, token } = await sessionAndProvider(ledgerRoute({
      status: 200,
      body: {
        ok: true,
        data: Array.from({ length: 51 }, (_, index) => item({ id: `ledger-${index}` })),
      },
    }));
    await expect(provider.getLedger(token, 5)).rejects.toMatchObject({
      code: "WALLET_INVALID_RESPONSE",
      status: 503,
    });
  });

  it("rejects a successful envelope whose data is neither an array nor a list object", async () => {
    const { provider, token } = await sessionAndProvider(ledgerRoute({
      status: 200,
      body: { ok: true, data: { records: [item()] } },
    }));
    await expect(provider.getLedger(token, 5)).rejects.toMatchObject({
      code: "WALLET_INVALID_RESPONSE",
      status: 503,
    });
  });
});

function creditRoute(
  response: MockResponse,
  observed: { bodies: Array<Record<string, unknown>> } = { bodies: [] },
): MockRoute {
  return (url, init) => {
    if (url.pathname === "/auth/v1/token") return { status: 200, body: AUTH_TOKEN };
    if (url.pathname === "/api/v1/wallet/consume" || url.pathname === "/api/v1/wallet/refund") {
      observed.bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return response;
    }
    return { status: 404, body: { ok: false, error: { code: "NOT_FOUND", message: "unexpected route" } } };
  };
}

describe("PromptHub wallet credit operations", () => {
  it("posts the amount/reason/refId to the consume endpoint and returns the new balance", async () => {
    const observed = { bodies: [] as Array<Record<string, unknown>> };
    const { provider, token } = await sessionAndProvider(creditRoute({
      status: 200,
      body: { ok: true, data: { balance: 98, replayed: false } },
    }, observed));

    const result = await provider.consumeCredit(token, { amount: 2, reason: "agent_run", refId: "agent-run:run-1" });

    expect(result.data).toEqual({ balance: 98, replayed: false });
    expect(observed.bodies).toEqual([{ amount: 2, reason: "agent_run", refId: "agent-run:run-1" }]);
  });

  it("maps an upstream 402 INSUFFICIENT_CREDITS envelope to WALLET error code INSUFFICIENT_CREDITS", async () => {
    const { provider, token } = await sessionAndProvider(creditRoute({
      status: 402,
      body: { ok: false, error: { code: "INSUFFICIENT_CREDITS", message: "积分不足" } },
    }));

    await expect(provider.consumeCredit(token, { amount: 2, reason: "agent_run", refId: "agent-run:run-2" }))
      .rejects.toMatchObject({ status: 402, code: "INSUFFICIENT_CREDITS" });
  });

  it("surfaces replayed=true from an idempotent refund", async () => {
    const { provider, token } = await sessionAndProvider(creditRoute({
      status: 200,
      body: { ok: true, data: { balance: 100, replayed: true } },
    }));

    const result = await provider.refundCredit(token, { amount: 2, reason: "agent_run_refund", refId: "agent-run:run-3" });
    expect(result.data).toEqual({ balance: 100, replayed: true });
  });
});
