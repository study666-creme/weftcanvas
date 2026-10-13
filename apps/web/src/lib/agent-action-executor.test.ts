import { afterEach, describe, expect, it } from "vitest";

import { executeAgentActions } from "./agent-action-executor";
import type { AgentAction } from "@weftcanvas/contracts";
import { useProjectAssetStore } from "../state/project-asset-store";
import { useProjectLibraryStore } from "../state/project-library-store";
import { useThemeCommandStore } from "../state/theme-command-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import { useUiShellStore } from "../state/ui-shell-store";

afterEach(() => {
  useUiShellStore.setState({
    settingsOpen: false,
    settingsSection: "ui",
    resourceOpen: false,
    resourceTab: "assets",
    activityOpen: false,
    shortcutsOpen: false,
  });
  useProjectAssetStore.getState().setOpen(false);
  useProjectLibraryStore.getState().setOpen(false);
  useThemeCommandStore.setState({ command: null });
});

let runCounter = 0;
function nextRun() {
  runCounter += 1;
  return { projectId: "project-1", runId: `run-${Date.now()}-${runCounter}` };
}

describe("agent UI actions", () => {
  it("opens the settings panel on a specific section", () => {
    const { projectId, runId } = nextRun();
    const actions: AgentAction[] = [
      { type: "ui_open_panel", panel: "settings", section: "plugins" },
    ];
    const result = executeAgentActions(projectId, runId, actions);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(useUiShellStore.getState().settingsOpen).toBe(true);
    expect(useUiShellStore.getState().settingsSection).toBe("plugins");
  });

  it("opens the resource drawer on the cards tab", () => {
    const { projectId, runId } = nextRun();
    executeAgentActions(projectId, runId, [
      { type: "ui_open_panel", panel: "resource-drawer", tab: "cards" },
    ]);
    expect(useUiShellStore.getState().resourceOpen).toBe(true);
    expect(useUiShellStore.getState().resourceTab).toBe("cards");
  });

  it("opens and closes the asset and project libraries", () => {
    const open = nextRun();
    executeAgentActions(open.projectId, open.runId, [
      { type: "ui_open_panel", panel: "asset-library" },
      { type: "ui_open_panel", panel: "project-library" },
    ]);
    expect(useProjectAssetStore.getState().open).toBe(true);
    expect(useProjectLibraryStore.getState().open).toBe(true);

    const close = nextRun();
    executeAgentActions(close.projectId, close.runId, [
      { type: "ui_close_panel", panel: "asset-library" },
      { type: "ui_close_panel", panel: "project-library" },
    ]);
    expect(useProjectAssetStore.getState().open).toBe(false);
    expect(useProjectLibraryStore.getState().open).toBe(false);
  });

  it("routes theme and color-scheme intents to their stores", () => {
    const { projectId, runId } = nextRun();
    executeAgentActions(projectId, runId, [
      { type: "ui_set_theme", theme: "dark" },
      { type: "ui_set_color_scheme", scheme: "ink" },
    ]);
    expect(useThemeCommandStore.getState().command?.action).toBe("dark");
    expect(useUiPreferencesStore.getState().colorScheme).toBe("ink");
  });

  it("does not re-run a previously executed action set", () => {
    const { projectId, runId } = nextRun();
    const actions: AgentAction[] = [{ type: "ui_open_panel", panel: "shortcuts" }];
    const first = executeAgentActions(projectId, runId, actions);
    expect(first.alreadyApplied).toBe(false);
    useUiShellStore.setState({ shortcutsOpen: false });
    const second = executeAgentActions(projectId, runId, actions);
    expect(second.alreadyApplied).toBe(true);
    // 重放被去重拦下，面板不会被再次打开。
    expect(useUiShellStore.getState().shortcutsOpen).toBe(false);
  });

  it("counts only the UI action applied for the activity panel", () => {
    const { projectId, runId } = nextRun();
    const result = executeAgentActions(projectId, runId, [
      { type: "ui_open_panel", panel: "activity" },
    ]);
    expect(result.applied).toBe(1);
    expect(useUiShellStore.getState().activityOpen).toBe(true);
  });
});
