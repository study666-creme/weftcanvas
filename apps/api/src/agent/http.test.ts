import { describe, expect, it, vi } from "vitest";

import { createApiApp } from "../app.js";
import type { AgentApi } from "../app.js";
import { PromptHubProvider } from "../identity/prompt-hub-provider.js";
import { AgentServiceError } from "./service.js";

const SESSION_COOKIE = "kachang_canvas_session";

const AUTH_USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "creator@example.com",
  created_at: "2026-07-15T00:00:00.000Z",
  user_metadata: {},
};

function createProvider() {
  return new PromptHubProvider({
    apiBaseUrl: "https://upstream.example.com",
    authBaseUrl: "https://auth.example.com",
    anonKey: "anon-key",
    sessionSecret: "k".repeat(64),
    siteUrl: "https://canvas.example.com",
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/token") {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          user: AUTH_USER,
        });
      }
      if (url.pathname === "/auth/v1/user") return jsonResponse(AUTH_USER);
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "unexpected route" } }, 404);
    },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function agentStub(overrides: Partial<AgentApi> = {}): AgentApi {
  const unavailable = async () => { throw new Error("not implemented in this test"); };
  return {
    createConversation: unavailable,
    listConversations: unavailable,
    getDetail: unavailable,
    getModels: unavailable,
    submitMessage: unavailable,
    cancelRun: unavailable,
    confirmProposal: unavailable,
    dismissProposal: unavailable,
    recordReceipt: unavailable,
    ...overrides,
  } as AgentApi;
}

async function createAgentApp(agent: AgentApi) {
  const provider = createProvider();
  const issued = await provider.login({ email: "creator@example.com", password: "private-password" });
  const app = createApiApp({
    catalog: { getCatalog: async () => { throw new Error("catalog should not be called"); } },
    quotes: { createQuote: async () => { throw new Error("quotes should not be called"); } },
    identity: provider,
    agent,
  });
  return { app, cookie: `${SESSION_COOKIE}=${issued.token}` };
}

function createGuestApp(agent: AgentApi) {
  return createApiApp({
    catalog: { getCatalog: async () => { throw new Error("catalog should not be called"); } },
    quotes: { createQuote: async () => { throw new Error("quotes should not be called"); } },
    identity: createProvider(),
    agent,
  });
}

describe("agent HTTP access", () => {
  it("requires a signed-in session for every agent route (guests get 401)", async () => {
    const create = vi.fn();
    const submit = vi.fn();
    const app = createGuestApp(agentStub({ createConversation: create as never, submitMessage: submit as never }));

    const listResponse = await app.request("http://localhost/api/v1/agent/conversations?projectId=project-1");
    expect(listResponse.status).toBe(401);
    expect(await listResponse.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });

    const createResponse = await app.request("http://localhost/api/v1/agent/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1" }),
    });
    expect(createResponse.status).toBe(401);

    const submitResponse = await app.request(
      "http://localhost/api/v1/agent/conversations/11111111-1111-4111-8111-111111111111/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "画一个圆", idempotencyKey: "key-12345678" }),
      },
    );
    expect(submitResponse.status).toBe(401);

    expect(create).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("maps insufficient credits to HTTP 402 and forwards the session token to the service", async () => {
    const submit = vi.fn(async () => {
      throw new AgentServiceError("INSUFFICIENT_CREDITS", "积分不足，请充值后重试");
    });
    const { app, cookie } = await createAgentApp(agentStub({ submitMessage: submit as never }));

    const response = await app.request(
      "http://localhost/api/v1/agent/conversations/11111111-1111-4111-8111-111111111111/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ content: "画一个圆", idempotencyKey: "key-12345678" }),
      },
    );

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INSUFFICIENT_CREDITS", message: "积分不足，请充值后重试" },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const [, , , token] = submit.mock.calls[0] as unknown as [string, string, unknown, string];
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });
});
