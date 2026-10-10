import { describe, expect, it } from "vitest";

import { CanvasCommandBroker } from "./canvas-command-broker.js";

const context = {
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

const action = [{ type: "canvas_add_node" as const, clientId: "codex_a", kind: "text" as const, body: "hi" }];

describe("CanvasCommandBroker", () => {
  it("refuses to queue before the browser has reported a canvas", async () => {
    const broker = new CanvasCommandBroker({ waitMs: 1_000 });
    await expect(broker.enqueue("user-a", { actions: action, summary: "s" })).resolves.toBeNull();
  });

  it("delivers a command to that user's browser and resolves with its receipt", async () => {
    const broker = new CanvasCommandBroker({ waitMs: 5_000 });
    broker.rememberContext("user-a", "p1", context);

    const waiting = broker.enqueue("user-a", { actions: action, summary: "加个节点" });
    const commands = broker.pendingFor("user-a");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ projectId: "p1", source: "codex" });

    expect(broker.submitReceipt("user-a", {
      commandId: commands[0]!.id,
      status: "applied",
      appliedActions: 1,
      skippedActions: [],
      reason: null,
    })).toBe(true);
    await expect(waiting).resolves.toMatchObject({ status: "applied", appliedActions: 1 });
  });

  it("isolates owners and does not let another user settle the command", async () => {
    const broker = new CanvasCommandBroker({ waitMs: 3_000 });
    broker.rememberContext("user-a", "p1", context);
    broker.rememberContext("user-b", "p2", context);

    const waiting = broker.enqueue("user-a", { actions: action, summary: "s" });
    const command = broker.pendingFor("user-a")[0]!;
    // 另一个用户既看不到这条指令，也无法结算它
    expect(broker.pendingFor("user-b")).toHaveLength(0);
    expect(broker.submitReceipt("user-b", {
      commandId: command.id,
      status: "applied",
      appliedActions: 1,
      skippedActions: [],
      reason: null,
    })).toBe(false);

    broker.submitReceipt("user-a", {
      commandId: command.id,
      status: "rejected",
      appliedActions: 0,
      skippedActions: [{ index: 0, reason: "节点已存在" }],
      reason: "画布没有接受这组操作",
    });
    await expect(waiting).resolves.toMatchObject({ status: "rejected" });
  });

  it("converges to a truthful rejection when nobody answers", async () => {
    const broker = new CanvasCommandBroker({ waitMs: 40 });
    broker.rememberContext("user-a", "p1", context);
    await expect(broker.enqueue("user-a", { actions: action, summary: "s" }))
      .resolves.toMatchObject({ status: "rejected", appliedActions: 0 });
    expect(broker.pendingFor("user-a")).toHaveLength(0);
  });

  it("stops reporting a stale canvas summary", () => {
    let now = 0;
    const broker = new CanvasCommandBroker({ now: () => now });
    broker.rememberContext("user-a", "p1", context);
    expect(broker.readContext("user-a")?.context).not.toBeNull();
    now = 10 * 60_000;
    expect(broker.readContext("user-a")?.context).toBeNull();
  });
});
