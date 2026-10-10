import type { CanvasGroup } from "@kachang/contracts";

import type { KachangNode } from "../types";

export const GROUP_FRAME_PADDING = 20;
export const GROUP_FRAME_HEADER = 34;
export const DEFAULT_GROUP_COLOR = "#9ca3a0";
export const GROUP_COLOR_PALETTE = ["#9ca3a0", "#a89f8d", "#76958d", "#748da4", "#aa8279", "#a68d61"] as const;

export type NodeGroupBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CanvasNodeIndex = ReadonlyMap<string, KachangNode>;

function nodeWidth(node: KachangNode) {
  return node.width ?? node.measured?.width ?? 280;
}

function nodeHeight(node: KachangNode) {
  return node.height ?? node.measured?.height ?? 160;
}

export function indexCanvasNodes(nodes: KachangNode[]): CanvasNodeIndex {
  return new Map(nodes.map((node) => [node.id, node]));
}

export function getGroupBounds(
  group: CanvasGroup,
  nodes: KachangNode[],
  index: CanvasNodeIndex = indexCanvasNodes(nodes),
): NodeGroupBounds | null {
  let memberCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const nodeId of group.nodeIds) {
    const node = index.get(nodeId);
    if (!node) continue;
    memberCount += 1;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + nodeWidth(node));
    maxY = Math.max(maxY, node.position.y + nodeHeight(node));
  }

  if (memberCount < 2) return null;

  return {
    x: minX - GROUP_FRAME_PADDING,
    y: minY - GROUP_FRAME_PADDING - GROUP_FRAME_HEADER,
    width: maxX - minX + GROUP_FRAME_PADDING * 2,
    height: maxY - minY + GROUP_FRAME_PADDING * 2 + GROUP_FRAME_HEADER,
  };
}

export function nextGroupName(groups: CanvasGroup[]) {
  const names = new Set(groups.map((group) => group.name));
  for (let index = 1; index < 1000; index += 1) {
    const name = `组 ${index}`;
    if (!names.has(name)) return name;
  }
  return `组 ${groups.length + 1}`;
}

export function pickGroupColor(groups: CanvasGroup[]) {
  const usage = new Map<string, number>();
  GROUP_COLOR_PALETTE.forEach((color) => usage.set(color, 0));
  groups.forEach((group) => usage.set(group.color, (usage.get(group.color) ?? 0) + 1));
  return [...GROUP_COLOR_PALETTE].sort((left, right) => (usage.get(left) ?? 0) - (usage.get(right) ?? 0))[0] ?? DEFAULT_GROUP_COLOR;
}

export function normalizeGroups(groups: CanvasGroup[], nodes: KachangNode[]) {
  const existing = new Set(nodes.map((node) => node.id));
  return groups.flatMap((group) => {
    const nodeIds = [...new Set(group.nodeIds)].filter((id) => existing.has(id));
    if (nodeIds.length < 2) return [];
    return nodeIds.length === group.nodeIds.length ? [group] : [{ ...group, nodeIds, updatedAt: Date.now() }];
  });
}

export function arrangeGroupNodes(nodes: KachangNode[], group: CanvasGroup) {
  const members = group.nodeIds.map((id) => nodes.find((node) => node.id === id)).filter((node): node is KachangNode => Boolean(node));
  if (members.length < 2) return nodes;

  const sorted = [...members].sort((left, right) => left.position.y - right.position.y || left.position.x - right.position.x);
  const anchorX = Math.min(...sorted.map((node) => node.position.x));
  const anchorY = Math.min(...sorted.map((node) => node.position.y));
  const columnWidth = Math.max(...sorted.map(nodeWidth)) + 28;
  const rowHeight = Math.max(...sorted.map(nodeHeight)) + 28;
  const columns = Math.ceil(Math.sqrt(sorted.length));
  const positions = new Map(sorted.map((node, index) => [
    node.id,
    {
      x: anchorX + (index % columns) * columnWidth,
      y: anchorY + Math.floor(index / columns) * rowHeight,
    },
  ]));

  return nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node);
}
