import type { XYPosition } from "@xyflow/react";

import type { KachangNode } from "../types";

const NODE_GAP = 30;

export function findOpenNodePosition(
  preferred: XYPosition,
  dimensions: { width: number; height: number },
  nodes: KachangNode[],
): XYPosition {
  const xStep = Math.max(dimensions.width, ...nodes.map(nodeWidth)) + NODE_GAP * 2;
  const yStep = Math.max(dimensions.height, ...nodes.map(nodeHeight)) + NODE_GAP * 2;
  const offsets: [number, number][] = [[0, 0]];

  for (let ring = 1; ring <= 6; ring += 1) {
    offsets.push([ring, 0], [-ring, 0], [0, ring], [0, -ring]);
    for (let cross = 1; cross < ring; cross += 1) {
      offsets.push([ring, cross], [ring, -cross], [-ring, cross], [-ring, -cross]);
    }
  }

  for (const [column, row] of offsets) {
    const candidate = { x: preferred.x + column * xStep, y: preferred.y + row * yStep };
    if (nodes.every((node) => !overlaps(candidate, dimensions.width, dimensions.height, node))) return candidate;
  }

  return { x: preferred.x + xStep * 7, y: preferred.y };
}

export function findConnectedNodePosition(
  anchor: KachangNode,
  draft: KachangNode,
  side: "left" | "right",
  nodes: KachangNode[],
): XYPosition {
  const anchorWidth = nodeWidth(anchor);
  const anchorHeight = nodeHeight(anchor);
  const draftWidth = nodeWidth(draft);
  const draftHeight = nodeHeight(draft);
  const base = {
    x: side === "right" ? anchor.position.x + anchorWidth + 64 : anchor.position.x - draftWidth - 64,
    y: anchor.position.y + (anchorHeight - draftHeight) / 2,
  };
  const verticalStep = Math.max(anchorHeight, draftHeight) + NODE_GAP * 2;
  const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4];

  for (const offset of offsets) {
    const candidate = { x: base.x, y: base.y + offset * verticalStep };
    if (nodes.every((node) => !overlaps(candidate, draftWidth, draftHeight, node))) return candidate;
  }

  return { x: base.x, y: base.y + offsets.length * verticalStep };
}

/**
 * Place a multi-output result in one predictable vertical column. The anchor
 * remains where it was; every generated sibling shares one x-coordinate and
 * the column is centered on the anchor's visual center. Existing unrelated
 * nodes may move the whole column by a small bounded amount, but siblings are
 * never independently scattered by the generic collision search.
 */
export function findConnectedNodeColumnPositions(
  anchor: KachangNode,
  drafts: KachangNode[],
  nodes: KachangNode[],
): XYPosition[] {
  if (!drafts.length) return [];
  const anchorWidth = nodeWidth(anchor);
  const anchorHeight = nodeHeight(anchor);
  const x = anchor.position.x + anchorWidth + 64;
  const gap = NODE_GAP;
  const heights = drafts.map(nodeHeight);
  const totalHeight = heights.reduce((sum, height) => sum + height, 0) + gap * Math.max(0, drafts.length - 1);
  const firstY = anchor.position.y + (anchorHeight - totalHeight) / 2;
  const occupied = nodes.filter((node) => node.id !== anchor.id && !drafts.some((draft) => draft.id === node.id));
  const shiftStep = Math.max(anchorHeight, ...heights) + gap * 2;
  const shifts = [0, shiftStep, -shiftStep, shiftStep * 2, -shiftStep * 2, shiftStep * 3, -shiftStep * 3, shiftStep * 4, -shiftStep * 4];

  for (const shift of shifts) {
    const positions: XYPosition[] = [];
    let y = firstY + shift;
    for (const height of heights) {
      positions.push({ x, y });
      y += height + gap;
    }
    if (positions.every((position, index) => occupied.every((node) => !overlaps(position, nodeWidth(drafts[index]!), heights[index]!, node)))) {
      return positions;
    }
  }

  return heights.map((height, index) => ({
    x,
    y: firstY + shiftStep * 5 + heights.slice(0, index).reduce((sum, value) => sum + value + gap, 0),
  }));
}

function overlaps(position: XYPosition, width: number, height: number, node: KachangNode) {
  const other = {
    left: node.position.x,
    top: node.position.y,
    right: node.position.x + nodeWidth(node),
    bottom: node.position.y + nodeHeight(node),
  };
  return position.x < other.right + NODE_GAP
    && position.x + width > other.left - NODE_GAP
    && position.y < other.bottom + NODE_GAP
    && position.y + height > other.top - NODE_GAP;
}

function nodeWidth(node: KachangNode) {
  return node.width ?? node.measured?.width ?? 300;
}

function nodeHeight(node: KachangNode) {
  return node.height ?? node.measured?.height ?? 176;
}
