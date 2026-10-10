import { CANVAS_SCHEMA_VERSION, canvasProjectSchema } from "@kachang/contracts";

import type { GraphSnapshot, KachangEdge, KachangNode } from "../types";

export const KACHANG_CANVAS_CLIPBOARD_MIME = "application/x-kachang-canvas-selection";
export const KACHANG_CANVAS_CLIPBOARD_TEXT = "Kachang Canvas selection";

const MAX_CLIPBOARD_BYTES = 2_000_000;

export function serializeCanvasClipboard(snapshot: GraphSnapshot) {
  return JSON.stringify({
    kind: "kachang-canvas-selection",
    version: CANVAS_SCHEMA_VERSION,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    groups: snapshot.groups,
  });
}

export function parseCanvasClipboard(value: string): GraphSnapshot | null {
  if (!value || value.length > MAX_CLIPBOARD_BYTES) return null;
  try {
    const payload = JSON.parse(value) as unknown;
    if (!payload || typeof payload !== "object") return null;
    const candidate = payload as Record<string, unknown>;
    if (candidate.kind !== "kachang-canvas-selection" || candidate.version !== CANVAS_SCHEMA_VERSION) return null;
    const now = Date.now();
    const parsed = canvasProjectSchema.safeParse({
      schemaVersion: CANVAS_SCHEMA_VERSION,
      id: "clipboard",
      name: "Clipboard",
      nodes: candidate.nodes,
      edges: candidate.edges,
      groups: candidate.groups,
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now,
    });
    if (!parsed.success || !parsed.data.nodes.length) return null;
    const ids = new Set(parsed.data.nodes.map((node) => node.id));
    const nodes = parsed.data.nodes.map((node) => ({ ...node, type: "kachang" as const })) as KachangNode[];
    const edges = parsed.data.edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ ...edge, type: "kachang" })) as KachangEdge[];
    const groups = parsed.data.groups.filter((group) => group.nodeIds.every((id) => ids.has(id)));
    return { nodes, edges, groups };
  } catch {
    return null;
  }
}
