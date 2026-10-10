import { useStoreApi } from "@xyflow/react";
import { memo, useLayoutEffect, useRef } from "react";

import { observeWorkspaceGestureEnd, workspaceIsMoving } from "../lib/canvas-gesture";

type ViewportLike = {
  x: number;
  y: number;
  zoom: number;
};

type StarfieldDepth = "far" | "mid" | "near";
type StarfieldLayerMetric = ReturnType<typeof layerMetrics>;
const starfieldDepths: readonly StarfieldDepth[] = ["far", "mid", "near"];

const starfieldLayerSettings: Record<StarfieldDepth, { size: number; parallax: number }> = {
  far: { size: 173, parallax: 0.12 },
  mid: { size: 307, parallax: 0.32 },
  near: { size: 487, parallax: 0.62 },
};

export const CanvasStarfield = memo(function CanvasStarfield() {
  const store = useStoreApi();
  const farRef = useRef<HTMLSpanElement>(null);
  const midRef = useRef<HTMLSpanElement>(null);
  const nearRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const layers: Record<StarfieldDepth, HTMLSpanElement | null> = {
      far: farRef.current,
      mid: midRef.current,
      near: nearRef.current,
    };
    const applied = new Map<StarfieldDepth, StarfieldLayerPresentation>();
    let latestViewport = viewportFromTransform(store.getState().transform);
    let frameId: number | null = null;
    let pageVisible = document.visibilityState === "visible";

    const renderViewport = () => {
      frameId = null;
      const metrics = getStarfieldMetrics(latestViewport);
      for (const depth of starfieldDepths) {
        const layer = layers[depth];
        if (!layer) continue;
        const presentation = getStarfieldLayerPresentation(metrics[depth]);
        const previous = applied.get(depth);
        if (presentation.transform !== previous?.transform) layer.style.transform = presentation.transform;
        applied.set(depth, presentation);
      }
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
      // Skip the repaint while the viewport is actively moving: the canvas is
      // already covered by the is-viewport-moving degradation, so we only paint
      // once the move settles instead of competing with the pan gesture.
      if (workspaceIsMoving()) return;
      if (pageVisible && frameId === null) frameId = window.requestAnimationFrame(renderViewport);
    });

    // 手势结束不再有 transform 事件：补画一次，否则星空会停在手势开始的位置。
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
    <div className="kc-canvas-starfield" data-testid="canvas-starfield" aria-hidden="true">
      <span ref={farRef} className="kc-canvas-starfield-layer is-far" data-depth="far" />
      <span ref={midRef} className="kc-canvas-starfield-layer is-mid" data-depth="mid" />
      <span ref={nearRef} className="kc-canvas-starfield-layer is-near" data-depth="near" />
      <span className="kc-canvas-starfield-dust" />
    </div>
  );
});

export function getStarfieldMetrics(viewport: ViewportLike) {
  const x = Number.isFinite(viewport.x) ? viewport.x : 0;
  const y = Number.isFinite(viewport.y) ? viewport.y : 0;

  // Fixed, mutually unrelated periods keep zoom on the compositor path. A
  // changing background-size would rerasterize all gradient layers per frame.
  const far = starfieldLayerSettings.far;
  const mid = starfieldLayerSettings.mid;
  const near = starfieldLayerSettings.near;

  return {
    far: layerMetrics(x, y, far.size, far.parallax),
    mid: layerMetrics(x, y, mid.size, mid.parallax),
    near: layerMetrics(x, y, near.size, near.parallax),
  };
}

type StarfieldLayerPresentation = {
  transform: string;
};

export function getStarfieldLayerPresentation(metric: StarfieldLayerMetric): StarfieldLayerPresentation {
  return {
    transform: `translate3d(${metric.x}px, ${metric.y}px, 0)`,
  };
}

function viewportFromTransform(transform: readonly [number, number, number]): ViewportLike {
  return { x: transform[0], y: transform[1], zoom: transform[2] };
}

function layerMetrics(x: number, y: number, size: number, parallax: number) {
  return {
    size,
    x: roundToThree(centeredModulo(x * parallax, size)),
    y: roundToThree(centeredModulo(y * parallax, size)),
  };
}

function centeredModulo(value: number, divisor: number) {
  return ((value + divisor / 2) % divisor + divisor) % divisor - divisor / 2;
}

function roundToThree(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
