import { normalizeDirectorStagePacket, type AgentAction } from "@kachang/contracts";

import { useCanvasStore } from "../state/canvas-store";
import { useDirectorStageLaunchStore } from "../state/director-stage-launch-store";

const EXECUTED_RUNS_KEY = "kachang-canvas:agent-action-runs:v2";

type StoredExecution = {
  id: string;
  applied: number;
  skipped: number;
  skippedActions: Array<{ index: number; reason: string }>;
};

const memoryRuns = new Map<string, StoredExecution>();

export type AgentActionExecutionResult = {
  applied: number;
  skipped: number;
  skippedActions: Array<{ index: number; reason: string }>;
  alreadyApplied: boolean;
};

export function readAgentActionExecution(projectId: string, runId: string): AgentActionExecutionResult | null {
  const execution = readExecution(`${projectId}:${runId}`);
  return execution ? { ...execution, alreadyApplied: true } : null;
}

export function executeAgentActions(projectId: string, runId: string, actions: AgentAction[]): AgentActionExecutionResult {
  const storageId = `${projectId}:${runId}`;
  if (!actions.length) return { applied: 0, skipped: 0, skippedActions: [], alreadyApplied: true };
  const previous = readExecution(storageId);
  if (previous) return { ...previous, alreadyApplied: true };

  for (const action of actions) {
    if (action.type === "canvas_director_load_packet") normalizeDirectorStagePacket(action.packet);
  }

  const canvas = useCanvasStore.getState().applyAgentActions(actions);
  const directorApplied = useDirectorStageLaunchStore.getState().runAgentActions(actions);
  const result = {
    applied: canvas.applied + directorApplied,
    skipped: canvas.skipped,
    skippedActions: canvas.skippedActions,
    alreadyApplied: false,
  };
  markExecuted({ id: storageId, ...result });
  return result;
}

function readExecution(id: string): StoredExecution | null {
  const memory = memoryRuns.get(id);
  if (memory) return memory;
  try {
    const values = JSON.parse(window.localStorage.getItem(EXECUTED_RUNS_KEY) || "[]") as unknown;
    if (!Array.isArray(values)) return null;
    const found = values.find((value): value is StoredExecution => isStoredExecution(value) && value.id === id) ?? null;
    if (found) memoryRuns.set(id, found);
    return found;
  } catch {
    return null;
  }
}

function markExecuted(execution: StoredExecution) {
  memoryRuns.set(execution.id, execution);
  try {
    const current = JSON.parse(window.localStorage.getItem(EXECUTED_RUNS_KEY) || "[]") as unknown;
    const values = Array.isArray(current)
      ? current.filter((value): value is StoredExecution => isStoredExecution(value) && value.id !== execution.id)
      : [];
    window.localStorage.setItem(EXECUTED_RUNS_KEY, JSON.stringify([...values.slice(-99), execution]));
  } catch {
    // In-memory deduplication still protects the current session.
  }
}

function isStoredExecution(value: unknown): value is StoredExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredExecution>;
  return typeof record.id === "string"
    && Number.isInteger(record.applied)
    && Number.isInteger(record.skipped)
    && Array.isArray(record.skippedActions);
}
