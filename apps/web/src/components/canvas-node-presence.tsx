import { useStoreApi } from "@xyflow/react";
import { memo, useEffect, useSyncExternalStore } from "react";

import type { KachangEdge, KachangNode } from "../types";

/**
 * 带余量与滞后的节点可见集（tldraw culling + RealFlow overscan 的合体思路）。
 *
 * React Flow 的 onlyRenderVisibleElements 每帧用「精确视口矩形」线性扫描全部
 * 节点：节点一碰到视口边缘就卸载、回来就重挂，零余量、零滞后。重组件（媒体
 * 解码、20+ hooks、工具栏面板）在平移时成批重挂，正是大画布平移卡顿的主因
 * （上游长期未解：xyflow #3883/#5656/#5487）。
 *
 * 这里改为：关闭 onlyRenderVisibleElements（节点保持挂载），由本模块计算
 * 「余量可见集」并只对掉出集合的节点写 display:none——display:none 的元素
 * 不参与布局与绘制，保留挂载则意味着回视口时零重建：
 * - 命中测试用比视口四边外扩 MARGIN 的矩形，掉出余量区才隐藏；
 * - 纯平移时若当前视口仍被上次结果区域完全包含（半余量判定），直接复用
 *   上次集合，平移手势中可见集稳定不变，杜绝边缘抖动；
 * - 缩放、节点增删、尺寸变化时重算；
 * - 选中/拖拽中的节点永远可见（tldraw 的 culling 豁免规则）。
 *
 * 挂载节点数有硬顶（MAX_TRACKED），超过时退回全部可见，由 dense/overview
 * 既有降级兜底，避免极端大画布的常驻 DOM 拖垮交互。
 */

const MARGIN = 320;
/** 挂载节点的数量硬顶；超过后退化为「全部挂载」，由既有降级兜底。 */
const MAX_TRACKED_NODES = 400;
/** 非手势变化的兜底重算间隔：节点增删/尺寸变化后延迟合并重算。 */
const RECALC_DEBOUNCE_MS = 120;

type FlowStore = ReturnType<typeof useStoreApi<KachangNode, KachangEdge>>;
type FlowState = ReturnType<FlowStore["getState"]>;

type CullRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// ---------------------------------------------------------------------------
// 可见集计算（纯函数，供测试）
// ---------------------------------------------------------------------------

export function viewportRectFromTransform(
  width: number,
  height: number,
  transform: readonly [number, number, number],
): CullRect | null {
  if (!width || !height || !transform[2]) return null;
  return {
    x: -transform[0] / transform[2],
    y: -transform[1] / transform[2],
    width: width / transform[2],
    height: height / transform[2],
  };
}

export function expandRect(rect: CullRect, margin: number): CullRect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

