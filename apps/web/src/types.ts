import type { CanvasGroup, CanvasNodeData, CanvasProject } from "@kachang/contracts";
import type { Edge, Node } from "@xyflow/react";

export type KachangNode = Node<CanvasNodeData, "kachang">;
export type KachangEdge = Edge;

export type GraphSnapshot = {
  nodes: KachangNode[];
  edges: KachangEdge[];
  groups: CanvasGroup[];
};

export type PersistedProject = CanvasProject;
