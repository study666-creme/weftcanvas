import { useEffect, useRef, type RefObject } from "react";

import { shouldIgnoreCanvasCommand } from "../lib/canvas-command-target";

/**
 * Space-pan companion for XYFlow's native `panActivationKeyCode="Space"`.
 *
 * XYFlow already switches its pane into pan mode internally while Space is
 * held (see the FlowRenderer `panActivationKeyPressed` path), so this hook
 * must NOT publish React state: a setState here would re-render the whole
 * CanvasWorkspace / ReactFlow tree on every key press and release. It only
 * mirrors the same key state onto the workspace class for the cursor and
 * pointer-events styling.
 *
 * The workspace class is also observed by this hook so a React re-render that
 * rewrites the className while Space is still held cannot drop the space-pan
 * mode. The re-assertion is guarded by a `contains` check: observing an
 * element and then writing its own class unconditionally from the observer
 * callback re-triggers the observer in Chromium (each `classList.add` records
 * a mutation even for an already-present token), which would busy-loop.
 */
export function useSpacePan(targetRef: RefObject<HTMLElement | null>) {
  const spaceDownRef = useRef(false);

  useEffect(() => {
    const syncClass = () => {
      targetRef.current?.classList.toggle("is-space-pan", spaceDownRef.current);
    };
    const release = () => {
      spaceDownRef.current = false;
      syncClass();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || shouldIgnoreCanvasCommand(event.target)) return;
      event.preventDefault();
      spaceDownRef.current = true;
      syncClass();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") release();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") release();
    };

    let observer: MutationObserver | null = null;
    const workspace = targetRef.current;
    if (workspace && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        if (spaceDownRef.current && !workspace.classList.contains("is-space-pan")) {
          workspace.classList.add("is-space-pan");
        }
      });
      observer.observe(workspace, { attributes: true, attributeFilter: ["class"] });
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", release);
    window.addEventListener("pointercancel", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", release);
      window.removeEventListener("pointercancel", release);
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
      if (spaceDownRef.current) {
        spaceDownRef.current = false;
        workspace?.classList.remove("is-space-pan");
      }
    };
  }, [targetRef]);

  return null;
}
