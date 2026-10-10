import { CopyPlus, Group, Plus, Trash2, Ungroup, X } from "lucide-react";
import { useStore, useViewport } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { setCanvasConnectionDragging } from "../lib/canvas-connection-state";
import { nodeDefaultDimensions } from "../lib/node-factory";
import { useCanvasStore } from "../state/canvas-store";

type SelectionSummary = {
  count: number;
  nodeIds: string[];
  centerX: number;
  centerY: number;
  left: number;
  right: number;
  top: number;
  canGroup: boolean;
  canUngroup: boolean;
};

export const CanvasSelectionToolbar = memo(function CanvasSelectionToolbar() {
  const nodes = useCanvasStore((state) => state.nodes);
  const groups = useCanvasStore((state) => state.groups);
  const duplicateSelection = useCanvasStore((state) => state.duplicateSelection);
  const deleteSelection = useCanvasStore((state) => state.deleteSelection);
  const groupSelection = useCanvasStore((state) => state.groupSelection);
  const ungroupSelection = useCanvasStore((state) => state.ungroupSelection);
  const clearSelection = useCanvasStore((state) => state.clearSelection);
  const marqueeActive = useStore((state) => state.userSelectionActive);
  // 已分组节点集合只依赖 groups；放在节点循环之外，避免拖拽期间每帧重算。
  const occupied = useMemo(() => new Set(groups.flatMap((group) => group.nodeIds)), [groups]);

  const { selection, nodeDragging } = useMemo(() => {
    const selected = [] as typeof nodes;
    for (const node of nodes) {
      // The toolbar is hidden for the whole gesture. Stop before calculating
      // bounds for hundreds of selected nodes on every drag frame.
      if (node.dragging) return { selection: null, nodeDragging: true };
      if (node.selected) selected.push(node);
    }
    if (selected.length < 2) return { selection: null, nodeDragging: false };

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of selected) {
      const defaults = nodeDefaultDimensions(node.data.kind);
      const width = node.measured?.width ?? node.width ?? defaults.width;
      const height = node.measured?.height ?? node.height ?? defaults.height;
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    }

    const selectedIds = new Set(selected.map((node) => node.id));
    return {
      nodeDragging: false,
      selection: {
        count: selected.length,
        nodeIds: selected.map((node) => node.id),
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2,
        left: minX,
        right: maxX,
        top: minY,
        canGroup: selected.every((node) => !occupied.has(node.id)),
        canUngroup: groups.some((group) => group.nodeIds.some((id) => selectedIds.has(id))),
      } satisfies SelectionSummary,
    };
  }, [groups, nodes, occupied]);

  if (!selection || marqueeActive || nodeDragging) return null;

  return (
    <>
      <CanvasSelectionPorts selection={selection} />
      <CanvasSelectionToolbarSurface
        selection={selection}
        onDuplicate={duplicateSelection}
        onDelete={deleteSelection}
        onGroup={groupSelection}
        onUngroup={ungroupSelection}
        onClear={clearSelection}
      />
    </>
  );
});

type SelectionConnectionDrag = {
  pointerId: number;
  direction: "outgoing" | "incoming";
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  targetNodeId: string | null;
  targetElement: HTMLElement | null;
};

