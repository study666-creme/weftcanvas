import type { CanvasGroup, CanvasNodeData, CanvasProject } from "@weftcanvas/contracts";
import type { Edge, Node } from "@xyflow/react";

export type WeftcanvasNode = Node<CanvasNodeData, "weftcanvas">;
export type WeftcanvasEdge = Edge;

export type GraphSnapshot = {
  nodes: WeftcanvasNode[];
  edges: WeftcanvasEdge[];
  groups: CanvasGroup[];
};

export type PersistedProject = CanvasProject;
