import type { CanvasGroup } from "@kachang/contracts";
import { ViewportPortal, useReactFlow, useStoreApi } from "@xyflow/react";
import { Check, Grid3X3, Palette, Pencil, Ungroup, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import {
  getGroupBounds,
  GROUP_COLOR_PALETTE,
  GROUP_FRAME_HEADER,
  GROUP_FRAME_PADDING,
  indexCanvasNodes,
  type NodeGroupBounds,
} from "../lib/node-groups";
import { useCanvasStore } from "../state/canvas-store";
import type { KachangEdge, KachangNode } from "../types";

type VisibleGroup = {
  group: CanvasGroup;
  bounds: NodeGroupBounds;
  selected: boolean;
};

type GroupResizeDirection = "top" | "top-right" | "right" | "bottom-right" | "bottom" | "bottom-left" | "left" | "top-left";

const GROUP_RESIZE_DIRECTIONS: GroupResizeDirection[] = [
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
  "top-left",
];
const GROUP_VIEWPORT_MARGIN = 320;
// 可见性裁剪只做粗粒度更新：平移时以 720px 的 tile 为步长重算，
// 移动结束后在 settle 阶段再做一次精确裁剪，避免每帧重扫全部组合。
const GROUP_CULL_TILE_SIZE = 720;
const GROUP_CULL_SETTLE_MS = 120;

type FlowViewportBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function groupIntersectsViewport(bounds: NodeGroupBounds, viewport: FlowViewportBounds) {
  return bounds.x <= viewport.right
    && bounds.x + bounds.width >= viewport.left
    && bounds.y <= viewport.bottom
    && bounds.y + bounds.height >= viewport.top;
}

export const CanvasGroupsLayer = memo(function CanvasGroupsLayer() {
  const hasGroups = useCanvasStore((state) => state.groups.length > 0);
  return hasGroups ? <CanvasGroupsLayerContent /> : null;
});

const CanvasGroupsLayerContent = memo(function CanvasGroupsLayerContent() {
  const nodes = useCanvasStore((state) => state.nodes);
  const groups = useCanvasStore((state) => state.groups);
  const selectGroup = useCanvasStore((state) => state.selectGroup);
  const moveGroupBy = useCanvasStore((state) => state.moveGroupBy);
  const scaleGroupBy = useCanvasStore((state) => state.scaleGroupBy);
  const arrangeGroup = useCanvasStore((state) => state.arrangeGroup);
  const renameGroup = useCanvasStore((state) => state.renameGroup);
  const setGroupColor = useCanvasStore((state) => state.setGroupColor);
  const ungroup = useCanvasStore((state) => state.ungroup);
  const beginTransaction = useCanvasStore((state) => state.beginTransaction);
  const commitTransaction = useCanvasStore((state) => state.commitTransaction);
  const flowStore = useStoreApi<KachangNode, KachangEdge>();
  const { screenToFlowPosition } = useReactFlow<KachangNode, KachangEdge>();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const closeTimer = useRef<number | null>(null);
  const stableBounds = useRef(new Map<string, NodeGroupBounds>());
  const [cullViewport, setCullViewport] = useState<FlowViewportBounds>(() => readFlowViewportBounds(flowStore));
  const cullViewportRef = useRef(cullViewport);
  const settleTimer = useRef<number | null>(null);
  const refreshCullRef = useRef<(() => void) | null>(null);
  const [viewportMoving, setViewportMoving] = useState(false);

  // 组合几何只依赖 nodes/groups：平移不改变它们，因此不会逐帧重建 node Map、
  // 重扫选中节点/成员或重复 getGroupBounds。
  const visibleGroups = useMemo<VisibleGroup[]>(() => {
    if (!groups.length) return [];
    const nodeIndex = indexCanvasNodes(nodes);
    const selectedIds = new Set<string>();
    for (const node of nodes) {
      if (node.selected) selectedIds.add(node.id);
    }
    return groups.flatMap((group) => {
      let existingMembers = 0;
      let draggingMembers = 0;
      for (const nodeId of group.nodeIds) {
        const node = nodeIndex.get(nodeId);
        if (!node) continue;
        existingMembers += 1;
        if (node.dragging) draggingMembers += 1;
      }
      const measuredBounds = getGroupBounds(group, nodes, nodeIndex);
      const freezeForMemberDrag = draggingMembers > 0 && draggingMembers < existingMembers;
      const bounds = freezeForMemberDrag ? stableBounds.current.get(group.id) ?? measuredBounds : measuredBounds;
      if (!freezeForMemberDrag && bounds) stableBounds.current.set(group.id, bounds);
      return bounds && groupIntersectsViewport(bounds, cullViewport)
        ? [{ group, bounds, selected: group.nodeIds.every((id) => selectedIds.has(id)) }]
        : [];
    });
  }, [cullViewport, groups, nodes]);

  useEffect(() => {
    // 视口边界未真正变化时不要写入新对象：cullViewport 是 visibleGroups 的依赖，
    // 每次都 set 一个新对象会让整层组合几何在手势结束后再白算一轮。
    const apply = (next: FlowViewportBounds) => {
      if (sameViewportBounds(cullViewportRef.current, next)) return;
      cullViewportRef.current = next;
      setCullViewport(next);
    };
    const unsubscribe = flowStore.subscribe((state, previous) => {
      const moving = state.transform !== previous.transform;
      const resized = state.width !== previous.width || state.height !== previous.height;
      if (!moving && !resized) return;
      const next = readFlowViewportBounds(flowStore);
      if (resized || tileChanged(cullViewportRef.current, next)) apply(next);
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        apply(readFlowViewportBounds(flowStore));
      }, GROUP_CULL_SETTLE_MS);
    });
    // 组合几何变化后立即用最新视口做一次精确裁剪，保证新组合/被移动节点立即可见。
    const refreshCull = () => apply(readFlowViewportBounds(flowStore));
    refreshCullRef.current = refreshCull;
    refreshCull();
    return () => {
      refreshCullRef.current = null;
      unsubscribe();
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    };
    // 只依赖 flowStore：视口订阅与节点/组合无关。节点变化后的重新裁剪由下方独立
    // 的 effect 触发，否则每次节点移动都要取消并重建订阅、再无条件刷新一次裁剪。
  }, [flowStore]);

  useEffect(() => {
    refreshCullRef.current?.();
  }, [groups, nodes]);

  // 平移/缩放手势期间的工具栏位置随 useViewport 每帧变化；手势中直接卸载，
  // 结束后按最新几何重挂载，避免手势期间每个组合工具栏都逐帧订阅视口。
  useEffect(() => {
    const workspace = document.querySelector<HTMLElement>(".kc-workspace");
    if (!workspace) return;
    const update = () => {
      setViewportMoving(
        workspace.classList.contains("is-viewport-moving") || workspace.classList.contains("is-node-dragging"),
      );
    };
    update();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(workspace, { attributes: true, attributeFilter: ["class"] });
    return () => observer?.disconnect();
  }, []);

  const active = visibleGroups.find((item) => item.group.id === activeId) ?? null;

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const openGroup = useCallback((id: string) => {
    cancelClose();
    setActiveId(id);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      if (!paletteOpen && !renaming) setActiveId(null);
      closeTimer.current = null;
    }, 280);
  }, [cancelClose, paletteOpen, renaming]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    if (!activeId) return;
    const closeOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-kc-group-frame], [data-kc-group-toolbar]")) return;
      setPaletteOpen(false);
      setRenaming(false);
      setActiveId(null);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [activeId]);

  const beginGroupDrag = (event: ReactPointerEvent<HTMLElement>, item: VisibleGroup) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const workspace = event.currentTarget.closest<HTMLElement>(".kc-workspace");
    workspace?.classList.add("is-node-dragging");
    selectGroup(item.group.id);
    openGroup(item.group.id);
    beginTransaction();
    let previous = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    let pending = { x: 0, y: 0 };
    let frame = 0;

    const flush = () => {
      frame = 0;
      if (!pending.x && !pending.y) return;
      moveGroupBy(item.group.id, pending);
      pending = { x: 0, y: 0 };
    };

    const move = (nextEvent: globalThis.PointerEvent) => {
      const next = screenToFlowPosition({ x: nextEvent.clientX, y: nextEvent.clientY });
      pending.x += next.x - previous.x;
      pending.y += next.y - previous.y;
      previous = next;
      if (!frame) frame = window.requestAnimationFrame(flush);
    };
    const finish = () => {
      if (frame) window.cancelAnimationFrame(frame);
      flush();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      workspace?.classList.remove("is-node-dragging");
      commitTransaction();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const beginGroupResize = (event: ReactPointerEvent<HTMLElement>, item: VisibleGroup, direction: GroupResizeDirection) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const workspace = event.currentTarget.closest<HTMLElement>(".kc-workspace");
    workspace?.classList.add("is-node-dragging");
    selectGroup(item.group.id);
    openGroup(item.group.id);
    beginTransaction();

    const start = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const contentLeft = item.bounds.x + GROUP_FRAME_PADDING;
    const contentTop = item.bounds.y + GROUP_FRAME_PADDING + GROUP_FRAME_HEADER;
    const contentRight = item.bounds.x + item.bounds.width - GROUP_FRAME_PADDING;
    const contentBottom = item.bounds.y + item.bounds.height - GROUP_FRAME_PADDING;
    const anchor = {
      x: direction.includes("left") ? contentRight : direction.includes("right") ? contentLeft : (contentLeft + contentRight) / 2,
      y: direction.includes("top") ? contentBottom : direction.includes("bottom") ? contentTop : (contentTop + contentBottom) / 2,
    };
    const resizingNodeIds = new Set(item.group.nodeIds);
    const resizingNodes = nodes.filter((node) => resizingNodeIds.has(node.id));
    let minFactor = 0.2;
    let maxFactor = 8;
    for (const node of resizingNodes) {
      const width = node.width ?? node.measured?.width ?? 280;
      const height = node.height ?? node.measured?.height ?? 160;
      minFactor = Math.max(minFactor, 160 / width, 90 / height);
      maxFactor = Math.min(maxFactor, 4096 / width, 4096 / height);
    }
    let latestFactor = 1;
    let appliedFactor = 1;
    let frame = 0;

    const flush = () => {
      frame = 0;
      if (Math.abs(latestFactor - appliedFactor) < 0.0001) return;
      scaleGroupBy(item.group.id, latestFactor / appliedFactor, anchor);
      appliedFactor = latestFactor;
    };
    const move = (nextEvent: globalThis.PointerEvent) => {
      const next = screenToFlowPosition({ x: nextEvent.clientX, y: nextEvent.clientY });
      const horizontal = direction === "left" || direction === "right";
      const vertical = direction === "top" || direction === "bottom";
      let factor: number;
      if (horizontal) {
        factor = (next.x - anchor.x) / (start.x - anchor.x);
      } else if (vertical) {
        factor = (next.y - anchor.y) / (start.y - anchor.y);
      } else {
        const startX = start.x - anchor.x;
        const startY = start.y - anchor.y;
        const denominator = startX * startX + startY * startY;
        factor = denominator > 0
          ? ((next.x - anchor.x) * startX + (next.y - anchor.y) * startY) / denominator
          : 1;
      }
      latestFactor = Math.min(maxFactor, Math.max(minFactor, Number.isFinite(factor) ? factor : 1));
      if (!frame) frame = window.requestAnimationFrame(flush);
    };
    const finish = () => {
      if (frame) window.cancelAnimationFrame(frame);
      flush();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      workspace?.classList.remove("is-node-dragging");
      commitTransaction();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const saveRename = () => {
    if (!active) return;
    renameGroup(active.group.id, renameDraft);
    setRenaming(false);
  };

  return (
    <>
      <ViewportPortal>
        {visibleGroups.map((item) => (
          <section
            key={item.group.id}
            data-kc-group-frame={item.group.id}
            className={`kc-group-frame ${item.selected ? "is-selected" : ""}`}
            style={{
              left: item.bounds.x,
              top: item.bounds.y,
              width: item.bounds.width,
              height: item.bounds.height,
              "--kc-group-color": item.group.color,
            } as CSSProperties}
            onPointerEnter={() => openGroup(item.group.id)}
            onPointerLeave={scheduleClose}
          >
            <header className="kc-group-frame-header nodrag nowheel" onPointerDown={(event) => beginGroupDrag(event, item)}>
              <span>{item.group.name}</span>
              <small>{item.group.nodeIds.length}</small>
            </header>
            {GROUP_RESIZE_DIRECTIONS.map((direction) => (
              <button
                key={direction}
                type="button"
                data-kc-group-resize={direction}
                className={`kc-group-resize kc-group-resize--${direction}`}
                aria-label={`Resize group ${direction}`}
                onPointerDown={(event) => beginGroupResize(event, item, direction)}
              />
            ))}
          </section>
        ))}
      </ViewportPortal>

      {active && !viewportMoving ? (
        <CanvasGroupToolbar
          active={active}
          paletteOpen={paletteOpen}
          renaming={renaming}
          renameDraft={renameDraft}
          onOpen={() => openGroup(active.group.id)}
          onClose={scheduleClose}
          onRenameDraftChange={setRenameDraft}
          onSaveRename={saveRename}
          onCancelRename={() => setRenaming(false)}
          onStartRename={() => {
            setRenameDraft(active.group.name);
            setPaletteOpen(false);
            setRenaming(true);
          }}
          onTogglePalette={() => setPaletteOpen((open) => !open)}
          onSetColor={(color) => {
            setGroupColor(active.group.id, color);
            setPaletteOpen(false);
          }}
          onArrange={() => arrangeGroup(active.group.id)}
          onUngroup={() => ungroup(active.group.id)}
        />
      ) : null}
    </>
  );
});

