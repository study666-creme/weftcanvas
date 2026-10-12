import { describe, expect, it } from "vitest";

import type { AgentAction } from "@weftcanvas/contracts";

import { CanvasControlQueue } from "./canvas-control.js";

function addNode(body: string): AgentAction[] {
  return [{ type: "canvas_add_node", clientId: "codex_a", kind: "text", body }];
}

describe("CanvasControlQueue", () => {
  it("hands a command to the browser and resolves with the browser receipt", async () => {
    const queue = new CanvasControlQueue({ waitMs: 5_000 });
    const waiting = queue.enqueue({
      projectId: "p1",
      actions: addNode("hi"),
      summary: "加一个文本节点",
      source: "codex",
    });

    const commands = queue.pendingFor("p1");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.source).toBe("codex");
    expect(commands[0]?.summary).toBe("加一个文本节点");

    expect(
      queue.settle({
        commandId: commands[0]!.id,
        status: "applied",
        appliedActions: 1,
        skippedActions: [],
        reason: null,
      }),
    ).toBe(true);

    await expect(waiting).resolves.toMatchObject({
      ok: true,
      receipt: { status: "applied", appliedActions: 1 },
    });
    expect(queue.size()).toBe(0);
  });

  it("only delivers commands to the project that asked for them", async () => {
    const queue = new CanvasControlQueue({ waitMs: 5_000 });
    const waiting = queue.enqueue({
      projectId: "p1",
      actions: addNode("hi"),
      summary: "s",
      source: "codex",
    });
    expect(queue.pendingFor("p2")).toHaveLength(0);
    expect(queue.pendingFor("p1")).toHaveLength(1);
    queue.settle({
      commandId: queue.pendingFor("p1")[0]!.id,
      status: "rejected",
      appliedActions: 0,
      skippedActions: [],
      reason: "no",
    });
    await waiting;
  });

  it("fails instead of pretending success when no canvas is polling", async () => {
    const queue = new CanvasControlQueue({ waitMs: 30 });
    await expect(
      queue.enqueue({ projectId: "p1", actions: addNode("hi"), summary: "s", source: "codex" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("remembers the active canvas and its summary while a page is polling", () => {
    const queue = new CanvasControlQueue({ waitMs: 5_000, contextMaxAgeMs: 1_000, now: () => 0 });
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
    queue.pendingFor("p1", context);
    expect(queue.activeProjectId()).toBe("p1");
    expect(queue.activeContext()?.contextRevision).toBe("rev-1");
  });

  it("stops reporting a stale canvas summary", () => {
    let now = 0;
    const queue = new CanvasControlQueue({ waitMs: 5_000, contextMaxAgeMs: 100, now: () => now });
    queue.pendingFor("p1", {
      schemaVersion: 1,
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
    });
    now = 5_000;
    expect(queue.activeContext()).toBeNull();
    expect(queue.activeProjectId()).toBe("p1");
  });

  it("rejects malformed commands and cancels cleanly", async () => {
    const queue = new CanvasControlQueue({ waitMs: 5_000 });
    await expect(
      queue.enqueue({ projectId: "p1", actions: [], summary: "s", source: "codex" }),
    ).resolves.toMatchObject({ ok: false });

    const controller = new AbortController();
    const waiting = queue.enqueue(
      { projectId: "p1", actions: addNode("hi"), summary: "s", source: "codex" },
      controller.signal,
    );
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ ok: false, error: "已取消" });
  });
});
