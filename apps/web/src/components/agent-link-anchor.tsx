import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Link2 } from "lucide-react";
import { memo } from "react";

export const AGENT_ANCHOR_NODE_ID = "__agent_anchor__";
export const AGENT_ANCHOR_HANDLE_ID = "agent-ref";

export type AgentAnchorNode = Node<{ count: number }, "agent-anchor">;

/**
 * 画布上的 Agent 引用口：只在抽屉打开时挂到右侧，接收节点连线。
 * 它不是画布文档里的节点——既不进项目 JSON，也不进 Agent 画布摘要；
 * 连线关系由 agent-link-store 单独保存。
 */
export const AgentLinkAnchorNodeView = memo(function AgentLinkAnchorNodeView({
  data,
  selected,
}: NodeProps<AgentAnchorNode>) {
  return (
    <div
      className={`wc-agent-anchor${selected ? " is-selected" : ""}`}
      aria-label="Agent 参考素材入口"
      title="把图片或视频节点连到这里，发送对话时会作为参考素材"
    >
      <Handle
        id={AGENT_ANCHOR_HANDLE_ID}
        type="target"
        position={Position.Left}
        className="wc-agent-anchor-handle"
      />
      <span className="wc-agent-anchor-icon" aria-hidden="true">
        <Link2 />
      </span>
      <span className="wc-agent-anchor-copy">
        <strong>Agent 参考</strong>
        <small>{data.count ? `已连 ${data.count} 个素材节点` : "把节点连到这里"}</small>
      </span>
    </div>
  );
});
