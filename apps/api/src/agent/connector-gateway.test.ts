import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { HttpAgentConnectorGateway } from "./connector-gateway.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const connector = {
  id: "codex",
  label: "Codex",
  summary: "把画布交给本机 Codex",
  enabled: true,
  state: "ready",
  detail: null,
  endpoint: null,
  capabilities: ["新建节点"],
  setup: "安装 MCP",
  checkedAt: new Date().toISOString(),
};

function gateway(fetchImpl: typeof fetch) {
  return new HttpAgentConnectorGateway("http://127.0.0.1:8790", "token", { fetchImpl });
}

describe("HttpAgentConnectorGateway", () => {
  it("reads connector status through the runtime", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: [connector] })) as unknown as typeof fetch;
    await expect(gateway(fetchImpl).list()).resolves.toEqual([connector]);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8790/internal/v1/connectors");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("sends connector updates as JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: connector })) as unknown as typeof fetch;
    await gateway(fetchImpl).update("blender", { enabled: true, endpoint: "127.0.0.1:9876" });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8790/internal/v1/connectors/blender");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true, endpoint: "127.0.0.1:9876" });
  });

  it("returns the browser's pending canvas commands", async () => {
    const command = {
      schemaVersion: 1,
      id: randomUUID(),
      projectId: "p1",
      source: "codex",
      summary: "s",
      actions: [{ type: "canvas_add_node", clientId: "codex_a", kind: "text", body: "" }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: { commands: [command] } })) as unknown as typeof fetch;
    await expect(gateway(fetchImpl).pending("p1", undefined)).resolves.toEqual([command]);
  });

  it("reports whether a receipt was accepted", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, data: { accepted: true } })) as unknown as typeof fetch;
    await expect(gateway(fetchImpl).recordReceipt({
      commandId: randomUUID(),
      status: "applied",
      appliedActions: 1,
      skippedActions: [],
      reason: null,
    })).resolves.toBe(true);
  });

  it("maps transport and contract failures to explicit errors", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(gateway(down).list()).rejects.toMatchObject({ code: "CONNECTOR_RUNTIME_UNAVAILABLE" });

    const bad = vi.fn(async () => jsonResponse({ ok: true, data: { nope: true } })) as unknown as typeof fetch;
    await expect(gateway(bad).list()).rejects.toMatchObject({ code: "CONNECTOR_INVALID_RESPONSE" });

    const failure = vi.fn(async () => jsonResponse({ ok: false, error: { code: "X", message: "no" } }, 409)) as unknown as typeof fetch;
    await expect(gateway(failure).list()).rejects.toMatchObject({ code: "CONNECTOR_RUNTIME_UNAVAILABLE" });
  });
});
