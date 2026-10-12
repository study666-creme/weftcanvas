import { useStoreApi } from "@xyflow/react";
import { memo, useLayoutEffect, useRef } from "react";

import { observeWorkspaceGestureEnd, workspaceIsMoving } from "../lib/canvas-gesture";

const BASE_GRID_SIZE = 48;
const MIN_GRID_SIZE = 8;
const MAX_GRID_SIZE = 192;

type ViewportLike = {
  x: number;
  y: number;
  zoom: number;
};

export const CanvasZoomDotGrid = memo(function CanvasZoomDotGrid() {
  const store = useStoreApi();
  const gridRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    let latestViewport = viewportFromTransform(store.getState().transform);
    let frameId: number | null = null;
    let applied: ReturnType<typeof getZoomDotGridPresentation> | null = null;

    const renderViewport = () => {
      frameId = null;
      const presentation = getZoomDotGridPresentation(getZoomDotGridMetrics(latestViewport));
      if (presentation.size !== applied?.size)
        grid.style.setProperty("--wc-zoom-dot-grid-size", presentation.size);
      if (presentation.halfSize !== applied?.halfSize)
        grid.style.setProperty("--wc-zoom-dot-grid-half-size", presentation.halfSize);
      if (presentation.x !== applied?.x)
        grid.style.setProperty("--wc-zoom-dot-grid-x", presentation.x);
      if (presentation.y !== applied?.y)
        grid.style.setProperty("--wc-zoom-dot-grid-y", presentation.y);
      applied = presentation;
    };

    renderViewport();
    const unsubscribe = store.subscribe((state, previousState) => {
      const nextTransform = state.transform;
      const previousTransform = previousState.transform;
      if (
        nextTransform[0] === previousTransform[0] &&
        nextTransform[1] === previousTransform[1] &&
        nextTransform[2] === previousTransform[2]
      )
        return;

      latestViewport = viewportFromTransform(nextTransform);
      if (workspaceIsMoving()) return;
      if (frameId === null) frameId = window.requestAnimationFrame(renderViewport);
    });

    // 手势结束不再有 transform 事件：补画一次，否则缩放后点阵间距会停在旧值。
    const stopGestureObserver = observeWorkspaceGestureEnd(() => {
      latestViewport = viewportFromTransform(store.getState().transform);
      if (frameId === null) frameId = window.requestAnimationFrame(renderViewport);
    });

    return () => {
      unsubscribe();
      stopGestureObserver();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [store]);

  return (
    <div
      ref={gridRef}
      className="wc-canvas-zoom-dot-grid"
      data-testid="canvas-zoom-dot-grid"
      aria-hidden="true"
    />
  );
});

function getZoomDotGridPresentation(metrics: ReturnType<typeof getZoomDotGridMetrics>) {
  return {
    size: `${metrics.size}px`,
    halfSize: `${metrics.halfSize}px`,
    x: `${metrics.x}px`,
    y: `${metrics.y}px`,
  };
}

function viewportFromTransform(transform: readonly [number, number, number]): ViewportLike {
  return { x: transform[0], y: transform[1], zoom: transform[2] };
}

export function getZoomDotGridMetrics(viewport: ViewportLike) {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const x = Number.isFinite(viewport.x) ? viewport.x : 0;
  const y = Number.isFinite(viewport.y) ? viewport.y : 0;
  const size = roundToThree(
    Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, BASE_GRID_SIZE * zoom)),
  );

  return {
    size,
    halfSize: roundToThree(size / 2),
    x: roundToThree(positiveModulo(x, size)),
    y: roundToThree(positiveModulo(y, size)),
  };
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function roundToThree(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
