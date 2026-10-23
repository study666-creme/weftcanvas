import { type CanvasNodeKind } from "@weftcanvas/contracts";
import {
  Clapperboard,
  Eraser,
  Hand,
  Palette,
  Plus,
  Puzzle,
  Redo2,
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
import { AppearancePanel, AppearanceToolbar } from "./appearance-toolbar";
import { CommunityRail } from "./community-rail";

/**
 * 底部 dock + 创建栏。
 *
 * 两个入口对应两个不同的面板：顶部「设置」键开设置中心（API / 模型 / 本地 /
 * 协作 / 插件），底部 dock 的调色板键开「界面设置」（视觉 / 交互）。界面设置不再
 * 混在设置中心里，改完样式能立刻在画布上看到效果。
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
  settingsOpen,
  settingsTriggerRef,
  onCloseSettings,
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
  settingsOpen: boolean;
  settingsTriggerRef: RefObject<HTMLButtonElement | null>;
  onCloseSettings: () => void;
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
  const appearanceOpen = useUiShellStore((state) => state.appearanceOpen);
  const toggleAppearance = useUiShellStore((state) => state.toggleAppearance);
  const closeAppearance = useUiShellStore((state) => state.closeAppearance);
  const appearanceTriggerRef = useRef<HTMLButtonElement>(null);
  const creatableNodes = useCreatableNodeDefinitions();
  const { getZoom, screenToFlowPosition, setCenter } = useReactFlow<
    WeftcanvasNode,
    WeftcanvasEdge
  >();
  const dockRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!settingsOpen && !appearanceOpen) return;
    const dismiss = () => {
      if (settingsOpen) onCloseSettings();
      if (appearanceOpen) closeAppearance();
    };
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (dockRef.current?.contains(target)) return;
        // 顶部设置键自己管理开合（点击 = 切换面板），不走"点外关闭"，
        // 否则 pointerdown 先关、click 再开，面板永远关不掉。
        if (target instanceof Element && target.closest(".wc-topbar-settings")) return;
      }
      dismiss();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [settingsOpen, appearanceOpen, onCloseSettings, closeAppearance]);

  useEffect(() => {
    if (!resourceOpen) return;
    if (settingsOpen) onCloseSettings();
    if (appearanceOpen) closeAppearance();
  }, [resourceOpen, settingsOpen, appearanceOpen, onCloseSettings, closeAppearance]);

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
      <nav className="wc-create-rail" aria-label="创建工具" data-wc-tour="create-rail">
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
          open={settingsOpen}
          triggerRef={settingsTriggerRef}
          onClose={onCloseSettings}
          section={settingsSection}
          onSectionChange={setSettingsSection}
        />
        <AppearancePanel
          open={appearanceOpen}
          triggerRef={appearanceTriggerRef}
          onClose={closeAppearance}
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
          title="资产库"
          aria-pressed={resourceOpen}
          onClick={() => {
            onCloseSettings();
            closeAppearance();
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
          {/* 界面设置（视觉 / 交互）：独立面板，不混进顶栏的「设置」 */}
          <button
            type="button"
            ref={appearanceTriggerRef}
            className={appearanceOpen ? "is-active" : ""}
            aria-label={appearanceOpen ? "收起界面设置" : "打开界面设置"}
            title="界面设置"
            aria-haspopup="dialog"
            aria-expanded={appearanceOpen}
            aria-controls="wc-appearance-panel"
            onClick={toggleAppearance}
          >
            <Palette aria-hidden="true" />
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
