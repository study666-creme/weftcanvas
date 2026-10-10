import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { PromptHubProvider } from "./prompt-hub-provider.js";

const NOW = Date.parse("2026-08-10T08:00:00.000Z");
const SESSION_COOKIE = "kachang_canvas_session";

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

function ledgerItem(overrides: Record<string, unknown> = {}) {
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
  };
}

function createProvider(route: MockRoute) {
  return new PromptHubProvider({
    apiBaseUrl: "https://upstream.example.com",
    authBaseUrl: "https://auth.example.com",
    anonKey: "anon-key",
    sessionSecret: "k".repeat(64),
    siteUrl: "https://canvas.example.com",
    now: () => NOW,
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

async function createWalletApp(route: MockRoute) {
  const provider = createProvider(route);
  const issued = await provider.login({ email: "creator@example.com", password: "private-password" });
  const app = createApiApp({
    catalog: { getCatalog: async () => { throw new Error("catalog should not be called"); } },
    quotes: { createQuote: async () => { throw new Error("quotes should not be called"); } },
    wallet: provider,
  });
  return {
    app,
    cookie: `${SESSION_COOKIE}=${issued.token}`,
  };
}

describe("wallet ledger HTTP route", () => {
  it("returns ledger items for the current data-array shape without a 503", async () => {
    const { app, cookie } = await createWalletApp(ledgerRoute({
      status: 200,
      body: { ok: true, data: [ledgerItem(), ledgerItem({ id: "ledger-2", delta: 500, balanceAfter: 1700, reason: "refund", reasonLabel: "生成退款" })] },
    }));
    const response = await app.request("http://localhost/api/v1/wallet/ledger?limit=5", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      ok: true,
      data: {
        items: [
          ledgerItem(),
          ledgerItem({ id: "ledger-2", delta: 500, balanceAfter: 1700, reason: "refund", reasonLabel: "生成退款" }),
        ],
      },
    });
  });

  it("keeps the old data.items shape working through the route", async () => {
    const { app, cookie } = await createWalletApp(ledgerRoute({
      status: 200,
      body: { ok: true, data: { items: [ledgerItem()] } },
    }));
    const response = await app.request("http://localhost/api/v1/wallet/ledger?limit=5", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.items).toEqual([ledgerItem()]);
  });

  it("defaults a missing limit to 20 upstream", async () => {
    const observed: { limits: number[] } = { limits: [] };
    const { app, cookie } = await createWalletApp(ledgerRoute({
      status: 200,
      body: { ok: true, data: [] },
    }, observed));
    const response = await app.request("http://localhost/api/v1/wallet/ledger", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(observed.limits).toEqual([20]);
  });

  it("passes bounded limits through to the upstream", async () => {
    const observed: { limits: number[] } = { limits: [] };
    const { app, cookie } = await createWalletApp(ledgerRoute({
      status: 200,
      body: { ok: true, data: [] },
    }, observed));
    for (const limit of [1, 50]) {
      const response = await app.request(`http://localhost/api/v1/wallet/ledger?limit=${limit}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
    }
    expect(observed.limits).toEqual([1, 50]);
  });

  it("rejects out-of-range and malformed limits before calling the upstream", async () => {
    const { app, cookie } = await createWalletApp(ledgerRoute({
      status: 200,
      body: { ok: true, data: [] },
    }));
    for (const limit of ["0", "51", "abc", "-1"]) {
      const response = await app.request(`http://localhost/api/v1/wallet/ledger?limit=${limit}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe("INVALID_LIMIT");
    }
  });

  it("does not leak unknown upstream fields into the browser response", async () => {
    const { app, cookie } = await createWalletApp(ledgerRoute({
      status: 200,
      body: {
        ok: true,
        data: [{ ...ledgerItem(), user_id: "private-user", access_token: "secret", internal_note: "do not leak" }],
      },
    }));
    const response = await app.request("http://localhost/api/v1/wallet/ledger?limit=5", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("private-user");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("do not leak");
  });

  it("surfaces an upstream error envelope as the product error, not WALLET_INVALID_RESPONSE", async () => {
    const { app, cookie } = await createWalletApp(ledgerRoute({
      status: 200,
      body: { ok: false, error: { code: "LEDGER_DENIED", message: "no permission" } },
    }));
    const response = await app.request("http://localhost/api/v1/wallet/ledger?limit=5", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error.code).toBe("LEDGER_DENIED");
    expect(payload.error.code).not.toBe("WALLET_INVALID_RESPONSE");
  });

  it("still fails closed on a malformed upstream success payload", async () => {
    const { app, cookie } = await createWalletApp(ledgerRoute({
      status: 200,
      body: { ok: true, data: { items: [{ id: "incomplete" }] } },
    }));
    const response = await app.request("http://localhost/api/v1/wallet/ledger?limit=5", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.error.code).toBe("WALLET_INVALID_RESPONSE");
  });

  it("reports WALLET_UNAVAILABLE when no wallet is configured", async () => {
    const app = createApiApp({
      catalog: { getCatalog: async () => { throw new Error("catalog should not be called"); } },
      quotes: { createQuote: async () => { throw new Error("quotes should not be called"); } },
    });
    const response = await app.request("http://localhost/api/v1/wallet/ledger?limit=5");
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.error.code).toBe("WALLET_UNAVAILABLE");
  });
});
