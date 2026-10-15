import { useStoreApi } from "@xyflow/react";
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

// 覆层上沿停留着画布伙伴（whale girl）：翻到节点上方时必须给她留出身位，
// 否则她会被挤到覆层下沿去。常量与倾身几何一起放在 companion-placement。
import { LEDGE_PERCH_ROOM } from "../components/companion-placement";

const VIEWPORT_MARGIN = 16;
const NODE_GAP = 14;
const FLOATING_CONTROL_GAP = 20;
const PROMPT_MIN_WIDTH = 420;
const PROMPT_MAX_WIDTH = 700;
const GENERATION_PROMPT_MIN_WIDTH = 820;
const GENERATION_PROMPT_MAX_WIDTH = 900;
const PROMPT_MAX_HEIGHT = 248;
const PROMPT_MIN_HEIGHT = 168;
const CONFIG_MAX_WIDTH = 760;
const MIN_OVERLAY_WIDTH = 320;
// 移动结束后才做一次完整同步布局测量；tile 内的纯平移只跟随上次测量。
const OVERLAY_FULL_MEASURE_SETTLE_MS = 150;

type OverlayNodeRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type FlowNodeRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type OverlayPlacement = "below" | "above";

export function useNodeOverlayPosition(
  nodeId: string,
  overlayRef: RefObject<HTMLElement | null>,
  /**
   * 每次重算落点后上报真实方位。输入框在上方时会压住节点功能栏，功能栏要靠
   * 这个信号把自己让到节点下面（见 ui-shell-store 的 promptAboveNodeId）。
   * 用 ref 转存，避免调用方每次渲染换一个新函数就把整个布局 effect 重挂一遍。
   */
  onPlacement?: (placement: OverlayPlacement) => void,
) {
  const flowStore = useStoreApi();
  const onPlacementRef = useRef(onPlacement);
  onPlacementRef.current = onPlacement;
  const measuredOverlayWidthRef = useRef<number | null>(null);
  const lastNodeFlowRectRef = useRef<FlowNodeRect | null>(null);
  const shellOffsetRef = useRef<{ left: number; top: number } | null>(null);
  const lastHorizontalBoundsRef = useRef<{ left: number; right: number } | null>(null);
  const lastOverlayHeightRef = useRef<number | null>(null);
  const lastPlacementRef = useRef<OverlayPlacement>("below");

  const readNodeRect = useCallback((): OverlayNodeRect | null => {
    const shell = document.querySelector<HTMLElement>(".wc-flow-shell");
    if (!shell) return null;
    const shellRect = shell.getBoundingClientRect();
    shellOffsetRef.current = { left: shellRect.left, top: shellRect.top };
    const [translateX, translateY, zoom] = flowStore.getState().transform;
    const safeZoom = zoom || 1;
    const node = document.querySelector<HTMLElement>(`[data-wc-node-id="${CSS.escape(nodeId)}"]`);
    if (node) {
      const rect = node.getBoundingClientRect();
      lastNodeFlowRectRef.current = {
        x: (rect.left - shellRect.left - translateX) / safeZoom,
        y: (rect.top - shellRect.top - translateY) / safeZoom,
        width: rect.width / safeZoom,
        height: rect.height / safeZoom,
      };
      return rect;
    }

    const flowRect = lastNodeFlowRectRef.current;
    if (!flowRect) return null;
    const left = shellRect.left + translateX + flowRect.x * safeZoom;
    const top = shellRect.top + translateY + flowRect.y * safeZoom;
    const width = flowRect.width * safeZoom;
    const height = flowRect.height * safeZoom;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }, [flowStore, nodeId]);

  const positionOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const nodeRect = readNodeRect();
    if (!overlay || !nodeRect) return;
    const firstPosition = overlay.dataset.positioned !== "true";
    if (firstPosition) overlay.style.setProperty("transition", "none");

    const isConfig = overlay.classList.contains("wc-node-config-shell");
    const isGenerationPrompt = overlay.classList.contains("wc-node-prompt-shell--generation");
    const maxWidth = isConfig
      ? CONFIG_MAX_WIDTH
      : isGenerationPrompt
        ? GENERATION_PROMPT_MAX_WIDTH
        : PROMPT_MAX_WIDTH;
    const horizontalBounds = readOverlayHorizontalBounds();
    lastHorizontalBoundsRef.current = horizontalBounds;
    const availableWidth = horizontalBounds.right - horizontalBounds.left;
    const preferredPromptWidth = isGenerationPrompt
      ? clamp(nodeRect.width * 1.45, GENERATION_PROMPT_MIN_WIDTH, GENERATION_PROMPT_MAX_WIDTH)
      : clamp(nodeRect.width * 0.92, PROMPT_MIN_WIDTH, PROMPT_MAX_WIDTH);
    const overlayWidth = Math.min(
      isConfig ? maxWidth : preferredPromptWidth,
      maxWidth,
      availableWidth,
    );
    const widthValue = `${overlayWidth}px`;
    if (overlay.style.getPropertyValue("--wc-node-overlay-width") !== widthValue) {
      overlay.style.setProperty("--wc-node-overlay-width", widthValue);
      measuredOverlayWidthRef.current = null;
    }
    if (!isConfig) {
      const preferredPromptHeight = clamp(
        Math.min(nodeRect.height * 0.62, nodeRect.width * 0.34),
        PROMPT_MIN_HEIGHT,
        PROMPT_MAX_HEIGHT,
      );
      const heightValue = `${Math.floor(preferredPromptHeight)}px`;
      if (overlay.style.getPropertyValue("--wc-node-prompt-height") !== heightValue) {
        overlay.style.setProperty("--wc-node-prompt-height", heightValue);
      }
    }

    // 节点仅移动时，面板宽度并不变化；复用上次测量可避免每帧在写样式后强制同步布局。
    const measuredWidth =
      measuredOverlayWidthRef.current ?? (overlay.getBoundingClientRect().width || overlayWidth);
    measuredOverlayWidthRef.current = measuredWidth;
    const left = fitOverlayHorizontalPosition({
      preferredLeft: nodeRect.left + (nodeRect.width - measuredWidth) / 2,
      overlayWidth: measuredWidth,
      minLeft: horizontalBounds.left,
      maxRight: horizontalBounds.right,
    });
    const viewportMaxHeight = Math.max(160, window.innerHeight - VIEWPORT_MARGIN * 2);
    const maxHeightValue = `${Math.floor(viewportMaxHeight)}px`;
    if (overlay.style.getPropertyValue("--wc-node-overlay-max-height") !== maxHeightValue) {
      overlay.style.setProperty("--wc-node-overlay-max-height", maxHeightValue);
    }
    const vertical = isGenerationPrompt
      ? fitGenerationOverlayVerticalPosition({
          nodeBottom: nodeRect.bottom,
          nodeTop: nodeRect.top,
          viewportHeight: window.innerHeight,
          overlayHeight: measuredOverlayExtent(overlay),
          // 翻到上方时给趴在她上沿的伙伴留身位，见 LEDGE_PERCH_ROOM。
          topReserve: LEDGE_PERCH_ROOM,
        })
      : fitOverlayVerticalPosition({ nodeBottom: nodeRect.bottom });
    lastPlacementRef.current = vertical.placement;
    lastOverlayHeightRef.current = overlay.getBoundingClientRect().height || null;
    onPlacementRef.current?.(vertical.placement);

    const leftValue = `${Math.round(left)}px`;
    const topValue = `${vertical.top}px`;
    if (overlay.style.getPropertyValue("--wc-node-overlay-x") !== leftValue) {
      overlay.style.setProperty("--wc-node-overlay-x", leftValue);
    }
    if (overlay.style.getPropertyValue("--wc-node-overlay-y") !== topValue) {
      overlay.style.setProperty("--wc-node-overlay-y", topValue);
    }
    if (overlay.dataset.placement !== vertical.placement)
      overlay.dataset.placement = vertical.placement;
    overlay.dataset.positioned = "true";
    if (firstPosition) {
      window.requestAnimationFrame(() => overlay.style.removeProperty("transition"));
    }
  }, [overlayRef, readNodeRect]);

  // 手势期间复用上次测量，用纯 transform 数学跟随节点，不读任何同步布局。
  const followTransform = useCallback(() => {
    const overlay = overlayRef.current;
    const flowRect = lastNodeFlowRectRef.current;
    if (!overlay || !flowRect) return;
    if (overlay.classList.contains("is-node-dragging")) return;
    const [translateX, translateY, zoom] = flowStore.getState().transform;
    const safeZoom = zoom || 1;
    const shell = shellOffsetRef.current ?? { left: 0, top: 0 };
    const nodeLeft = shell.left + translateX + flowRect.x * safeZoom;
    const nodeTop = shell.top + translateY + flowRect.y * safeZoom;
    const nodeBottom = nodeTop + flowRect.height * safeZoom;

    const measuredWidth = measuredOverlayWidthRef.current;
    if (measuredWidth == null) return;
    const bounds = lastHorizontalBoundsRef.current ?? {
      left: VIEWPORT_MARGIN,
      right: window.innerWidth - VIEWPORT_MARGIN,
    };
    const leftValue = `${Math.round(
      fitOverlayHorizontalPosition({
        preferredLeft: nodeLeft + (flowRect.width * safeZoom - measuredWidth) / 2,
        overlayWidth: measuredWidth,
        minLeft: bounds.left,
        maxRight: bounds.right,
      }),
    )}px`;
    const overlayHeight = lastOverlayHeightRef.current;
    const topValue =
      lastPlacementRef.current === "above" && overlayHeight != null
        ? `${Math.round(
            Math.max(VIEWPORT_MARGIN + LEDGE_PERCH_ROOM, nodeTop - overlayHeight - NODE_GAP),
          )}px`
        : `${Math.round(nodeBottom + NODE_GAP)}px`;
    if (overlay.style.getPropertyValue("--wc-node-overlay-x") !== leftValue) {
      overlay.style.setProperty("--wc-node-overlay-x", leftValue);
    }
    if (overlay.style.getPropertyValue("--wc-node-overlay-y") !== topValue) {
      overlay.style.setProperty("--wc-node-overlay-y", topValue);
    }
  }, [flowStore, overlayRef]);

  useLayoutEffect(() => {
    let frame = 0;
    let settleTimer = 0;
    let pendingFullMeasure = false;

    const isGestureActive = () => {
      const workspace = document.querySelector<HTMLElement>(".wc-workspace");
      return Boolean(
        workspace?.classList.contains("is-viewport-moving") ||
        workspace?.classList.contains("is-node-dragging"),
      );
    };
    const cancelFrame = () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const scheduleFollow = () => {
      cancelFrame();
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        followTransform();
      });
    };
    const scheduleFullMeasure = () => {
      cancelFrame();
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (isGestureActive()) {
          pendingFullMeasure = true;
          return;
        }
        pendingFullMeasure = false;
        positionOverlay();
      });
    };
    // 面板内容或视口尺寸变化才需要重新读取实际宽度；节点平移只更新坐标。
    const scheduleLayout = () => {
      measuredOverlayWidthRef.current = null;
      scheduleFullMeasure();
    };

    scheduleLayout();
    const unsubscribe = flowStore.subscribe((state, previous) => {
      if (state.transform !== previous.transform) {
        scheduleFollow();
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(scheduleFullMeasure, OVERLAY_FULL_MEASURE_SETTLE_MS);
      }
    });
    const node = document
      .querySelector<HTMLElement>(`[data-wc-node-id="${CSS.escape(nodeId)}"]`)
      ?.closest(".react-flow__node");
    const nodeObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleFullMeasure);
    if (node) nodeObserver?.observe(node, { attributes: true, attributeFilter: ["style"] });
    const sizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleLayout);
    if (overlayRef.current) sizeObserver?.observe(overlayRef.current);
    window.addEventListener("resize", scheduleLayout);
    // 手势结束（is-viewport-moving / is-node-dragging 移除）时补一次精确测量。
    const workspace = document.querySelector<HTMLElement>(".wc-workspace");
    const workspaceObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (isGestureActive() || !pendingFullMeasure) return;
            pendingFullMeasure = false;
            scheduleFullMeasure();
          });
    if (workspace && workspaceObserver) {
      workspaceObserver.observe(workspace, { attributes: true, attributeFilter: ["class"] });
    }

    return () => {
      cancelFrame();
      window.clearTimeout(settleTimer);
      unsubscribe();
      nodeObserver?.disconnect();
      sizeObserver?.disconnect();
      workspaceObserver?.disconnect();
      window.removeEventListener("resize", scheduleLayout);
    };
  }, [flowStore, followTransform, nodeId, overlayRef, positionOverlay]);
}

