import { Check, Image as ImageIcon, Link2, Plus, Video as VideoIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { canvasNodeLabels, type CanvasMedia } from "@weftcanvas/contracts";

import { useMediaThumbUrl } from "../hooks/use-media-url";
import { agentLinkRejectionMessage, agentLinkVerdict } from "../lib/agent-companion-drop";
import {
  MAX_AGENT_LINKED_NODES,
  useAgentLinkStore,
  useAgentLinkedNodeIds,
} from "../state/agent-link-store";
import { useCanvasStore } from "../state/canvas-store";
import { useToastStore } from "../state/toast-store";

const MATERIAL_POPUP_WIDTH = 264;

/** 拖线/拖节点时引用口的预告：可以松手引用，或者不行（附上原因，悬停时显示）。 */
export type AgentPortDrop = { state: "ready" | "blocked"; hint: string } | null;

/** 落点判定在引用口包围盒外再扩这么一圈：44px 的圆不要求鼠标正好压在边界以内。 */
export const AGENT_PORT_DROP_PADDING = 14;

/**
 * 画布上的 Agent 引用口：Agent 抽屉打开时，固定在画布列右侧、纵向居中的圆形加号。
 *
 * 它是画布之上的浮层，不是 ReactFlow 节点——不跟着平移/缩放走，也不进项目 JSON 和
 * Agent 画布摘要。从素材节点拖线到它、或把整个节点拖到它身上就是引用（落点由
 * canvas-workspace 按松手坐标判定）；点它弹出素材面板勾选。引用关系存在
 * agent-link-store，与抽屉素材条、右键菜单、拖到 Agent 形象身上共用一份状态。
 *
 * 离画布右缘留出 56px：xyflow 在距边 40px 内会自动平移画布，引用口要是贴边，
 * 拖线过来一悬停整个画布就开始滑。
 */
export const AgentMaterialPort = memo(function AgentMaterialPort({
  portRef,
  count,
  drop,
  pulse,
}: {
  portRef: RefObject<HTMLDivElement | null>;
  count: number;
  drop: AgentPortDrop;
  /** 每成功引用一次 +1，用来重放一次确认涟漪。 */
  pulse: number;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div
      ref={portRef}
      className={`wc-agent-port nodrag nopan nowheel${pickerOpen ? " is-open" : ""}`}
      data-drop={drop?.state}
      aria-label="Agent 参考素材入口"
    >
      <button
        type="button"
        aria-label="引用素材给 Agent"
        aria-expanded={pickerOpen}
        title="把图片或视频节点拖线到这里（或直接拖到这里），发送对话时会作为参考素材"
        onClick={() => setPickerOpen((current) => !current)}
      >
        <Plus className="wc-agent-port-icon-add" aria-hidden="true" />
        <Link2 className="wc-agent-port-icon-link" aria-hidden="true" />
      </button>
      {count ? (
        <i aria-label={`已引用 ${count} 个素材`} title={`已引用 ${count} 个素材`}>
          {count}
        </i>
      ) : null}
      {drop ? (
        <span className="wc-agent-port-hint" role="status">
          {drop.hint}
        </span>
      ) : null}
      {pulse ? <span key={pulse} className="wc-agent-port-ripple" aria-hidden="true" /> : null}
      {pickerOpen ? (
        <AgentMaterialPopup anchor={portRef} onClose={() => setPickerOpen(false)} />
      ) : null}
    </div>
  );
});

/** 引用素材的小缩略图：图片走画布同款缩略地址，视频只画图标（不在列表里解码视频）。 */
export function AgentMaterialThumb({
  media,
  kind,
}: {
  media: CanvasMedia | null | undefined;
  kind: string;
}) {
  const { url } = useMediaThumbUrl(kind === "image" ? media : null);
  return (
    <span className={`wc-agent-material-thumb is-${kind === "video" ? "video" : "image"}`}>
      {url ? (
        <img src={url} alt="" draggable={false} decoding="async" />
      ) : kind === "video" ? (
        <VideoIcon aria-hidden="true" />
      ) : (
        <ImageIcon aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * 引用素材选择面板：列出画布上真正能作为参考素材的节点（带图片/视频的
 * image/video 节点），点击即引用/取消，发送对话时由抽屉把素材读成本轮附件。
 */
function AgentMaterialPopup({
  anchor,
  onClose,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const projectId = useCanvasStore((state) => state.projectId);
  const linkedIds = useAgentLinkedNodeIds(projectId);
  const addLink = useAgentLinkStore((state) => state.add);
  const removeLink = useAgentLinkStore((state) => state.remove);
  const showToast = useToastStore((state) => state.show);
  // zustand v5 的选择器快照必须引用稳定：先选原始 nodes，再 useMemo 派生素材
  // 节点列表，否则 filter 的新数组会触发 useSyncExternalStore 无限重渲。
  const nodes = useCanvasStore((state) => state.nodes);
  const mediaNodes = useMemo(
    () =>
      nodes.filter(
        (node) => node.data.media && (node.data.kind === "image" || node.data.kind === "video"),
      ),
    [nodes],
  );
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element) {
        if (anchor.current?.contains(target) || popupRef.current?.contains(target)) return;
      }
      onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keyboard);
    };
  }, [anchor, onClose]);

  // 引用口在画布列右侧，面板固定向左弹；纵向以引用口为中心并夹进视口。
  const popupStyle = useMemo(() => {
    const rect = anchor.current?.getBoundingClientRect();
    const left = rect ? Math.max(12, rect.left - MATERIAL_POPUP_WIDTH - 12) : 12;
    const top = rect
      ? Math.min(Math.max(12, rect.top + rect.height / 2 - 120), window.innerHeight - 340)
      : 12;
    return { left, top: Math.max(12, top), width: MATERIAL_POPUP_WIDTH };
  }, [anchor]);

  const toggle = (nodeId: string) => {
    if (linkedIds.includes(nodeId)) {
      removeLink(projectId, nodeId);
      return;
    }
    const node = nodes.find((item) => item.id === nodeId);
    const verdict = agentLinkVerdict(node, linkedIds, MAX_AGENT_LINKED_NODES);
    if (!verdict.ok) {
      showToast(agentLinkRejectionMessage(verdict.reason, MAX_AGENT_LINKED_NODES), "error");
      return;
    }
    addLink(projectId, nodeId);
  };

  return createPortal(
    <div
      ref={popupRef}
      className="wc-agent-material-popup"
      role="group"
      aria-label="引用素材给 Agent"
      style={popupStyle}
    >
      <header>
        <strong>引用素材给 Agent</strong>
        <small>
          {linkedIds.length}/{MAX_AGENT_LINKED_NODES} · 发送对话时作为参考素材
        </small>
      </header>
      {mediaNodes.length ? (
        <div className="wc-agent-material-list" role="listbox" aria-multiselectable="true">
          {mediaNodes.map((node) => {
            const linked = linkedIds.includes(node.id);
            const kindLabel =
              node.data.kind in canvasNodeLabels
                ? canvasNodeLabels[node.data.kind as keyof typeof canvasNodeLabels]
                : "节点";
            const name = node.data.media?.name;
            return (
              <button
                key={node.id}
                type="button"
                role="option"
                aria-selected={linked}
                title={name ? `${kindLabel} · ${name}` : kindLabel}
                onClick={() => toggle(node.id)}
              >
                <AgentMaterialThumb media={node.data.media} kind={node.data.kind} />
                <span>{name ? `${kindLabel} · ${name}` : kindLabel}</span>
                {linked ? <Check aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="wc-agent-material-empty">
          画布上还没有带图片或视频的节点。生成或导入素材后，把节点拖线到引用口即可。
        </p>
      )}
    </div>,
    document.body,
  );
}
