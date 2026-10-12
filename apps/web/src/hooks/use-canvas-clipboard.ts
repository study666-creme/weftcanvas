import type { XYPosition } from "@xyflow/react";
import { useEffect } from "react";

import {
  WEFTCANVAS_CANVAS_CLIPBOARD_MIME,
  WEFTCANVAS_CANVAS_CLIPBOARD_TEXT,
  parseCanvasClipboard,
  serializeCanvasClipboard,
} from "../lib/canvas-clipboard";
import { shouldIgnoreCanvasCommand } from "../lib/canvas-command-target";
import { useCanvasStore } from "../state/canvas-store";
import type { GraphSnapshot } from "../types";

type CanvasClipboardOptions = {
  getAnchor: () => XYPosition;
  onPasteFiles: (files: File[], anchor: XYPosition) => void | Promise<void>;
  onPasteText: (text: string, anchor: XYPosition) => void;
};

export function useCanvasClipboard({
  getAnchor,
  onPasteFiles,
  onPasteText,
}: CanvasClipboardOptions) {
  useEffect(() => {
    const writeSelection = (event: ClipboardEvent) => {
      if (
        shouldIgnoreCanvasCommand(event.target) ||
        hasNativeTextSelection() ||
        !event.clipboardData
      )
        return false;
      const store = useCanvasStore.getState();
      if (!store.nodes.some((node) => node.selected)) return false;
      store.copySelection();
      const snapshot = useCanvasStore.getState().clipboard;
      if (!snapshot?.nodes.length) return false;
      event.clipboardData.setData(
        WEFTCANVAS_CANVAS_CLIPBOARD_MIME,
        serializeCanvasClipboard(snapshot),
      );
      event.clipboardData.setData("text/plain", WEFTCANVAS_CANVAS_CLIPBOARD_TEXT);
      event.preventDefault();
      return true;
    };

    const onCopy = (event: ClipboardEvent) => {
      writeSelection(event);
    };
    const onCut = (event: ClipboardEvent) => {
      if (writeSelection(event)) useCanvasStore.getState().deleteSelection();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (shouldIgnoreCanvasCommand(event.target) || !event.clipboardData) return;
      const anchor = getAnchor();
      const encoded = event.clipboardData.getData(WEFTCANVAS_CANVAS_CLIPBOARD_MIME);
      const graph = parseCanvasClipboard(encoded);
      if (graph) {
        event.preventDefault();
        useCanvasStore.getState().pasteSelection(anchor, graph);
        return;
      }
      const files = collectClipboardFiles(event.clipboardData);
      if (files.length) {
        event.preventDefault();
        void onPasteFiles(files, anchor);
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      if (text && text !== WEFTCANVAS_CANVAS_CLIPBOARD_TEXT) {
        event.preventDefault();
        onPasteText(text, anchor);
        return;
      }
      const snapshot = useCanvasStore.getState().clipboard;
      if (snapshot?.nodes.length) {
        event.preventDefault();
        useCanvasStore.getState().pasteSelection(anchor, snapshot as GraphSnapshot);
      }
    };

    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
      window.removeEventListener("paste", onPaste);
    };
  }, [getAnchor, onPasteFiles, onPasteText]);
}

function hasNativeTextSelection() {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString());
}

function collectClipboardFiles(data: DataTransfer) {
  const files = Array.from(data.files);
  if (files.length) return files;
  return Array.from(data.items).flatMap((item) =>
    item.kind === "file" ? (item.getAsFile() ?? []) : [],
  );
}