export function fitOverlayHorizontalPosition({
  preferredLeft,
  overlayWidth,
  minLeft,
  maxRight,
}: {
  preferredLeft: number;
  overlayWidth: number;
  minLeft: number;
  maxRight: number;
}) {
  return Math.round(clamp(preferredLeft, minLeft, maxRight - overlayWidth));
}

export function fitOverlayVerticalPosition({ nodeBottom }: { nodeBottom: number }) {
  return { top: Math.round(nodeBottom + NODE_GAP), placement: "below" } as const;
}

// The generation composer keeps its quick-control bar and submit button pinned
// at the bottom of the shell, so it must never push them below the viewport
// fold. When it would not fit below the node, flip it above the node instead.
export function fitGenerationOverlayVerticalPosition({
  nodeBottom,
  nodeTop,
  viewportHeight,
  overlayHeight,
  margin = VIEWPORT_MARGIN,
  gap = NODE_GAP,
  topReserve = 0,
}: {
  nodeBottom: number;
  nodeTop: number;
  viewportHeight: number;
  overlayHeight: number;
  margin?: number;
  gap?: number;
  /** 翻到节点上方时额外留出的上边距（趴在覆层上沿的伙伴的身位）。 */
  topReserve?: number;
}) {
  const belowTop = nodeBottom + gap;
  if (belowTop + overlayHeight <= viewportHeight - margin) {
    return { top: Math.round(belowTop), placement: "below" as const };
  }
  const aboveTop = Math.max(margin + topReserve, nodeTop - overlayHeight - gap);
  return { top: Math.round(aboveTop), placement: "above" as const };
}

function measuredOverlayExtent(overlay: HTMLElement) {
  const overlayHeight = overlay.getBoundingClientRect().height || 0;
  const status = overlay.querySelector<HTMLElement>(".wc-generation-compact-status");
  if (!status) return overlayHeight;
  const statusBottom = status.getBoundingClientRect().bottom;
  const overlayTop = overlay.getBoundingClientRect().top;
  return Math.max(overlayHeight, statusBottom - overlayTop);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readOverlayHorizontalBounds() {
  const viewportBounds = {
    left: VIEWPORT_MARGIN,
    right: window.innerWidth - VIEWPORT_MARGIN,
  };
  let left = viewportBounds.left;
  let right = viewportBounds.right;
  const createRail = visibleRect(".wc-create-rail");
  const agentDrawer = visibleRect(".wc-agent-drawer");

  if (createRail) left = Math.max(left, createRail.right + FLOATING_CONTROL_GAP);
  if (agentDrawer) right = Math.min(right, agentDrawer.left - FLOATING_CONTROL_GAP);

  return right - left >= MIN_OVERLAY_WIDTH ? { left, right } : viewportBounds;
}

function visibleRect(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}
