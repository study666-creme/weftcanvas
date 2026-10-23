import type { CanvasNodeKind } from "@weftcanvas/contracts";
import { useCreatableNodeDefinitions } from "../lib/node-registry";
import {
  ClipboardPaste,
  Copy,
  Eraser,
  Files,
  FolderPlus,
  Group,
  Link2,
  Puzzle,
  Trash2,
  Ungroup,
  Unlink,
  Upload,
} from "lucide-react";
import type { XYPosition } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { nodeCreationDimensions } from "../lib/node-factory";
import { findOpenNodePosition } from "../lib/node-placement";
import { useAgentLinkStore } from "../state/agent-link-store";
import { useAgentStore } from "../state/agent-store";
import { useCanvasStore } from "../state/canvas-store";
import { useProjectAssetStore } from "../state/project-asset-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";

export type CanvasMenuState = {
  clientX: number;
  clientY: number;
  flowPosition: XYPosition;
  zoom: number;
  nodeId?: string;
  edgeId?: string;
};

export function CanvasContextMenu({
  menu,
  onClose,
  onRequestClear,
  onRequestUpload,
}: {
  menu: CanvasMenuState;
  onClose: () => void;
  onRequestClear: () => void;
  onRequestUpload?: (anchor: XYPosition) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const addNode = useCanvasStore((state) => state.addNode);
  const copySelection = useCanvasStore((state) => state.copySelection);
  const duplicateSelection = useCanvasStore((state) => state.duplicateSelection);
  const pasteSelection = useCanvasStore((state) => state.pasteSelection);
  const deleteSelection = useCanvasStore((state) => state.deleteSelection);
  const groupSelection = useCanvasStore((state) => state.groupSelection);
  const ungroupSelection = useCanvasStore((state) => state.ungroupSelection);
  const canPaste = useCanvasStore((state) => Boolean(state.clipboard?.nodes.length));
  const nodes = useCanvasStore((state) => state.nodes);
  const groups = useCanvasStore((state) => state.groups);
  const creatableNodes = useCreatableNodeDefinitions();
  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);
  const selectedCount = selectedNodes.length;
  const occupied = useMemo(() => new Set(groups.flatMap((group) => group.nodeIds)), [groups]);
  const selectedIds = useMemo(() => new Set(selectedNodes.map((node) => node.id)), [selectedNodes]);
  // 右键节点可手动存入项目工作资产库：有媒体存媒体，纯文本存提示词。
  const menuNode = menu.nodeId ? (nodes.find((node) => node.id === menu.nodeId) ?? null) : null;
  const projectId = useCanvasStore((state) => state.projectId);
  const agentOpen = useAgentStore((state) => state.open);
  // 选择器必须返回稳定值：`?? []` 每次都是新数组，会让 zustand 无限重渲染。
  const linkedNodeIds = useAgentLinkStore((state) => state.linksByProject[projectId]);
  const toggleAgentLink = useAgentLinkStore((state) => state.toggle);
  const agentLinkable =
    agentOpen &&
    menuNode &&
    Boolean(menuNode.data.media) &&
    (menuNode.data.kind === "image" || menuNode.data.kind === "video");
  const agentLinked = Boolean(agentLinkable && menuNode && linkedNodeIds?.includes(menuNode.id));
  const agentLinkNodeId = menu.edgeId?.startsWith("agent-link:")
    ? menu.edgeId.slice("agent-link:".length)
    : null;
  const libraryCandidate =
    menuNode && (menuNode.data.media || menuNode.data.body.trim()) ? menuNode : null;
  const saveNodeAsset = useProjectAssetStore((state) => state.saveNodeAsset);
  const canGroup = selectedCount >= 2 && selectedNodes.every((node) => !occupied.has(node.id));
  const canUngroup = groups.some((group) => group.nodeIds.some((id) => selectedIds.has(id)));
  const selectionActionCount = Number(canGroup || canUngroup) + (selectedCount ? 2 : 0);
  const itemCount = menu.edgeId
    ? 1
    : menu.nodeId
      ? 3 +
        Number(Boolean(libraryCandidate)) +
        Number(canPaste) +
        Number(canGroup || canUngroup) +
        Number(Boolean(agentLinkable))
      : creatableNodes.length +
        Number(canPaste) +
        selectionActionCount +
        1 +
        Number(Boolean(onRequestUpload));
  const estimatedPosition = useMemo(
    () => ({
      left: clamp(menu.clientX, 12, window.innerWidth - 196),
      top: clamp(menu.clientY, 12, window.innerHeight - (itemCount * 38 + 32)),
    }),
    [itemCount, menu.clientX, menu.clientY],
  );
  const [position, setPosition] = useState(estimatedPosition);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const next = {
      left: clamp(menu.clientX, 12, window.innerWidth - element.offsetWidth - 12),
      top: clamp(menu.clientY, 12, window.innerHeight - element.offsetHeight - 12),
    };
    setPosition((current) =>
      current.left === next.left && current.top === next.top ? current : next,
    );
  }, [itemCount, menu.clientX, menu.clientY]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissWithKeyboard);
    window.addEventListener("resize", onClose);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissWithKeyboard);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const add = (kind: CanvasNodeKind) => {
    const dimensions = nodeCreationDimensions(
      kind,
      useUiPreferencesStore.getState().defaultNodeAspectRatio,
    );
    const preferred = {
      x: menu.flowPosition.x - dimensions.width / 2,
      y: menu.flowPosition.y - dimensions.height / 2,
    };
    addNode(kind, findOpenNodePosition(preferred, dimensions, useCanvasStore.getState().nodes));
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="wc-context-menu"
      role="menu"
      aria-label={menu.edgeId ? "连线操作" : menu.nodeId ? "节点操作" : "画布操作"}
      data-wc-block-canvas-shortcuts
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {menu.edgeId ? (
        agentLinkNodeId ? (
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              toggleAgentLink(projectId, agentLinkNodeId);
              onClose();
            }}
          >
            <Unlink aria-hidden="true" />
            取消 Agent 参考
          </button>
        ) : (
          <button
            role="menuitem"
            type="button"
            className="is-danger"
            onClick={() => {
              deleteSelection();
              onClose();
            }}
          >
            <Trash2 aria-hidden="true" />
            删除连线
          </button>
        )
      ) : menu.nodeId ? (
        <>
          {canUngroup ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                ungroupSelection();
                onClose();
              }}
            >
              <Ungroup aria-hidden="true" />
              解散组合
            </button>
          ) : null}
          {canGroup ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                groupSelection();
                onClose();
              }}
            >
              <Group aria-hidden="true" />
              组合 {selectedCount} 个节点
            </button>
          ) : null}
          {canGroup || canUngroup ? (
            <span className="wc-context-menu-divider" aria-hidden="true" />
          ) : null}
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              copySelection();
              onClose();
            }}
          >
            <Copy aria-hidden="true" />
            复制{selectedCount > 1 ? "选中节点" : "节点"}
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              duplicateSelection();
              onClose();
            }}
          >
            <Files aria-hidden="true" />
            创建副本
          </button>
          {libraryCandidate ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                void saveNodeAsset({
                  media: libraryCandidate.data.media,
                  body: libraryCandidate.data.body,
                });
                onClose();
              }}
            >
              <FolderPlus aria-hidden="true" />
              存入工作资产库
            </button>
          ) : null}
          {agentLinkable && menuNode ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                toggleAgentLink(projectId, menuNode.id);
                onClose();
              }}
            >
              {agentLinked ? <Unlink aria-hidden="true" /> : <Link2 aria-hidden="true" />}
              {agentLinked ? "取消 Agent 参考" : "引用到 Agent"}
            </button>
          ) : null}
          {canPaste ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                pasteSelection(menu.flowPosition);
                onClose();
              }}
            >
              <ClipboardPaste aria-hidden="true" />
              粘贴到此处
            </button>
          ) : null}
          <span className="wc-context-menu-divider" aria-hidden="true" />
          <button
            role="menuitem"
            type="button"
            className="is-danger"
            onClick={() => {
              deleteSelection();
              onClose();
            }}
          >
            <Trash2 aria-hidden="true" />
            删除{selectedCount > 1 ? "选中节点" : "节点"}
          </button>
        </>
      ) : (
        <>
          {selectedCount ? (
            <>
              {canUngroup ? (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    ungroupSelection();
                    onClose();
                  }}
                >
                  <Ungroup aria-hidden="true" />
                  解散组合
                </button>
              ) : null}
              {canGroup ? (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    groupSelection();
                    onClose();
                  }}
                >
                  <Group aria-hidden="true" />
                  组合 {selectedCount} 个节点
                </button>
              ) : null}
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  duplicateSelection();
                  onClose();
                }}
              >
                <Files aria-hidden="true" />
                创建选中节点副本
              </button>
              <button
                role="menuitem"
                type="button"
                className="is-danger"
                onClick={() => {
                  deleteSelection();
                  onClose();
                }}
              >
                <Trash2 aria-hidden="true" />
                删除选中节点
              </button>
              <span className="wc-context-menu-divider" aria-hidden="true" />
            </>
          ) : null}
          {canPaste ? (
            <>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  pasteSelection(menu.flowPosition);
                  onClose();
                }}
              >
                <ClipboardPaste aria-hidden="true" />
                粘贴到此处
              </button>
              <span className="wc-context-menu-divider" aria-hidden="true" />
            </>
          ) : null}
          {creatableNodes.map((definition) => {
            const Icon = definition.icon ?? Puzzle;
            return (
              <button
                role="menuitem"
                key={definition.kind}
                type="button"
                onClick={() => add(definition.kind)}
              >
                <Icon aria-hidden="true" />
                添加{definition.label()}
              </button>
            );
          })}
          {onRequestUpload ? (
            <>
              <span className="wc-context-menu-divider" aria-hidden="true" />
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  onRequestUpload(menu.flowPosition);
                  onClose();
                }}
              >
                <Upload aria-hidden="true" />
                上传
              </button>
            </>
          ) : null}
          <span className="wc-context-menu-divider" aria-hidden="true" />
          <button
            role="menuitem"
            type="button"
            className="is-danger"
            onClick={() => {
              onClose();
              onRequestClear();
            }}
          >
            <Eraser aria-hidden="true" />
            清空画布
          </button>
        </>
      )}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
