import { Hand, HandGrab } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useUiPreferencesStore } from "../state/ui-preferences-store";

type CursorMode = "default" | "link" | "drag" | "pan" | "text" | "native";

const DRAG_TARGETS = [
  "[data-kc-cursor='drag']",
  ".kc-node-drag-strip",
  ".kc-node-type-label",
  ".kc-node-text-preview",
  ".kc-media-empty--passive",
  ".kc-node-media-frame",
  ".kc-audio-wave",
  ".kc-group-frame-header",
  ".kc-director-canvas",
  "input[type='range']",
  "[class*='cursor-grab']",
  "[class*='cursor-grabbing']",
  "[class*='cursor-move']",
  "[class*='cursor-crosshair']",
  "[class*='cursor-ew-resize']",
  "[class*='cursor-ns-resize']",
  "[class*='cursor-col-resize']",
  "[class*='cursor-row-resize']",
  "[class*='cursor-nwse-resize']",
  "[class*='cursor-nesw-resize']",
].join(",");

const LINK_TARGETS = [
  "button:not(:disabled)",
  "a[href]",
  "summary",
  "select:not(:disabled)",
  "[role='button']:not([aria-disabled='true'])",
  ".react-flow__handle",
  "[data-canvas-interactive]",
].join(",");

function cursorModeFromTarget(target: EventTarget | null): CursorMode {
  if (!(target instanceof Element)) return "default";
  if (target.closest("audio, [data-kc-native-cursor]")) return "native";
  if (target.closest("input:not([type='range']):not([type='checkbox']):not([type='radio']), textarea, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return "text";
  const label = target.closest("label");
  if (label?.querySelector("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")) return "link";
  if (target.closest(LINK_TARGETS)) return "link";
  if (target.closest(DRAG_TARGETS)) return "drag";
  return "default";
}

function applyMode(root: HTMLElement, mode: CursorMode) {
  for (const name of ["link", "drag", "pan", "text", "native"]) {
    root.classList.toggle(`is-${name}`, mode === name);
  }
}

function isFinePointerEvent(event: PointerEvent) {
  return !event.pointerType || event.pointerType === "mouse" || event.pointerType === "pen";
}

export const AppCursor = memo(function AppCursor({ panActive }: { panActive: boolean }) {
  const cursorStyle = useUiPreferencesStore((state) => state.cursorStyle);
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const panActiveRef = useRef(panActive);
  const syncModeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    panActiveRef.current = panActive;
    syncModeRef.current?.();
  }, [panActive]);

  useEffect(() => {
    const root = rootRef.current;
    const pointer = pointerRef.current;
    if (!root || !pointer) return;

    document.documentElement.classList.add("has-kc-cursor");
    let lastTarget: EventTarget | null = null;
    let currentMode: CursorMode = "default";
    let pointerDown = false;
    let pointerInsideCanvas = false;
    let visible = false;

    const show = () => {
      if (visible) return;
      visible = true;
      root.classList.add("is-visible");
    };
    const hide = () => {
      if (!visible) return;
      visible = false;
      root.classList.remove("is-visible");
    };
    const setMode = (mode: CursorMode) => {
      if (mode === currentMode) return;
      currentMode = mode;
      applyMode(root, mode);
    };
    const syncMode = () => {
      const panning = panActiveRef.current && pointerInsideCanvas;
      setMode(panning ? "pan" : cursorModeFromTarget(lastTarget));
      root.classList.toggle("is-pan-grabbing", panning && pointerDown);
    };
    syncModeRef.current = syncMode;

    const applyPosition = (event: PointerEvent) => {
      const samples = event.getCoalescedEvents?.() ?? [];
      const latest = samples.at(-1) ?? event;
      pointer.style.transform = `translate3d(${latest.clientX - 4}px, ${latest.clientY - 3}px, 0)`;
    };

    const move = (event: PointerEvent) => {
      if (!isFinePointerEvent(event)) return;
      applyPosition(event);
      if (lastTarget !== event.target) {
        const nextInsideCanvas = event.target instanceof Element && Boolean(event.target.closest(".react-flow"));
        if (!pointerDown || nextInsideCanvas) pointerInsideCanvas = nextInsideCanvas;
        lastTarget = event.target;
        syncMode();
      }
      show();
    };
    const down = (event: PointerEvent) => {
      if (!isFinePointerEvent(event)) return;
      lastTarget = event.target;
      pointerInsideCanvas = event.target instanceof Element && Boolean(event.target.closest(".react-flow"));
      pointerDown = true;
      root.classList.add("is-down");
      syncMode();
      show();
    };
    const release = (event?: PointerEvent) => {
      if (event && !isFinePointerEvent(event)) return;
      if (event) lastTarget = event.target;
      if (event) pointerInsideCanvas = event.target instanceof Element && Boolean(event.target.closest(".react-flow"));
      pointerDown = false;
      root.classList.remove("is-down", "is-pan-grabbing");
      syncMode();
    };
    const reset = () => {
      release();
      hide();
    };
    const visibilityChanged = () => {
      if (document.visibilityState !== "visible") reset();
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointerup", release, { passive: true });
    window.addEventListener("pointercancel", release, { passive: true });
    window.addEventListener("blur", reset);
    document.addEventListener("mouseleave", hide);
    document.addEventListener("mouseenter", show);
    document.addEventListener("visibilitychange", visibilityChanged);

    return () => {
      syncModeRef.current = null;
      document.documentElement.classList.remove("has-kc-cursor");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", reset);
      document.removeEventListener("mouseleave", hide);
      document.removeEventListener("mouseenter", show);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  return createPortal(
    <div ref={rootRef} className={`kc-app-cursor kc-app-cursor--${cursorStyle}`} data-testid="app-cursor" aria-hidden="true">
      <div ref={pointerRef} className="kc-app-cursor-pointer">
        <svg className="kc-app-cursor-arrow" viewBox="0 0 28 32" focusable="false">
          <path className="kc-app-cursor-arrow-shell" d="M4.3 3.1 23.2 18.4l-8.1 1.1-4.4 8.8L4.3 3.1Z" />
          <path className="kc-app-cursor-arrow-core" d="M6.9 8.1 18 17.1l-5.1.7-2.8 5.7L6.9 8.1Z" />
        </svg>
        <Hand className="kc-app-cursor-hand kc-app-cursor-hand--classic" strokeWidth={1.9} />
        <HandGrab className="kc-app-cursor-hand kc-app-cursor-hand--precision" strokeWidth={1.8} />
        <span className="kc-app-cursor-textbar" />
        <span className="kc-app-cursor-precision" />
      </div>
    </div>,
    document.body,
  );
});
