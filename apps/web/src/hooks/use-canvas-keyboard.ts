import { useEffect } from "react";

import { isEditableTarget, shouldIgnoreCanvasCommand } from "../lib/canvas-command-target";
import { useCanvasStore } from "../state/canvas-store";

export function useCanvasKeyboard() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
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