type CanvasGroupToolbarProps = {
  active: VisibleGroup;
  paletteOpen: boolean;
  renaming: boolean;
  renameDraft: string;
  onOpen: () => void;
  onClose: () => void;
  onRenameDraftChange: (value: string) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onStartRename: () => void;
  onTogglePalette: () => void;
  onSetColor: (color: string) => void;
  onArrange: () => void;
  onUngroup: () => void;
};

const CanvasGroupToolbar = memo(function CanvasGroupToolbar({
  active,
  paletteOpen,
  renaming,
  renameDraft,
  onOpen,
  onClose,
  onRenameDraftChange,
  onSaveRename,
  onCancelRename,
  onStartRename,
  onTogglePalette,
  onSetColor,
  onArrange,
  onUngroup,
}: CanvasGroupToolbarProps) {
  const viewport = useReactFlow<KachangNode, KachangEdge>().getViewport();
  const toolbarLeft = viewport.x + (active.bounds.x + active.bounds.width / 2) * viewport.zoom;
  const toolbarTop = viewport.y + active.bounds.y * viewport.zoom - 9;
  const clampedToolbarLeft = Math.max(132, Math.min(window.innerWidth - 132, toolbarLeft));

  return (
    <div
      data-kc-group-toolbar
      className="kc-group-toolbar nodrag nowheel"
      style={{ left: clampedToolbarLeft, top: toolbarTop, "--kc-group-color": active.group.color } as CSSProperties}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={onOpen}
      onPointerLeave={onClose}
    >
      {renaming ? (
        <div className="kc-group-rename">
          <input
            autoFocus
            value={renameDraft}
            maxLength={32}
            aria-label="组合名称"
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSaveRename();
              if (event.key === "Escape") onCancelRename();
            }}
          />
          <button type="button" aria-label="保存名称" title="保存" onClick={onSaveRename}><Check aria-hidden="true" /></button>
          <button type="button" aria-label="取消重命名" title="取消" onClick={onCancelRename}><X aria-hidden="true" /></button>
        </div>
      ) : (
        <button type="button" className="kc-group-name-action" title="重命名组合" onClick={onStartRename}>
          <Pencil aria-hidden="true" />
          <span>{active.group.name}</span>
        </button>
      )}

      <span className="kc-group-toolbar-divider" aria-hidden="true" />
      <button type="button" aria-label="组合颜色" title="颜色" className={paletteOpen ? "is-active" : ""} onClick={onTogglePalette}>
        <Palette aria-hidden="true" />
      </button>
      <button type="button" aria-label="整理组合布局" title="自动整理" onClick={onArrange}>
        <Grid3X3 aria-hidden="true" />
      </button>
      <button type="button" aria-label="解散组合" title="解组" onClick={onUngroup}>
        <Ungroup aria-hidden="true" />
      </button>

      {paletteOpen ? (
        <div className="kc-group-palette">
          {GROUP_COLOR_PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`使用颜色 ${color}`}
              className={color === active.group.color ? "is-selected" : ""}
              onClick={() => onSetColor(color)}
            >
              <span style={{ background: color }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function readFlowViewportBounds(flowStore: ReturnType<typeof useStoreApi<KachangNode, KachangEdge>>): FlowViewportBounds {
  const state = flowStore.getState();
  const zoom = state.transform[2] || 1;
  return {
    left: -state.transform[0] / zoom - GROUP_VIEWPORT_MARGIN,
    top: -state.transform[1] / zoom - GROUP_VIEWPORT_MARGIN,
    right: (state.width - state.transform[0]) / zoom + GROUP_VIEWPORT_MARGIN,
    bottom: (state.height - state.transform[1]) / zoom + GROUP_VIEWPORT_MARGIN,
  };
}

function sameViewportBounds(previous: FlowViewportBounds, next: FlowViewportBounds) {
  return previous.left === next.left
    && previous.top === next.top
    && previous.right === next.right
    && previous.bottom === next.bottom;
}

function tileChanged(previous: FlowViewportBounds, next: FlowViewportBounds) {
  const previousKey = [
    Math.floor(previous.left / GROUP_CULL_TILE_SIZE),
    Math.floor(previous.top / GROUP_CULL_TILE_SIZE),
    Math.floor(previous.right / GROUP_CULL_TILE_SIZE),
    Math.floor(previous.bottom / GROUP_CULL_TILE_SIZE),
  ].join(":");
  const nextKey = [
    Math.floor(next.left / GROUP_CULL_TILE_SIZE),
    Math.floor(next.top / GROUP_CULL_TILE_SIZE),
    Math.floor(next.right / GROUP_CULL_TILE_SIZE),
    Math.floor(next.bottom / GROUP_CULL_TILE_SIZE),
  ].join(":");
  return previousKey !== nextKey;
}
