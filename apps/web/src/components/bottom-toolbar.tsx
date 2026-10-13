import { type CanvasNodeKind } from "@weftcanvas/contracts";
import {
  Clapperboard,
  Eraser,
  Hand,
  Plus,
  Puzzle,
  Redo2,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import { memo, useEffect, useRef, type RefObject } from "react";

import resourceLibraryLogo from "../assets/resource-library-mark.png";
import { nodeCreationDimensions } from "../lib/node-factory";
import { findOpenNodePosition } from "../lib/node-placement";
import { useCanvasStore } from "../state/canvas-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import { useUiShellStore } from "../state/ui-shell-store";
import { useCreatableNodeDefinitions } from "../lib/node-registry";
import type { InsertableAsset } from "../lib/insertable-asset";
import type { WeftcanvasEdge, WeftcanvasNode } from "../types";
import { AppearanceToolbar } from "./appearance-toolbar";
import { CommunityRail } from "./community-rail";

/**
 * 底部 dock + 创建栏。
 *
 * appearanceOpen 状态已提升到 canvas-workspace，触发器由顶部 TopBarSettings 和
 * 底部 UI 设置按钮共用同一个 ref。两个入口共存：顶部设置键（hover 弹 创作设置/
 * 项目协作 / 点击开「设置」面板）+ 底部 dock 的 UI 设置键（点击开同一面板）。
 */
export const BottomToolbar = memo(function BottomToolbar({
  panMode,
  resourceOpen,
  onTogglePan,
  onToggleResource,
  onOpenDirector,
  onImport,
  onRequestClear,
  getCanvasCenter,
  appearanceOpen,
  appearanceTriggerRef,
  onToggleAppearance,
  onCloseAppearance,
  onInsertAsset,
}: {
  panMode: boolean;
  resourceOpen: boolean;
  onTogglePan: () => void;
  onToggleResource: () => void;
  onOpenDirector: () => void;
  onImport: () => void;
  onRequestClear: () => void;
  getCanvasCenter: () => { x: number; y: number };
  appearanceOpen: boolean;
  appearanceTriggerRef: RefObject<HTMLButtonElement | null>;
  onToggleAppearance: () => void;
  onCloseAppearance: () => void;
  onInsertAsset?: (asset: InsertableAsset) => void;
}) {
  const addNode = useCanvasStore((state) => state.addNode);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const canUndo = useCanvasStore((state) => state.past.length > 0);
  const canRedo = useCanvasStore((state) => state.future.length > 0);
  const hasSelection = useCanvasStore(
    (state) =>
      state.nodes.some((node) => node.selected) || state.edges.some((edge) => edge.selected),
  );
  const hasContent = useCanvasStore((state) => state.nodes.length > 0 || state.edges.length > 0);
  const deleteSelection = useCanvasStore((state) => state.deleteSelection);
  const defaultNodeAspectRatio = useUiPreferencesStore((state) => state.defaultNodeAspectRatio);
  const settingsSection = useUiShellStore((state) => state.settingsSection);
  const setSettingsSection = useUiShellStore((state) => state.setSettingsSection);
  const creatableNodes = useCreatableNodeDefinitions();
  const { getZoom, screenToFlowPosition, setCenter } = useReactFlow<
    WeftcanvasNode,
    WeftcanvasEdge
  >();
  const dockRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!appearanceOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (dockRef.current?.contains(target)) return;
        // 顶部设置键自己管理开合（点击 = 切换面板），不走"点外关闭"，
        // 否则 pointerdown 先关、click 再开，面板永远关不掉。
        if (target instanceof Element && target.closest(".wc-topbar-settings")) return;
      }
      onCloseAppearance();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseAppearance();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [appearanceOpen, onCloseAppearance]);

  useEffect(() => {
    if (resourceOpen) onCloseAppearance();
  }, [resourceOpen, onCloseAppearance]);

  const createAtCenter = (kind: CanvasNodeKind) => {
    const position = screenToFlowPosition(getCanvasCenter());
    const dimensions = nodeCreationDimensions(kind, defaultNodeAspectRatio);
    const preferred = {
      x: position.x - dimensions.width / 2,
      y: position.y - dimensions.height / 2,
    };
    const openPosition = findOpenNodePosition(
      preferred,
      dimensions,
      useCanvasStore.getState().nodes,
    );
    addNode(kind, openPosition);
    window.requestAnimationFrame(() => {
      void setCenter(
        openPosition.x + dimensions.width / 2,
        openPosition.y + dimensions.height / 2,
        {
          zoom: getZoom(),
          duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180,
        },
      );
    });
  };

  return (
    <>
      <nav className="wc-create-rail" aria-label="创建工具">
        <div className="wc-create-rail-plus-wrapper">
          <button
            type="button"
            className="wc-create-rail-plus"
            aria-label="添加节点"
            aria-haspopup="menu"
            aria-expanded="false"
            title="添加节点"
          >
            <Plus aria-hidden="true" />
          </button>
          <div className="wc-create-rail-popover" role="menu" aria-label="节点类型">
            {creatableNodes.map((definition) => {
              const Icon = definition.icon ?? Puzzle;
              const label = definition.label();
              return (
                <button
                  key={definition.kind}
                  type="button"
                  role="menuitem"
                  className={`wc-add-node wc-add-node--${definition.kind}`}
                  aria-label={`添加${label}`}
                  title={`添加${label}`}
                  onClick={() => createAtCenter(definition.kind)}
                >
                  <Icon aria-hidden="true" />
                  <span className="wc-add-node-label">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <span className="wc-create-rail-divider" aria-hidden="true" />
        <button type="button" aria-label="导入素材" title="导入素材" onClick={onImport}>
          <Upload aria-hidden="true" />
        </button>
        <button
          type="button"
          className="wc-director-button"
          aria-label="打开 3D 导演台"
          title="3D 导演台"
          onClick={onOpenDirector}
        >
          <Clapperboard aria-hidden="true" />
        </button>
        <CommunityRail onInsertAsset={onInsertAsset} />
      </nav>

      <nav ref={dockRef} className="wc-edit-dock" aria-label="编辑工具">
        <AppearanceToolbar
          open={appearanceOpen}
          triggerRef={appearanceTriggerRef}
          onClose={onCloseAppearance}
          section={settingsSection}
          onSectionChange={setSettingsSection}
        />
        <div className="wc-edit-dock-side wc-edit-dock-side--left">
          <button
            type="button"
            className={panMode ? "is-active" : ""}
            aria-label="平移画布"
            title="平移画布"
            aria-pressed={panMode}
            onClick={onTogglePan}
          >
            <Hand aria-hidden="true" />
          </button>
          <span className="wc-edit-dock-divider" aria-hidden="true" />
          <button type="button" aria-label="撤销" title="撤销" disabled={!canUndo} onClick={undo}>
            <Undo2 aria-hidden="true" />
          </button>
          <button type="button" aria-label="重做" title="重做" disabled={!canRedo} onClick={redo}>
            <Redo2 aria-hidden="true" />
          </button>
        </div>
        {/* data-wc-preserve-drawers：这个键自己管理开合（点击 = 切换面板），不能走资源库的
            "点外关闭"——否则快速连点时会先被面板判成点外、再被按钮当成第二次点击，面板永远打不开。 */}
        <button
          type="button"
          data-wc-preserve-drawers
          className={resourceOpen ? "is-active wc-resource-toggle" : "wc-resource-toggle"}
          aria-label={resourceOpen ? "收起资源库" : "打开资源库"}
          title="卡片与资产"
          aria-pressed={resourceOpen}
          onClick={() => {
            onCloseAppearance();
            onToggleResource();
          }}
        >
          <img
            className="wc-resource-toggle-logo"
            src={resourceLibraryLogo}
            alt=""
            aria-hidden="true"
            width={24}
            height={24}
            draggable={false}
          />
        </button>
        <div className="wc-edit-dock-side wc-edit-dock-side--right">
          {/* UI 设置键：与顶部"设置"键共用 appearanceOpen，两个入口共存 */}
          <button
            type="button"
            className={appearanceOpen ? "is-active" : ""}
            aria-label={appearanceOpen ? "收起 UI 设置" : "打开 UI 设置"}
            title="UI 设置"
            aria-haspopup="dialog"
            aria-expanded={appearanceOpen}
            aria-controls="wc-appearance-toolbar"
            onClick={onToggleAppearance}
          >
            <SlidersHorizontal aria-hidden="true" />
          </button>
          <button
            type="button"
            className="is-danger"
            aria-label="删除选中内容"
            title="删除选中内容"
            disabled={!hasSelection}
            onClick={deleteSelection}
          >
            <Trash2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="is-danger"
            aria-label="清空画布"
            title="清空画布"
            disabled={!hasContent}
            onClick={onRequestClear}
          >
            <Eraser aria-hidden="true" />
          </button>
        </div>
      </nav>
    </>
  );
});
