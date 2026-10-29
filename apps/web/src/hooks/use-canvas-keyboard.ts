import { useEffect } from "react";

import { isEditableTarget, shouldIgnoreCanvasCommand } from "../lib/canvas-command-target";
import { useCanvasStore } from "../state/canvas-store";
import { useProjectAssetStore } from "../state/project-asset-store";
import { useUiShellStore } from "../state/ui-shell-store";

export function useCanvasKeyboard() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      // 资产库快捷键在面板内部也要生效（按一次收起），所以不能走
      // shouldIgnoreCanvasCommand——它会把焦点在抽屉按钮上的组合键全部吞掉。
      // 只避开输入框和真正的模态对话框。
      if (command && key === "k" && !event.altKey) {
        if (isEditableTarget(event.target) || document.querySelector("[aria-modal='true']")) return;
        event.preventDefault();
        if (event.shiftKey) {
          useProjectAssetStore.getState().toggle();
        } else {
          const shell = useUiShellStore.getState();
          if (shell.resourceOpen) shell.closeResource();
          else shell.openResource();
        }
        return;
      }
      const historyCommand = command && (key === "z" || key === "y");
      if (historyCommand) {
        if (isEditableTarget(event.target) || document.querySelector("[aria-modal='true']")) return;
      } else if (shouldIgnoreCanvasCommand(event.target)) {
        return;
      }
      const store = useCanvasStore.getState();

      if (command && key === "z") {
        event.preventDefault();
        event.shiftKey ? store.redo() : store.undo();
      } else if (command && key === "y") {
        event.preventDefault();
        store.redo();
      } else if (command && key === "a") {
        event.preventDefault();
        store.selectAll();
      } else if (command && key === "d") {
        event.preventDefault();
        store.duplicateSelection();
      } else if (command && key === "g") {
        event.preventDefault();
        event.shiftKey ? store.ungroupSelection() : store.groupSelection();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        store.deleteSelection();
      } else if (event.key === "Escape") {
        store.clearSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