const CanvasSelectionPorts = memo(function CanvasSelectionPorts({ selection }: { selection: SelectionSummary }) {
  const viewport = useViewport();
  const connectSelectionToNode = useCanvasStore((state) => state.connectSelectionToNode);
  const selectedNodeIds = useMemo(() => new Set(selection.nodeIds), [selection.nodeIds]);
  const dragRef = useRef<SelectionConnectionDrag | null>(null);
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<SelectionConnectionDrag | null>(null);
  const centerY = viewport.y + selection.centerY * viewport.zoom;
  const left = viewport.x + selection.left * viewport.zoom;
  const right = viewport.x + selection.right * viewport.zoom;

  const clearTarget = useCallback(() => {
    dragRef.current?.targetElement?.classList.remove("is-selection-connection-target");
  }, []);

  const stop = useCallback((commit: boolean) => {
    const current = dragRef.current;
    if (!current) return;
    gestureCleanupRef.current?.();
    gestureCleanupRef.current = null;
    clearTarget();
    if (commit && current.targetNodeId) connectSelectionToNode(current.targetNodeId, current.direction);
    dragRef.current = null;
    setDrag(null);
    setCanvasConnectionDragging(false);
  }, [clearTarget, connectSelectionToNode]);

  useEffect(() => () => stop(false), [stop]);

  const start = useCallback((event: ReactPointerEvent<HTMLButtonElement>, direction: "outgoing" | "incoming") => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const next: SelectionConnectionDrag = {
      pointerId: event.pointerId,
      direction,
      startX: rect.left + rect.width / 2,
      startY: rect.top + rect.height / 2,
      currentX: event.clientX,
      currentY: event.clientY,
      targetNodeId: null,
      targetElement: null,
    };
    dragRef.current = next;
    setDrag(next);
    setCanvasConnectionDragging(true);

    const updateTarget = (clientX: number, clientY: number) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      clearTarget();
      const element = document.elementsFromPoint(clientX, clientY)
        .find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement && candidate.matches(".react-flow__node-kachang[data-id]"));
      const nodeId = element?.dataset.id ?? null;
      const validTarget = nodeId && !selectedNodeIds.has(nodeId) ? nodeId : null;
      if (validTarget && element) element.classList.add("is-selection-connection-target");
      const updated = { ...current, currentX: clientX, currentY: clientY, targetNodeId: validTarget, targetElement: validTarget ? element ?? null : null };
      dragRef.current = updated;
      setDrag(updated);
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== moveEvent.pointerId) return;
      updateTarget(moveEvent.clientX, moveEvent.clientY);
    };
    const end = (endEvent: globalThis.PointerEvent) => {
      if (dragRef.current?.pointerId !== endEvent.pointerId) return;
      updateTarget(endEvent.clientX, endEvent.clientY);
      stop(true);
    };
    const cancel = (cancelEvent: globalThis.PointerEvent) => {
      if (dragRef.current?.pointerId !== cancelEvent.pointerId) return;
      stop(false);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", cancel, true);
    gestureCleanupRef.current = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", cancel, true);
    };
  }, [clearTarget, selectedNodeIds, stop]);

  return (
    <>
      {drag ? (
        <svg className="kc-selection-connection-preview" aria-hidden="true">
          <path d={`M ${drag.startX} ${drag.startY} C ${(drag.startX + drag.currentX) / 2} ${drag.startY}, ${(drag.startX + drag.currentX) / 2} ${drag.currentY}, ${drag.currentX} ${drag.currentY}`} />
        </svg>
      ) : null}
      <button
        type="button"
        className="kc-selection-port kc-selection-port--left nodrag nopan nowheel"
        style={{ left, top: centerY }}
        aria-label="将目标节点连接到全部选中节点"
        title="拖动并连接到全部选中节点"
        onPointerDown={(event) => start(event, "incoming")}
      ><Plus aria-hidden="true" /></button>
      <button
        type="button"
        className="kc-selection-port kc-selection-port--right nodrag nopan nowheel"
        style={{ left: right, top: centerY }}
        aria-label="将全部选中节点连接到目标节点"
        title="拖动全部选中节点连接到目标节点"
        onPointerDown={(event) => start(event, "outgoing")}
      ><Plus aria-hidden="true" /></button>
    </>
  );
});

type CanvasSelectionToolbarSurfaceProps = {
  selection: SelectionSummary;
  onDuplicate: () => void;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onClear: () => void;
};

const CanvasSelectionToolbarSurface = memo(function CanvasSelectionToolbarSurface({
  selection,
  onDuplicate,
  onDelete,
  onGroup,
  onUngroup,
  onClear,
}: CanvasSelectionToolbarSurfaceProps) {
  const viewport = useViewport();
  const screenLeft = viewport.x + selection.centerX * viewport.zoom;
  const screenTop = viewport.y + selection.top * viewport.zoom - 12;
  const left = Math.max(156, Math.min(window.innerWidth - 156, screenLeft));
  const top = Math.max(84, screenTop);

  return (
    <div
      className="kc-selection-toolbar nodrag nopan nowheel"
      role="toolbar"
      aria-label={`已选择 ${selection.count} 个节点`}
      style={{ left, top } as CSSProperties}
      data-kc-block-canvas-shortcuts
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="kc-selection-toolbar-count">{selection.count}</span>
      {selection.canUngroup ? (
        <button type="button" aria-label="解散选中组合" title="解组" onClick={onUngroup}>
          <Ungroup aria-hidden="true" />
        </button>
      ) : (
        <button type="button" aria-label="组合选中节点" title="组合" disabled={!selection.canGroup} onClick={onGroup}>
          <Group aria-hidden="true" />
        </button>
      )}
      <button type="button" aria-label="创建选中节点副本" title="创建副本" onClick={onDuplicate}>
        <CopyPlus aria-hidden="true" />
      </button>
      <button type="button" className="is-danger" aria-label="删除选中节点" title="删除" onClick={onDelete}>
        <Trash2 aria-hidden="true" />
      </button>
      <button type="button" aria-label="取消选择" title="取消选择" onClick={onClear}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
});
