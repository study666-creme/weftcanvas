import type { Viewport } from "@xyflow/react";
import { useEffect, useRef, type RefObject } from "react";

type TouchCanvasNavigationOptions = {
  flowShellRef: RefObject<HTMLElement | null>;
  getViewport: () => Viewport;
  setViewport: (viewport: Viewport, options?: { duration?: number }) => Promise<boolean>;
  commitViewport: (viewport: Viewport) => void;
  minZoom: number;
  maxZoom: number;
  onGestureStart?: () => void;
};

type TouchGesture = {
  touchIds: [number, number];
  flowRoot: HTMLElement;
  anchor: { x: number; y: number };
  startDistance: number;
  startZoom: number;
  lastViewport: Viewport;
  frame: number | null;
};

export function useTouchCanvasNavigation({
  flowShellRef,
  getViewport,
  setViewport,
  commitViewport,
  minZoom,
  maxZoom,
  onGestureStart,
}: TouchCanvasNavigationOptions) {
  const gestureRef = useRef<TouchGesture | null>(null);
  const primaryPointerIsCoarse = typeof window !== "undefined"
    && window.matchMedia("(pointer: coarse)").matches;

  useEffect(() => {
    const shell = flowShellRef.current;
    if (!shell) return;
    const activeTouchPointers = new Set<number>();

    const applyViewport = () => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gesture.frame = null;
      void setViewport(gesture.lastViewport, { duration: 0 });
    };

    const scheduleViewport = () => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.frame !== null) return;
      gesture.frame = window.requestAnimationFrame(applyViewport);
    };

    const beginGesture = (event: TouchEvent) => {
      const flowRoot = shell.querySelector<HTMLElement>(".react-flow");
      if (!flowRoot) return false;
      const touches = touchesInside(event.touches, flowRoot);
      if (touches.length < 2) return false;

      const first = touches[0]!;
      const second = touches[1]!;
      const bounds = flowRoot.getBoundingClientRect();
      const center = touchCenter(first, second, bounds);
      const distance = touchDistance(first, second);
      if (distance < 8) return false;

      finishActiveNodeTouchDrag(flowRoot, event.touches);
      const viewport = getViewport();
      gestureRef.current = {
        touchIds: [first.identifier, second.identifier],
        flowRoot,
        anchor: {
          x: (center.x - viewport.x) / viewport.zoom,
          y: (center.y - viewport.y) / viewport.zoom,
        },
        startDistance: distance,
        startZoom: viewport.zoom,
        lastViewport: viewport,
        frame: null,
      };
      onGestureStart?.();
      return true;
    };

    const finishGesture = () => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (gesture.frame !== null) window.cancelAnimationFrame(gesture.frame);
      void setViewport(gesture.lastViewport, { duration: 0 });
      commitViewport(gesture.lastViewport);
      gestureRef.current = null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (gestureRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!beginGesture(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!gestureRef.current && !beginGesture(event)) return;
      const gesture = gestureRef.current;
      if (!gesture) return;

      event.preventDefault();
      event.stopPropagation();

      const first = touchById(event.touches, gesture.touchIds[0]);
      const second = touchById(event.touches, gesture.touchIds[1]);
      if (!first || !second) return;

      const bounds = gesture.flowRoot.getBoundingClientRect();
      const center = touchCenter(first, second, bounds);
      const scale = touchDistance(first, second) / gesture.startDistance;
      const zoom = clamp(gesture.startZoom * scale, minZoom, maxZoom);
      gesture.lastViewport = {
        x: center.x - gesture.anchor.x * zoom,
        y: center.y - gesture.anchor.y * zoom,
        zoom,
      };
      scheduleViewport();
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.touchIds.some((identifier) => touchById(event.touches, identifier))) return;
      event.preventDefault();
      finishGesture();
    };

    const handleTouchCancel = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.touchIds.some((identifier) => touchById(event.touches, identifier))) return;
      finishGesture();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const flowRoot = shell.querySelector<HTMLElement>(".react-flow");
      if (!flowRoot || !(event.target instanceof Node) || !flowRoot.contains(event.target)) return;

      activeTouchPointers.add(event.pointerId);
      const pane = flowRoot.querySelector<HTMLElement>(".react-flow__pane");
      if (activeTouchPointers.size > 1 || event.target === pane) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerType === "touch") activeTouchPointers.delete(event.pointerId);
    };

    shell.addEventListener("pointerdown", handlePointerDown, { capture: true });
    shell.addEventListener("touchstart", handleTouchStart, { capture: true, passive: false });
    shell.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    shell.addEventListener("touchend", handleTouchEnd, { capture: true, passive: false });
    shell.addEventListener("touchcancel", handleTouchCancel, { capture: true, passive: false });
    window.addEventListener("pointerup", handlePointerEnd, { capture: true });
    window.addEventListener("pointercancel", handlePointerEnd, { capture: true });
    return () => {
      shell.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      shell.removeEventListener("touchstart", handleTouchStart, { capture: true });
      shell.removeEventListener("touchmove", handleTouchMove, { capture: true });
      shell.removeEventListener("touchend", handleTouchEnd, { capture: true });
      shell.removeEventListener("touchcancel", handleTouchCancel, { capture: true });
      window.removeEventListener("pointerup", handlePointerEnd, { capture: true });
      window.removeEventListener("pointercancel", handlePointerEnd, { capture: true });
      const gesture = gestureRef.current;
      if (gesture) {
        if (gesture.frame !== null) window.cancelAnimationFrame(gesture.frame);
        commitViewport(gesture.lastViewport);
      }
      activeTouchPointers.clear();
      gestureRef.current = null;
    };
  }, [commitViewport, flowShellRef, getViewport, maxZoom, minZoom, onGestureStart, setViewport]);

  return primaryPointerIsCoarse;
}

function touchesInside(touches: TouchList, shell: HTMLElement) {
  return Array.from(touches).filter((touch) => touch.target instanceof Node && shell.contains(touch.target));
}

function touchById(touches: TouchList, identifier: number) {
  return Array.from(touches).find((touch) => touch.identifier === identifier) ?? null;
}

function touchCenter(first: Touch, second: Touch, bounds: DOMRect) {
  return {
    x: (first.clientX + second.clientX) / 2 - bounds.left,
    y: (first.clientY + second.clientY) / 2 - bounds.top,
  };
}

function touchDistance(first: Touch, second: Touch) {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function finishActiveNodeTouchDrag(flowRoot: HTMLElement, touches: TouchList) {
  const draggingNode = flowRoot.querySelector<HTMLElement>(".react-flow__node.dragging");
  if (!draggingNode) return;

  const activeTouches = Array.from(touches);
  const draggedTouch = activeTouches.find((touch) => (
    touch.target instanceof Node && draggingNode.contains(touch.target)
  ));
  if (!draggedTouch) return;

  const remainingTouches = activeTouches.filter((touch) => touch.identifier !== draggedTouch.identifier);
  draggedTouch.target.dispatchEvent(new TouchEvent("touchend", {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    touches: remainingTouches,
    targetTouches: remainingTouches,
    changedTouches: [draggedTouch],
  }));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
