import type { AgentCanvasContext, AgentCreativeGuidance } from "@weftcanvas/contracts";

import { createAgentCanvasContext, readAgentDirectorStageContext } from "./agent-context";
import { readAgentCreativeGuidance } from "./agent-creative-guidance";
import { useCanvasStore } from "../state/canvas-store";
import { useDirectorStageLaunchStore } from "../state/director-stage-launch-store";

/**
 * 读取当前画布的有界摘要。Agent 对话与外部连接（Codex 画布通道）共用同一份，
 * 保证两边的 contextRevision 与节点 id 完全一致。
 */
export function readCurrentAgentCanvasContext(
  creativeGuidance?: AgentCreativeGuidance,
): AgentCanvasContext {
  const canvas = useCanvasStore.getState();
  const director = useDirectorStageLaunchStore.getState();
  return createAgentCanvasContext({
    projectId: canvas.projectId,
    projectName: canvas.projectName,
    nodes: canvas.nodes,
    edges: canvas.edges,
    groups: canvas.groups,
    viewport: canvas.viewport,
    directorStage: readAgentDirectorStageContext(canvas.projectId, director.open),
    creativeGuidance: creativeGuidance ?? readAgentCreativeGuidance(canvas.projectId),
  });
}
