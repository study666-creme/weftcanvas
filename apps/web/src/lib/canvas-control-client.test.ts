import type { CanvasControlCommand } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import { describeCanvasControlOutcome, type CanvasControlOutcome } from "./canvas-control-client";

const command: CanvasControlCommand = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "p1",
  source: "codex",
  summary: "加一个文本节点",
  actions: [{ type: "canvas_add_node", clientId: "codex_a", kind: "text", body: "hi" }],
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function outcome(overrides: Partial<CanvasControlOutcome>): CanvasControlOutcome {
  return {
    status: "applied",
    appliedActions: 1,
    skippedActions: [],
    reason: null,
    alreadyApplied: false,
    ...overrides,
  };
}

describe("describeCanvasControlOutcome", () => {
  it("stays silent when the command was already applied", () => {
    expect(describeCanvasControlOutcome(command, outcome({ alreadyApplied: true }))).toBeNull();
  });

  it("describes applied, partial and rejected results truthfully", () => {
    expect(describeCanvasControlOutcome(command, outcome({}))).toBe("Codex 已完成 1 项画布操作");
    expect(
      describeCanvasControlOutcome(
        command,
        outcome({
          status: "partial",
          appliedActions: 1,
          skippedActions: [{ index: 1, reason: "没有找到节点 n9" }],
          reason: "已应用 1 项，另有 1 项未能应用",
        }),
      ),
    ).toContain("部分完成");
    expect(
      describeCanvasControlOutcome(
        command,
        outcome({
          status: "rejected",
          appliedActions: 0,
          reason: "画布没有接受这组操作",
        }),
      ),
    ).toContain("没有生效");
  });
});
