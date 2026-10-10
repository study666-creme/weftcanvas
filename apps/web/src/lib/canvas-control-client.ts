import type { CanvasControlCommand, CanvasControlReceiptRequest } from "@kachang/contracts";

import { executeAgentActions, readAgentActionExecution } from "./agent-action-executor";
import { sendCanvasControlReceipt } from "./api-client";

export type CanvasControlOutcome = {
  status: CanvasControlReceiptRequest["status"];
  appliedActions: number;
  skippedActions: CanvasControlReceiptRequest["skippedActions"];
  reason: string | null;
  alreadyApplied: boolean;
};

/**
 * 执行一条外部连接下发的画布指令。复用 Agent 的 applyAgentActions 与
 * `${projectId}:${commandId}` 去重：同一条指令重复拉取不会重复执行。
 */
export function applyCanvasControlCommand(projectId: string, command: CanvasControlCommand): CanvasControlOutcome {
  const recovered = readAgentActionExecution(projectId, command.id);
  const result = recovered ?? executeAgentActions(projectId, command.id, command.actions);
  const total = command.actions.length;
  const status = result.skipped === 0 && result.applied === total
    ? "applied"
    : result.applied > 0
      ? "partial"
      : "rejected";
  const reason = status === "applied"
    ? null
    : status === "partial"
      ? `已应用 ${result.applied} 项，另有 ${result.skipped} 项未能应用`
      : "画布没有接受这组操作";
  return {
    status,
    appliedActions: result.applied,
    skippedActions: result.skippedActions,
    reason,
    alreadyApplied: result.alreadyApplied,
  };
}

export async function reportCanvasControlOutcome(command: CanvasControlCommand, outcome: CanvasControlOutcome) {
  return sendCanvasControlReceipt({
    commandId: command.id,
    status: outcome.status,
    appliedActions: outcome.appliedActions,
    skippedActions: outcome.skippedActions,
    reason: outcome.reason,
  });
}

export function describeCanvasControlOutcome(command: CanvasControlCommand, outcome: CanvasControlOutcome) {
  if (outcome.alreadyApplied) return null;
  if (outcome.status === "applied") return `Codex 已完成 ${outcome.appliedActions} 项画布操作`;
  if (outcome.status === "partial") return `Codex 的画布操作部分完成：${outcome.reason ?? ""}`.trim();
  return `Codex 的画布操作没有生效：${outcome.reason ?? command.summary}`;
}
