import type { Connection } from "@xyflow/react";

import type { KachangNode } from "../types";
import { getNodeDefinition, type NodeConnectionContext } from "./node-registry";

/**
 * 连线类型策略（docs/PLUGIN-ROADMAP.md §3）：节点定义可选声明
 * connectionPolicy；只有**两端**节点里至少一端带策略时才校验，缺省走宿主
 * 全局规则（自环/重复边在调用方用连接键缓存处理，这里不重复扫描 edges）。
 */
export function connectionPolicyAllows(
  connection: {
    sourceId: string;
    targetId: string;
    sourceHandle: string | null | undefined;
    targetHandle: string | null | undefined;
  },
  nodes: readonly KachangNode[],
): boolean {
  const sourceNode = nodes.find((node) => node.id === connection.sourceId);
  const targetNode = nodes.find((node) => node.id === connection.targetId);
  if (!sourceNode || !targetNode) return true;
  const sourceDefinition = getNodeDefinition(sourceNode.data.kind);
  const targetDefinition = getNodeDefinition(targetNode.data.kind);
  const sourcePolicy = sourceDefinition?.connectionPolicy;
  const targetPolicy = targetDefinition?.connectionPolicy;
  if (!sourcePolicy && !targetPolicy) return true;
  const context: NodeConnectionContext = {
    sourceKind: sourceNode.data.kind,
    targetKind: targetNode.data.kind,
    sourceHandle: connection.sourceHandle,
    targetHandle: connection.targetHandle,
  };
  if (sourcePolicy && !sourcePolicy(context)) return false;
  if (targetPolicy && !targetPolicy(context)) return false;
  return true;
}
