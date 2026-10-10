import type { Connection, Edge, HandleType } from "@xyflow/react";

const nodeSourceHandleId = "right-source";
const nodeTargetHandleId = "left-target";

export type NodeBodyConnectionStart = {
  nodeId: string;
  handleId: string;
  handleType: HandleType;
};

export function createNodeBodyConnection(
  start: NodeBodyConnectionStart,
  dropNodeId: string,
  edges: readonly Pick<Edge, "source" | "target">[],
): Connection | null {
  if (!dropNodeId || dropNodeId === start.nodeId) return null;

  const fromSource = start.handleType === "source";
  const source = fromSource ? start.nodeId : dropNodeId;
  const target = fromSource ? dropNodeId : start.nodeId;
  if (edges.some((edge) => edge.source === source && edge.target === target)) return null;

  return {
    source,
    target,
    sourceHandle: fromSource ? start.handleId : nodeSourceHandleId,
    targetHandle: fromSource ? nodeTargetHandleId : start.handleId,
  };
}
