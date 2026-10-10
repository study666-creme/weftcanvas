import { useStoreApi } from "@xyflow/react";
import { memo, useLayoutEffect, useRef } from "react";

import { observeWorkspaceGestureEnd, workspaceIsMoving } from "../lib/canvas-gesture";

type ViewportLike = {
  x: number;
  y: number;
};

export const CanvasWaterSurface = memo(function CanvasWaterSurface() {
  const store = useStoreApi();
  const materialRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const material = materialRef.current;
    if (!material) return;

    let appliedTransform = "";
    const originViewport = viewportFromTransform(store.getState().transform);
    let latestViewport = originViewport;
    let frameId: number | null = null;
    let pageVisible = document.visibilityState === "visible";

    const renderViewport = () => {
      frameId = null;
      const transform = getWaterMaterialTransform(getWaterSurfaceOffset(latestViewport, originViewport));
      if (transform === appliedTransform) return;
      material.style.transform = transform;
      appliedTransform = transform;
    };

    renderViewport();
    const unsubscribe = store.subscribe((state, previousState) => {
      const nextTransform = state.transform;
      const previousTransform = previousState.transform;
      if (
        nextTransform[0] === previousTransform[0]
        && nextTransform[1] === previousTransform[1]
      ) return;

      latestViewport = viewportFromTransform(nextTransform);
      if (workspaceIsMoving()) return;
      if (pageVisible && frameId === null) frameId = window.requestAnimationFrame(renderViewport);
    });

    // 手势结束不再有 transform 事件：此时按最新视口补画一次，否则水面会停在
    // 手势开始时的偏移上。
    const stopGestureObserver = observeWorkspaceGestureEnd(() => {
      latestViewport = viewportFromTransform(store.getState().transform);
      if (pageVisible && frameId === null) frameId = window.requestAnimationFrame(renderViewport);
    });

    const handleVisibilityChange = () => {
      pageVisible = document.visibilityState === "visible";
      if (!pageVisible) {
        if (frameId !== null) window.cancelAnimationFrame(frameId);
        frameId = null;
        return;
      }
      latestViewport = viewportFromTransform(store.getState().transform);
      if (frameId === null) frameId = window.requestAnimationFrame(renderViewport);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribe();
      stopGestureObserver();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [store]);

  return (
    <div className="kc-canvas-water" data-testid="canvas-water-surface" aria-hidden="true">
      <span ref={materialRef} className="kc-canvas-water-material" />
    </div>
  );
});

export function getWaterSurfaceOffset(viewport: ViewportLike, origin: ViewportLike = { x: 0, y: 0 }) {
  const x = finiteCoordinate(viewport.x) - finiteCoordinate(origin.x);
  const y = finiteCoordinate(viewport.y) - finiteCoordinate(origin.y);

  return {
    x: roundToThree(Math.tanh(x / 360) * 32),
    y: roundToThree(Math.tanh(y / 360) * 22),
  };
}

function finiteCoordinate(value: number) {
  return Number.isFinite(value) ? value : 0;
}

export function getWaterMaterialTransform(offset: ReturnType<typeof getWaterSurfaceOffset>) {
  return `translate3d(${offset.x}px, ${offset.y}px, 0)`;
}

function viewportFromTransform(transform: readonly [number, number, number]): ViewportLike {
  return { x: transform[0], y: transform[1] };
}

function roundToThree(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
