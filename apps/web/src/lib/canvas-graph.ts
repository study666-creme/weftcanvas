import type { WeftcanvasEdge } from "../types";

export function indexIncomingNodeIds(edges: readonly WeftcanvasEdge[]) {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const sources = incoming.get(edge.target);
    if (!sources) {
      incoming.set(edge.target, [edge.source]);
    } else if (!sources.includes(edge.source)) {
      sources.push(edge.source);
    }
  }
  return incoming;
}
