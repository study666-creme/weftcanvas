import { useSyncExternalStore, type ComponentType } from "react";

import type { CanvasNodeData, CanvasNodeKind } from "@kachang/contracts";
import type { LucideIcon } from "lucide-react";

import {
  isDefaultNodeAspectRatio,
  nodeAspectRatioValue,
  scaleNodeDimensions,
  type DefaultNodeAspectRatio,
  type DefaultNodeSize,
} from "./node-size";

/** 插件节点体渲染入参（宿主包 ErrorBoundary 后调用；见 plugin-host）。 */
export type NodeBodyProps = {
  kind: string;
  nodeId: string;
  projectId: string;
  data: {
    body: string;
    status: string;
    [key: string]: unknown;
  };
  ops: {
    apply(ops: { type: string; [key: string]: unknown }[]): Promise<{ applied: number; skipped: number }>;
  };
  updateBody(nextBody: string): void;
};

/**
 * 节点注册表（docs/PLUGIN-ROADMAP.md §3 P0）：新增一种节点 = 注册一个定义对象，
 * 创建菜单/工具 rail/连线落点/hover 工具条/连线策略全部从注册表读取，不再
 * 散改核心代码。渲染仍由宿主 kachang-node 的分支负责（本期不做插件内容注入）。
 *
 * 与 infinite-canvas 的差异点：同名 kind 重复注册直接报错，不做静默覆盖。
 */
export type NodeCreateContext = {
  /** 用户的"默认画幅"偏好；legacy 三档尺寸（small/standard/large）也走这里。 */
  defaultAspectRatio: DefaultNodeAspectRatio | DefaultNodeSize;
};

/** createDraft 的产物：工厂据此落一个节点（data 为覆盖默认值的增量）。 */
export type NodeDraft = {
  kind: CanvasNodeKind;
  data?: Partial<CanvasNodeData>;
  width: number;
  height: number;
};

export type NodeConnectionContext = {
  sourceKind: CanvasNodeKind | null;
  targetKind: CanvasNodeKind | null;
  sourceHandle: string | null | undefined;
  targetHandle: string | null | undefined;
};

export type NodeDefinition = {
  /** 与 contracts 的 canvasNodeKinds 枚举一致（插件自有 kind 待 P3 契约放宽）。 */
  kind: CanvasNodeKind;
  /** i18n 就绪的展示名（如"图片节点"）。 */
  label: () => string;
  icon: LucideIcon;
  /** accent 色令牌（节点色环/小地图/连线配色的取色处）。 */
  accent: string;
  /** false = 不进"新建"菜单；已存在节点的渲染不受影响。缺省 true。 */
  creatable?: boolean;
  /** 创建菜单/双击画布/连线落点建节点时的默认草案。 */
  createDraft: (ctx: NodeCreateContext) => NodeDraft;
  /**
   * 可选节点体渲染（插件节点用）：kachang-node 在宿主 ErrorBoundary 内调用，
   * 插件抛错只影响这一个节点卡面。
   */
  renderBody?: ComponentType<NodeBodyProps>;
  /**
   * 可选连线类型策略：两端节点**都**被该定义约束时才校验（缺省走宿主全局
   * 规则：禁自环、禁重复边）。返回 false 拒绝这条连线。
   */
  connectionPolicy?: (ctx: NodeConnectionContext) => boolean;
  /** 注册来源："builtin" 或插件 id（诊断与命名空间追溯用）。 */
  owner?: string;
};

const registry = new Map<string, NodeDefinition>();
let snapshot: readonly NodeDefinition[] = [];
let creatableSnapshot: readonly NodeDefinition[] = [];
const listeners = new Set<() => void>();

function emitChange() {
  snapshot = [...registry.values()];
  creatableSnapshot = snapshot.filter((definition) => definition.creatable !== false);
  for (const listener of listeners) listener();
}

/** 注册一个节点定义，返回卸载函数（重复 kind 直接报错，绝不静默覆盖）。 */
export function registerNode(definition: NodeDefinition): () => void {
  const existing = registry.get(definition.kind);
  if (existing) {
    throw new Error(`[node-registry] 节点类型 "${definition.kind}" 已注册，拒绝覆盖（先卸载旧定义）`);
  }
  registry.set(definition.kind, definition);
  emitChange();
  return () => {
    if (registry.get(definition.kind) !== definition) return;
    registry.delete(definition.kind);
    emitChange();
  };
}

/** 全部已注册定义（注册顺序）。UI 消费请用 useNodeDefinitions 保持响应。 */
export function listNodes(): readonly NodeDefinition[] {
  return snapshot;
}

/** 可创建子集（creatable !== false）。 */
export function listCreatableNodes(): readonly NodeDefinition[] {
  return creatableSnapshot;
}

export function getNodeDefinition(kind: string): NodeDefinition | null {
  return registry.get(kind) ?? null;
}

/** 节点类型展示名；未注册的 kind 回落为 kind 字符串本身（不白屏）。 */
export function nodeLabel(kind: string): string {
  return registry.get(kind)?.label() ?? kind;
}

export function subscribeToNodes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getNodeSnapshot = () => snapshot;
const getCreatableSnapshot = () => creatableSnapshot;

/** 响应式读取：插件装/卸后创建菜单自动增减条目。 */
export function useNodeDefinitions(): readonly NodeDefinition[] {
  return useSyncExternalStore(subscribeToNodes, getNodeSnapshot, getNodeSnapshot);
}

export function useCreatableNodeDefinitions(): readonly NodeDefinition[] {
  return useSyncExternalStore(subscribeToNodes, getCreatableSnapshot, getCreatableSnapshot);
}

/**
 * 非媒体类节点的画幅处理：legacy 三档尺寸缩放基底，比例画幅不重排
 * （文本/配置等节点的几何不跟画幅走）。
 */
export function plainDraftDimensions(
  base: { width: number; height: number },
  ctx: NodeCreateContext,
): { width: number; height: number } {
  if (!isDefaultNodeAspectRatio(ctx.defaultAspectRatio)) {
    return scaleNodeDimensions(base, ctx.defaultAspectRatio);
  }
  return base;
}

/**
 * 图片/视频类节点的画幅处理：比例画幅以 340px 长边重排（历史行为，
 * 见原 node-factory.nodeDefaultDimensions）。
 */
export function mediaDraftDimensions(
  base: { width: number; height: number },
  ctx: NodeCreateContext,
): { width: number; height: number } {
  if (!isDefaultNodeAspectRatio(ctx.defaultAspectRatio)) {
    return scaleNodeDimensions(base, ctx.defaultAspectRatio);
  }
  const ratio = nodeAspectRatioValue(ctx.defaultAspectRatio);
  const longEdge = 340;
  return ratio >= 1
    ? { width: longEdge, height: Math.round(longEdge / ratio) }
    : { width: Math.round(longEdge * ratio), height: longEdge };
}
