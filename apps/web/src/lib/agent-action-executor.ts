import { normalizeDirectorStagePacket, type AgentAction } from "@weftcanvas/contracts";

import { useCanvasStore } from "../state/canvas-store";
import { useDirectorStageLaunchStore } from "../state/director-stage-launch-store";
import { useProjectAssetStore } from "../state/project-asset-store";
import { useProjectLibraryStore } from "../state/project-library-store";
import { useThemeCommandStore } from "../state/theme-command-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import { useUiShellStore } from "../state/ui-shell-store";

const EXECUTED_RUNS_KEY = "weftcanvas:agent-action-runs:v2";

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

export function readAgentActionExecution(
  projectId: string,
  runId: string,
): AgentActionExecutionResult | null {
  const execution = readExecution(`${projectId}:${runId}`);
  return execution ? { ...execution, alreadyApplied: true } : null;
}

export function executeAgentActions(
  projectId: string,
  runId: string,
  actions: AgentAction[],
): AgentActionExecutionResult {
  const storageId = `${projectId}:${runId}`;
  if (!actions.length) return { applied: 0, skipped: 0, skippedActions: [], alreadyApplied: true };
  const previous = readExecution(storageId);
  if (previous) return { ...previous, alreadyApplied: true };

  for (const action of actions) {
    if (action.type === "canvas_director_load_packet") normalizeDirectorStagePacket(action.packet);
  }

  const canvas = useCanvasStore.getState().applyAgentActions(actions);
  const directorApplied = useDirectorStageLaunchStore.getState().runAgentActions(actions);
  const ui = applyUiActions(actions);
  const result = {
    applied: canvas.applied + directorApplied + ui.applied,
    skipped: canvas.skipped + ui.skipped,
    skippedActions: [...canvas.skippedActions, ...ui.skippedActions],
    alreadyApplied: false,
  };
  markExecuted({ id: storageId, ...result });
  return result;
}

/**
 * 面板开合/主题/配色动作的分发。这些都不进画布 undo 历史、不占画布 revision：
 * 它们只是外壳 UI 的意图，落地由各自的 store 完成。未知类型不计入。
 */
function applyUiActions(actions: AgentAction[]): {
  applied: number;
  skipped: number;
  skippedActions: Array<{ index: number; reason: string }>;
} {
  let applied = 0;
  const shell = useUiShellStore.getState();
  for (const action of actions) {
    switch (action.type) {
      case "ui_open_panel": {
        switch (action.panel) {
          case "settings":
            shell.openSettings(action.section);
            break;
          case "resource-drawer":
            shell.openResource(action.tab);
            break;
          case "asset-library":
            useProjectAssetStore.getState().setOpen(true);
            break;
          case "project-library":
            useProjectLibraryStore.getState().setOpen(true);
            break;
          case "activity":
            shell.setActivityOpen(true);
            break;
          case "shortcuts":
            shell.setShortcutsOpen(true);
            break;
        }
        applied += 1;
        break;
      }
      case "ui_close_panel": {
        switch (action.panel) {
          case "settings":
            // 「界面」已经从设置中心拆出去，关设置时两边一起收，别留下半开的面板。
            shell.closeSettings();
            shell.closeAppearance();
            break;
          case "resource-drawer":
            shell.closeResource();
            break;
          case "asset-library":
            useProjectAssetStore.getState().setOpen(false);
            break;
          case "project-library":
            useProjectLibraryStore.getState().setOpen(false);
            break;
          case "activity":
            shell.setActivityOpen(false);
            break;
          case "shortcuts":
            shell.setShortcutsOpen(false);
            break;
        }
        applied += 1;
        break;
      }
      case "ui_set_theme":
        useThemeCommandStore.getState().requestTheme(action.theme);
        applied += 1;
        break;
      case "ui_set_color_scheme":
        // 旧指令可能还带着已下线的 onyx，落库前归一成 ink，别让历史脚本失效。
        useUiPreferencesStore
          .getState()
          .setColorScheme(action.scheme === "onyx" ? "ink" : action.scheme);
        applied += 1;
        break;
      default:
        // 非 UI 动作由画布/导演台分发处理，这里既不算应用也不算跳过。
        break;
    }
  }
  return { applied, skipped: 0, skippedActions: [] };
}

function readExecution(id: string): StoredExecution | null {
  const memory = memoryRuns.get(id);
  if (memory) return memory;
  try {
    const values = JSON.parse(window.localStorage.getItem(EXECUTED_RUNS_KEY) || "[]") as unknown;
    if (!Array.isArray(values)) return null;
    const found =
      values.find(
        (value): value is StoredExecution => isStoredExecution(value) && value.id === id,
      ) ?? null;
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
      ? current.filter(
          (value): value is StoredExecution =>
            isStoredExecution(value) && value.id !== execution.id,
        )
      : [];
    window.localStorage.setItem(
      EXECUTED_RUNS_KEY,
      JSON.stringify([...values.slice(-99), execution]),
    );
  } catch {
    // In-memory deduplication still protects the current session.
  }
}

function isStoredExecution(value: unknown): value is StoredExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredExecution>;
  return (
    typeof record.id === "string" &&
    Number.isInteger(record.applied) &&
    Number.isInteger(record.skipped) &&
    Array.isArray(record.skippedActions)
  );
}
