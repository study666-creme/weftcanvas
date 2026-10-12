import { useStoreApi } from "@xyflow/react";
import { useCallback, useLayoutEffect, type RefObject } from "react";

export function useHorizontalViewportClamp(
  ref: RefObject<HTMLElement | null>,
  cssVariable: `--${string}`,
  enabled = true,
  margin = 12,
  verticalCssVariable?: `--${string}`,
) {
  const flowStore = useStoreApi();

  const clampToViewport = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.setProperty(cssVariable, "0px");
    if (verticalCssVariable) element.style.setProperty(verticalCssVariable, "0px");
    const rect = element.getBoundingClientRect();
    const horizontalShift =
      rect.left < margin
        ? margin - rect.left
        : rect.right > window.innerWidth - margin
          ? window.innerWidth - margin - rect.right
          : 0;
    const scale = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
    element.style.setProperty(
      cssVariable,
      `${Math.round(horizontalShift / Math.max(scale, 0.01))}px`,
    );
    if (verticalCssVariable) {
      const verticalShift =
        rect.top < margin
          ? margin - rect.top
          : rect.bottom > window.innerHeight - margin
            ? window.innerHeight - margin - rect.bottom
            : 0;
      element.style.setProperty(
        verticalCssVariable,
        `${Math.round(verticalShift / Math.max(scale, 0.01))}px`,
      );
    }
  }, [cssVariable, margin, ref, verticalCssVariable]);

  useLayoutEffect(() => {
    if (!enabled) return;
    let frame = window.requestAnimationFrame(clampToViewport);
    const scheduleClamp = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(clampToViewport);
    };
    let viewportTimer = 0;
    const scheduleAfterViewportMove = () => {
      window.clearTimeout(viewportTimer);
      viewportTimer = window.setTimeout(scheduleClamp, 90);
    };
    let positionTimer = 0;
    const scheduleAfterPositionMove = () => {
      window.clearTimeout(positionTimer);
      positionTimer = window.setTimeout(scheduleClamp, 60);
    };
    const unsubscribe = flowStore.subscribe((state, previous) => {
      if (state.transform !== previous.transform) scheduleAfterViewportMove();
    });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleClamp);
    if (ref.current) observer?.observe(ref.current);
    const positioningElement = ref.current?.closest(".react-flow__node, .react-flow__node-toolbar");
    const positionObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleAfterPositionMove);
    if (positioningElement) {
      positionObserver?.observe(positioningElement, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }
    window.addEventListener("resize", scheduleClamp);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(viewportTimer);
      window.clearTimeout(positionTimer);
      unsubscribe();
      observer?.disconnect();
      positionObserver?.disconnect();
      window.removeEventListener("resize", scheduleClamp);
    };
  }, [clampToViewport, enabled, flowStore, ref]);
}
