import { describe, expect, it } from "vitest";

import {
  agentConnectorUpdateRequestSchema,
  canvasControlCommandSchema,
  canvasControlPendingRequestSchema,
  canvasControlReceiptRequestSchema,
  connectorEndpointRejectionReason,
} from "./connectors.js";

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";

function command(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: COMMAND_ID,
    projectId: "p1",
    source: "codex",
    summary: "加一个文本节点",
    actions: [{ type: "canvas_add_node", clientId: "codex_a", kind: "text", body: "hi" }],
    createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("agent connector contracts", () => {
  it("requires at least one field in an update", () => {
    expect(agentConnectorUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(agentConnectorUpdateRequestSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: null }).success).toBe(true);
    expect(agentConnectorUpdateRequestSchema.safeParse({ enabled: true, endpoint: "127.0.0.1:9876" }).success).toBe(true);
    expect(agentConnectorUpdateRequestSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  });

  it("rejects shell metacharacters in connector endpoints", () => {
    // 这些串会直达运行时的 spawn(shell) / net.connect。
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "calc.exe & whoami" }).success).toBe(false);
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "codex; rm -rf /" }).success).toBe(false);
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "$(curl evil)" }).success).toBe(false);
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "a`id`" }).success).toBe(false);
    // 普通命令名、带空格的 Windows 路径、私有网段的 host:port 仍放行。
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "codex" }).success).toBe(true);
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "C:\\Program Files\\codex.cmd" }).success).toBe(true);
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "192.168.1.50:8765" }).success).toBe(true);
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "[::1]:6379" }).success).toBe(true);
    expect(agentConnectorUpdateRequestSchema.safeParse({ endpoint: "blender.local:8765" }).success).toBe(true);
  });

  it("blocks link-local and metadata targets in connector endpoints", () => {
    expect(connectorEndpointRejectionReason("169.254.169.254:80")).toContain("链路本地");
    expect(connectorEndpointRejectionReason("169.254.0.1:80")).toContain("链路本地");
    expect(connectorEndpointRejectionReason("255.255.255.255:80")).toContain("多播或保留");
    expect(connectorEndpointRejectionReason("224.0.0.1:80")).toContain("多播或保留");
    expect(connectorEndpointRejectionReason("metadata.google.internal:80")).toContain("元数据");
    expect(connectorEndpointRejectionReason("[fe80::1]:80")).toContain("链路本地");
    expect(connectorEndpointRejectionReason("[::ffff:169.254.169.254]:80")).toContain("链路本地");
    expect(connectorEndpointRejectionReason("127.0.0.1:8765")).toBeNull();
    expect(connectorEndpointRejectionReason("10.0.0.5:8765")).toBeNull();
    expect(connectorEndpointRejectionReason("172.16.3.9:8765")).toBeNull();
    expect(connectorEndpointRejectionReason("192.168.1.50:8765")).toBeNull();
    expect(connectorEndpointRejectionReason("codex")).toBeNull();
  });

  it("accepts an optional canvas summary alongside the project id", () => {
    expect(canvasControlPendingRequestSchema.safeParse({ projectId: "p1" }).success).toBe(true);
    const withContext = canvasControlPendingRequestSchema.safeParse({
      projectId: "p1",
      context: {
        schemaVersion: 1,
        contextRevision: "rev",
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
      },
    });
    expect(withContext.success).toBe(true);
    expect(canvasControlPendingRequestSchema.safeParse({ projectId: "" }).success).toBe(false);
  });

  it("validates external canvas commands", () => {
    expect(canvasControlCommandSchema.safeParse(command()).success).toBe(true);
    expect(canvasControlCommandSchema.safeParse(command({ actions: [] })).success).toBe(false);
    expect(canvasControlCommandSchema.safeParse(command({ source: "maya" })).success).toBe(false);
    expect(canvasControlCommandSchema.safeParse(command({ actions: [{ type: "canvas_delete_node", nodeId: "n1" }] })).success).toBe(false);
  });

  it("defaults receipt details and rejects unknown outcomes", () => {
    const parsed = canvasControlReceiptRequestSchema.parse({
      commandId: COMMAND_ID,
      status: "applied",
      appliedActions: 1,
    });
    expect(parsed).toMatchObject({ skippedActions: [], reason: null });
    expect(canvasControlReceiptRequestSchema.safeParse({
      commandId: COMMAND_ID,
      status: "maybe",
      appliedActions: 1,
    }).success).toBe(false);
  });
});