export function rectContainsRect(outer: CullRect, inner: CullRect): boolean {
  return outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

/** 节点与余量视口的重叠判定（部分可见即算可见）。 */
export function nodeIntersectsRect(
  node: { positionAbsoluteX: number; positionAbsoluteY: number; width: number; height: number },
  rect: CullRect,
): boolean {
  const { positionAbsoluteX: x, positionAbsoluteY: y } = node;
  return x < rect.x + rect.width
    && x + node.width > rect.x
    && y < rect.y + rect.height
    && y + node.height > rect.y;
}

type PresenceCandidate = {
  selected?: boolean;
  dragging?: boolean;
  measured?: { width?: number; height?: number } | null;
  position: { x: number; y: number } | null;
};

/**
 * 单个节点是否保持可见（纯函数，供测试）。
 *
 * React Flow 只在节点元素有盒子时读取端口 handleBounds。若一个节点在首次测量
 * 前就被 display:none 隐藏，它的 handleBounds 会一直是空的，所有挂在它身上的
 * 连线都锚定到 flow (0,0)——而且即使节点重新滚回视口也不会恢复（React Flow
 * 不会重新读取已登记的节点）。所以未测量过的节点必须保持可见，等 React Flow
 * 量过一次后再按余量视口裁剪；测量会改动 nodeLookup，触发防抖重算。
 */
export function nodeStaysVisible(node: PresenceCandidate, cullRect: CullRect): boolean {
  if (node.selected === true || node.dragging === true) return true;
  const width = node.measured?.width ?? 0;
  const height = node.measured?.height ?? 0;
  if (width <= 0 || height <= 0) return true;
  if (!node.position) return true;
  return nodeIntersectsRect(
    {
      positionAbsoluteX: node.position.x,
      positionAbsoluteY: node.position.y,
      width,
      height,
    },
    cullRect,
  );
}

// ---------------------------------------------------------------------------
// presence 通知通道：按节点 id 精确订阅，只有自身可见性翻转的节点重渲染。
// ---------------------------------------------------------------------------

const presenceListeners = new Map<string, Set<() => void>>();

function notifyPresence(id: string) {
  const listeners = presenceListeners.get(id);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

function subscribeNodePresence(id: string, listener: () => void): () => void {
  let listeners = presenceListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    presenceListeners.set(id, listeners);
  }
  listeners.add(listener);
  return () => {
    const listeners = presenceListeners.get(id);
    if (!listeners) return;
    listeners.delete(listener);
    if (!listeners.size) presenceListeners.delete(id);
  };
}

function notifyMany(ids: Iterable<string>) {
  for (const id of ids) notifyPresence(id);
}

/** 每个节点 id 的可见性；由 controller 独占写入，节点包装层只读。 */
const nodePresence = new Map<string, boolean>();

/**
 * 订阅单节点可见性。只有该节点的可见性翻转才触发重渲染，其余节点零开销。
 */
export function useNodePresence(id: string): boolean {
  return useSyncExternalStore(
    (listener) => subscribeNodePresence(id, listener),
    () => nodePresence.get(id) ?? true,
    () => true,
  );
}

/** 测试入口：读单节点可见性。 */
export function readNodePresence(id: string): boolean {
  return nodePresence.get(id) ?? true;
}

// ---------------------------------------------------------------------------
// 可见集计算
// ---------------------------------------------------------------------------

function viewportRectInFlowCoordinates(state: FlowState): CullRect | null {
  const { width, height, transform } = state;
  return viewportRectFromTransform(width, height, transform);
}

type ComputedPresence = {
  cullRect: CullRect | null;
  zoom: number;
};

function computeVisibility(store: FlowStore): ComputedPresence {
  const state = store.getState();
  const rect = viewportRectInFlowCoordinates(state);
  if (!rect) return { cullRect: null, zoom: state.transform[2] };

  const nodeCount = state.nodeLookup.size;

  // 数量超过硬顶：退化为全部可见（清掉所有隐藏态），由 dense 降级兜底。
  if (nodeCount > MAX_TRACKED_NODES) {
    const restoredIds: string[] = [];
    for (const [id, visible] of nodePresence) {
      if (!visible) {
        nodePresence.set(id, true);
        restoredIds.push(id);
      }
    }
    if (restoredIds.length) notifyMany(restoredIds);
    return { cullRect: null, zoom: state.transform[2] };
  }

  const cullRect = expandRect(rect, MARGIN);
  const changedIds: string[] = [];

  for (const node of state.nodeLookup.values()) {
    if (node.hidden) continue;
    const visible = nodeStaysVisible(
      { selected: node.selected, dragging: node.dragging, measured: node.measured, position: node.internals.positionAbsolute },
      cullRect,
    );
    if (nodePresence.get(node.id) !== visible) {
      nodePresence.set(node.id, visible);
      changedIds.push(node.id);
    }
  }

  // 清掉已删除节点的残留条目。
  for (const id of [...nodePresence.keys()]) {
    if (!state.nodeLookup.has(id)) {
      nodePresence.delete(id);
      changedIds.push(id);
    }
  }

  if (changedIds.length) notifyMany(changedIds);
  return { cullRect, zoom: state.transform[2] };
}

/**
 * 裁剪控制器：渲染在 ReactFlow 内部，订阅视口与节点变化并驱动可见集。
 * 不产生任何 DOM 输出。
 */
export const CanvasNodePresence = memo(function CanvasNodePresence() {
  const store = useStoreApi<KachangNode, KachangEdge>();

  useEffect(() => {
    let lastCullRect: CullRect | null = null;
    let lastZoom = 0;
    let frame: number | null = null;
    let timer: number | null = null;
    let disposed = false;

    const compute = () => {
      if (disposed) return;
      const result = computeVisibility(store);
      lastCullRect = result.cullRect;
      lastZoom = result.zoom;
    };

    const scheduleFrame = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        compute();
      });
    };

    const scheduleDebounced = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        compute();
      }, RECALC_DEBOUNCE_MS);
    };

    const unsubscribe = store.subscribe((next, previous) => {
      const transformChanged = next.transform[0] !== previous.transform[0]
        || next.transform[1] !== previous.transform[1]
        || next.transform[2] !== previous.transform[2];
      if (transformChanged) {
        const zoomUnchanged = next.transform[2] === previous.transform[2] && next.transform[2] === lastZoom;
        // 纯平移且新视口仍被上次余量矩形完全包含：可见集必然不变，跳过重算。
        if (zoomUnchanged && lastCullRect) {
          const rect = viewportRectInFlowCoordinates(next);
          if (rect && rectContainsRect(lastCullRect, rect)) return;
        }
        scheduleFrame();
        return;
      }
      if (next.nodeLookup !== previous.nodeLookup
        || next.width !== previous.width
        || next.height !== previous.height) {
        scheduleDebounced();
      }
    });

    compute();

    return () => {
      disposed = true;
      unsubscribe();
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [store]);

  return null;
});
