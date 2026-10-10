import type { ModelModality } from "@kachang/contracts";

import type { KachangEdge, KachangNode } from "../types";
import { nodeDefaultDimensions } from "./node-factory";
import { generationParametersAspectRatio } from "./node-size";

export function isGenerationModality(kind: KachangNode["data"]["kind"]): kind is ModelModality {
  return kind !== "config";
}

/**
 * 配置来源查找的预建索引。
 *
 * 原始实现每次调用都要 `nodes.find` 扫全表，再对每条边重复一次全表查找，单次查询是
 * O(E·N)。而节点渲染时会为每个配置节点逐条出边调用它，整体退化到 O(N³) 级别，是
 * 画布在节点变多后掉帧的主因。索引一次构建 O(N+E)，之后每次查询只走哈希与入边列表。
 */
export type ConfigurationIndex = {
  nodeById: Map<string, KachangNode>;
  inboundSources: Map<string, string[]>;
};

export function createConfigurationIndex(
  nodes: KachangNode[],
  edges: KachangEdge[],
): ConfigurationIndex {
  const nodeById = new Map<string, KachangNode>();
  for (const node of nodes) {
    // 与 Array.prototype.find 保持一致：重复 id 时保留第一个出现的节点。
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
  }
  // 按 edges 原始顺序收集，查询时倒序遍历，等价于原先对整个 edges 数组的倒序扫描。
  const inboundSources = new Map<string, string[]>();
  for (const edge of edges) {
    const existing = inboundSources.get(edge.target);
    if (existing) existing.push(edge.source);
    else inboundSources.set(edge.target, [edge.source]);
  }
  return { nodeById, inboundSources };
}

export function findConfigurationSourceWithIndex(
  index: ConfigurationIndex,
  nodeId: string,
): KachangNode | null {
  const target = index.nodeById.get(nodeId);
  if (!target) return null;
  if (target.data.kind === "config") return target;
  if (!isGenerationModality(target.data.kind)) return null;

  const sources = index.inboundSources.get(nodeId);
  if (!sources) return null;
  for (let position = sources.length - 1; position >= 0; position -= 1) {
    const source = index.nodeById.get(sources[position]!);
    if (source?.data.kind !== "config") continue;
    const modality = source.data.config?.modality ?? "image";
    // Text configuration was removed from the canvas surface. Keep malformed
    // legacy records from binding text targets at runtime as well.
    if (!isConfigModality(modality)) continue;
    if (modality === target.data.kind) return source;
  }
  return null;
}

export function findConfigurationSource(
  nodeId: string,
  nodes: KachangNode[],
  edges: KachangEdge[],
): KachangNode | null {
  return findConfigurationSourceWithIndex(createConfigurationIndex(nodes, edges), nodeId);
}

let sharedIndexNodes: KachangNode[] | null = null;
let sharedIndexEdges: KachangEdge[] | null = null;
let sharedIndex: ConfigurationIndex | null = null;

/**
 * 同一份 nodes/edges 引用在多个节点组件、面板之间共享索引，避免每个节点各自重建一次。
 * 缓存只保留最新一份引用，不会累积历史快照；数组引用变化（任何图变更）即失效。
 */
export function getSharedConfigurationIndex(
  nodes: KachangNode[],
  edges: KachangEdge[],
): ConfigurationIndex {
  if (sharedIndex && sharedIndexNodes === nodes && sharedIndexEdges === edges) return sharedIndex;
  sharedIndexNodes = nodes;
  sharedIndexEdges = edges;
  sharedIndex = createConfigurationIndex(nodes, edges);
  return sharedIndex;
}

export function syncConfigurationTargets(
  nodes: KachangNode[],
  edges: KachangEdge[],
  sourceId: string,
): KachangNode[] {
  const index = createConfigurationIndex(nodes, edges);
  const source = index.nodeById.get(sourceId);
  if (source?.data.kind !== "config") return nodes;
  const modality = source.data.config?.modality ?? "image";
  if (!isConfigModality(modality)) return nodes;

  const targetIds = new Set(edges.filter((edge) => edge.source === sourceId).map((edge) => edge.target));
  if (!targetIds.size) return nodes;

  return nodes.map((node) => {
    if (!targetIds.has(node.id) || node.data.kind !== modality) return node;
    if (findConfigurationSourceWithIndex(index, node.id)?.id !== sourceId) return node;
    const generation = {
      ...node.data.generation,
      modelId: source.data.generation.modelId,
      parameters: structuredClone(source.data.generation.parameters),
      maxOutputTokens: source.data.generation.maxOutputTokens,
      error: null,
    };
    const syncedNode = {
      ...node,
      data: {
        ...node.data,
        generation,
        updatedAt: Date.now(),
      },
    };
    // 配置来源上自动写入的模型默认参数不代表创建者的选择，空目标节点保持
    // 默认画幅几何；用户在配置节点上显式配置过画幅才同步改写几何。
    if (!syncedNode.data.media && !source.data.generation.aspectExplicit) return syncedNode;
    return resizeMediaNodeToGenerationParameters(syncedNode, generation.parameters);
  });
}

export function resizeMediaNodeToGenerationParameters(
  node: KachangNode,
  parameters: Record<string, unknown>,
  preferredParameter?: string,
) {
  const aspectRatio = generationParametersAspectRatio(parameters, preferredParameter);
  return aspectRatio === null ? node : resizeMediaNodeToAspectRatio(node, aspectRatio);
}

export function resizeMediaNodeToAspectRatio(node: KachangNode, aspectRatio: number): KachangNode {
  if (node.data.kind !== "image" && node.data.kind !== "video") return node;
  const fallback = nodeDefaultDimensions(node.data.kind);
  const width = finitePositive(node.width) ?? finitePositive(node.measured?.width) ?? fallback.width;
  const height = finitePositive(node.height) ?? finitePositive(node.measured?.height) ?? fallback.height;
  const longEdge = Math.max(width, height);
  const nextWidth = aspectRatio >= 1 ? longEdge : Math.max(1, longEdge * aspectRatio);
  const nextHeight = aspectRatio >= 1 ? Math.max(1, longEdge / aspectRatio) : longEdge;
  if (Math.abs(width - nextWidth) < 0.0001 && Math.abs(height - nextHeight) < 0.0001) return node;

  return {
    ...node,
    width: nextWidth,
    height: nextHeight,
    position: {
      x: node.position.x + (width - nextWidth) / 2,
      y: node.position.y + (height - nextHeight) / 2,
    },
  };
}

function finitePositive(value: number | undefined) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : null;
}

function isConfigModality(value: unknown): value is Exclude<ModelModality, "text"> {
  return value === "image" || value === "video" || value === "audio";
}

export function syncAllConfigurationTargets(nodes: KachangNode[], edges: KachangEdge[]) {
  return nodes
    .filter((node) => node.data.kind === "config")
    .reduce((current, node) => syncConfigurationTargets(current, edges, node.id), nodes);
}
