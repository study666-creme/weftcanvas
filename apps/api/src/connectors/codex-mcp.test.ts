import { describe, expect, it } from "vitest";

import { CanvasCommandBroker } from "./canvas-command-broker.js";
import { handleCodexMcpMessage } from "./codex-mcp.js";

const context = {
  schemaVersion: 1 as const,
  contextRevision: "rev-9",
  projectId: "p1",
  projectName: "我的项目",
  nodeCount: 1,
  edgeCount: 0,
  groupCount: 0,
  omittedNodeCount: 0,
  omittedEdgeCount: 0,
  nodes: [{ id: "node-1", kind: "text" as const, text: "开场", selected: false, media: null }],
  edges: [],
  groups: [],
  directorStage: null,
};

function harness() {
  const broker = new CanvasCommandBroker({ waitMs: 2_000 });
  return { broker, mcp: (message: unknown) => handleCodexMcpMessage(message as never, { ownerId: "user-a", broker }) };
}

describe("Codex MCP endpoint", () => {
  it("answers the handshake and lists the canvas tools", async () => {
    const { mcp } = harness();
    const initialized = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(initialized.result.protocolVersion).toBe("2024-11-05");
    expect(initialized.result.serverInfo.name).toBe("kachang-canvas");

    const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toContain("canvas_read");
    expect(names).toContain("canvas_add_node");
    expect(await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("tells the client to open the canvas when no page has reported one", async () => {
    const { mcp } = harness();
    const response = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "canvas_read", arguments: {} } }) as {
      result: { content: Array<{ text: string }> };
    };
    expect(response.result.content[0]!.text).toContain("请先在浏览器里打开画布页面");
  });

  it("reads the reported canvas summary", async () => {
    const { broker, mcp } = harness();
    broker.rememberContext("user-a", "p1", context);
    const response = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "canvas_read", arguments: {} } }) as {
      result: { content: Array<{ text: string }> };
    };
    const text = response.result.content[0]!.text;
    expect(text).toContain("我的项目");
    expect(text).toContain("node-1");
    expect(text).toContain("开场");
  });

  it("queues a canvas write and reports the browser's receipt", async () => {
    const { broker, mcp } = harness();
    broker.rememberContext("user-a", "p1", context);

    const calling = mcp({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "canvas_add_node", arguments: { kind: "text", body: "第二幕" } },
    });
    // 等指令入队后由"浏览器"执行并回执
    await new Promise((resolve) => setTimeout(resolve, 10));
    const command = broker.pendingFor("user-a")[0]!;
    expect(command.actions[0]).toMatchObject({ type: "canvas_add_node", kind: "text", body: "第二幕" });
    broker.submitReceipt("user-a", {
      commandId: command.id,
      status: "applied",
      appliedActions: 1,
      skippedActions: [],
      reason: null,
    });

    const response = await calling as { result: { content: Array<{ text: string }> } };
    expect(response.result.content[0]!.text).toBe("已应用 1 项");
  });

  it("rejects unknown tools and unknown methods honestly", async () => {
    const { mcp } = harness();
    const unknownTool = await mcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "maya_run", arguments: {} } }) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(unknownTool.result.isError).toBe(true);
    expect(unknownTool.result.content[0]!.text).toContain("未知工具");

    const unknownMethod = await mcp({ jsonrpc: "2.0", id: 7, method: "resources/list" }) as { error: { code: number } };
    expect(unknownMethod.error.code).toBe(-32601);
  });
});
