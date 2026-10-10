import { describe, expect, it, vi } from "vitest";

import { createAgentApp } from "./app.js";
import { CanvasControlQueue } from "./canvas-control.js";
import { AgentConnectorRegistry } from "./connectors/registry.js";
import { MemoryConnectorSettingsStore } from "./connectors/settings.js";

const TOKEN = "test-token";
const AUTHORIZATION = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function buildApp(queue = new CanvasControlQueue({ waitMs: 2_000 })) {
  const provision = {
    codex: vi.fn(async () => ({ ok: true, detail: "已写入 Codex 配置", action: "重启 Codex 后生效" })),
    blender: vi.fn(async () => ({ ok: true, detail: "已装好插件并启用，已启动 Blender", action: null })),
  };
  const connectors = new AgentConnectorRegistry(new MemoryConnectorSettingsStore(), {
    probes: {
      codex: vi.fn(async () => ({ reachable: true, detail: "codex-cli 0.9.0" })),
      blender: vi.fn(async () => ({ reachable: false, detail: "端口上没有 Blender 桥接在监听" })),
    },
    provisioner: provision,
  });
  const app = createAgentApp({
    token: TOKEN,
    models: { getCatalog: () => ({ defaultModelId: "gpt-test", models: [{ id: "gpt-test", label: "Test" }] }) },
    runs: { handle: async () => ({ status: 200 as const, body: { ok: true as const, data: { content: "ok", actions: [], toolCalls: [], executionMode: "none" as const, proposal: null } } }) },
    connectors,
    canvasControl: queue,
  });
  return { app, queue, connectors, provision };
}

const canvasContext = {
  schemaVersion: 1 as const,
  contextRevision: "rev-1",
  projectId: "p1",
  projectName: "项目",
  nodeCount: 0,
  edgeCount: 0,
  groupCount: 0,
  omittedNodeCount: 0,
  omittedEdgeCount: 0,
  nodes: [],
  edges: [],
  groups: [],
  directorStage: null,
};

describe("agent connector HTTP surface", () => {
  it("requires the runtime bearer token", async () => {
    const { app } = buildApp();
    expect((await app.request("/internal/v1/connectors")).status).toBe(401);
    expect((await app.request("/internal/v1/connectors", { headers: AUTHORIZATION })).status).toBe(200);
  });

  it("serves real connector states and applies updates", async () => {
    const { app } = buildApp();
    const list = await (await app.request("/internal/v1/connectors", { headers: AUTHORIZATION })).json();
    expect(list.data.map((item: { state: string }) => item.state)).toEqual(["disabled", "disabled"]);

    const updated = await (await app.request("/internal/v1/connectors/codex", {
      method: "PUT",
      headers: AUTHORIZATION,
      body: JSON.stringify({ enabled: true }),
    })).json();
    expect(updated.data).toMatchObject({ id: "codex", enabled: true, state: "ready" });

    expect((await app.request("/internal/v1/connectors/maya", {
      method: "PUT",
      headers: AUTHORIZATION,
      body: JSON.stringify({ enabled: true }),
    })).status).toBe(404);
  });

  it("runs one-click provisioning through the connect endpoint", async () => {
    const { app, provision } = buildApp();
    const response = await app.request("/internal/v1/connectors/blender/connect", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({ launch: false }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ id: "blender", enabled: true });
    expect(body.data.detail).toContain("已装好插件并启用");
    expect(provision.blender).toHaveBeenCalledWith("127.0.0.1:9876", false, expect.anything());

    // 未知连接与非法参数都要明确拒绝。
    expect((await app.request("/internal/v1/connectors/maya/connect", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({}),
    })).status).toBe(404);
    expect((await app.request("/internal/v1/connectors/blender/connect", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({ launch: "yes" }),
    })).status).toBe(400);
  });

  it("refuses a canvas command when no canvas page is polling", async () => {
    const { app } = buildApp();
    const response = await app.request("/internal/v1/canvas-commands", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({
        actions: [{ type: "canvas_add_node", clientId: "codex_a", kind: "text", body: "hi" }],
      }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("CANVAS_NOT_OPEN");
  });

  it("round-trips a canvas command through the browser and back", async () => {
    const { app, queue } = buildApp();
    // 浏览器上线：上报摘要并取回（此时为空）指令。
    const firstPoll = await app.request("/internal/v1/canvas-control/pending", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({ projectId: "p1", context: canvasContext }),
    });
    expect((await firstPoll.json()).data.commands).toEqual([]);

    const commandPromise = app.request("/internal/v1/canvas-commands", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({
        summary: "加一个文本节点",
        actions: [{ type: "canvas_add_node", clientId: "codex_a", kind: "text", body: "hi" }],
      }),
    });

    // 等入队完成后再拉取。
    await vi.waitFor(() => expect(queue.size()).toBe(1));
    const poll = await (await app.request("/internal/v1/canvas-control/pending", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({ projectId: "p1", context: canvasContext }),
    })).json();
    expect(poll.data.commands).toHaveLength(1);
    const command = poll.data.commands[0];
    expect(command.projectId).toBe("p1");

    // 外部连接能读到同一份画布摘要。
    const contextResponse = await (await app.request("/internal/v1/canvas-context", { headers: AUTHORIZATION })).json();
    expect(contextResponse.data).toMatchObject({ projectId: "p1" });
    expect(contextResponse.data.context.contextRevision).toBe("rev-1");

    const receiptResponse = await app.request("/internal/v1/canvas-control/receipts", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({
        commandId: command.id,
        status: "applied",
        appliedActions: 1,
        skippedActions: [],
        reason: null,
      }),
    });
    expect((await receiptResponse.json()).data.accepted).toBe(true);

    const settled = await commandPromise;
    expect(settled.status).toBe(200);
    expect((await settled.json()).data).toMatchObject({ status: "applied", appliedActions: 1 });
  });

  it("rejects canvas commands that fall outside the action contract", async () => {
    const { app } = buildApp();
    const response = await app.request("/internal/v1/canvas-commands", {
      method: "POST",
      headers: AUTHORIZATION,
      body: JSON.stringify({
        projectId: "p1",
        actions: [{ type: "canvas_delete_node", nodeId: "n1" }],
      }),
    });
    expect(response.status).toBe(400);
  });
});
