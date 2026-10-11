import type { CanvasMedia, CanvasNodeKind, DirectorStageCapture } from "@kachang/contracts";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  useStore,
  useStoreApi,
  type Connection,
  type EdgeMouseHandler,
  type IsValidConnection,
  type NodeMouseHandler,
  type NodeChange,
  type OnNodeDrag,
  type OnConnectStart,
  type OnConnectEnd,
  type OnMoveEnd,
  type Viewport,
  type XYPosition,
} from "@xyflow/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";

import type { ThemeMode } from "../App";
import { useCanvasClipboard } from "../hooks/use-canvas-clipboard";
import { useCanvasKeyboard } from "../hooks/use-canvas-keyboard";
import { useProjectPersistence } from "../hooks/use-project-persistence";
import { useSpacePan } from "../hooks/use-space-pan";
import { useTouchCanvasNavigation } from "../hooks/use-touch-canvas-navigation";
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from "../lib/canvas-viewport";
import { setCanvasConnectionDragging } from "../lib/canvas-connection-state";
import { connectionPolicyAllows } from "../lib/canvas-connection-rules";
import { inferCanvasFileKind, layoutCanvasIngestDrafts, type CanvasIngestDraft } from "../lib/canvas-ingest";
import { loadOfficialPlugins } from "../lib/official-plugins";
import { removeMedia, storeMedia, uploadMediaToServer } from "../lib/media-store";
import { createNodeBodyConnection, type NodeBodyConnectionStart } from "../lib/node-body-connection";
import { nodeCreationDimensions } from "../lib/node-factory";
import { getGroupBounds, indexCanvasNodes, type NodeGroupBounds } from "../lib/node-groups";
import { useAgentStore } from "../state/agent-store";
import { useCanvasStore } from "../state/canvas-store";
import { useCloudProjectStore } from "../state/cloud-project-store";
import { useDirectorStageLaunchStore } from "../state/director-stage-launch-store";
import { useGenerationStore } from "../state/generation-store";
import { useIdentityStore } from "../state/identity-store";
import { startProjectAssetAutoCapture, useProjectAssetStore } from "../state/project-asset-store";
import { useToastStore } from "../state/toast-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import type { KachangEdge, KachangNode } from "../types";
import { AgentCompanion } from "./agent-companion";
import { ActivityPanel } from "./activity-panel";
import { AppCursor } from "./app-cursor";
import { CanvasControlBridge } from "./canvas-control-bridge";
import { PointerFeedback } from "./pointer-feedback";
import { BottomToolbar } from "./bottom-toolbar";
import { CanvasZoomDotGrid } from "./canvas-background";
import { CanvasClearDialog } from "./canvas-clear-dialog";
import { CanvasContextMenu, type CanvasMenuState } from "./canvas-context-menu";
import { CanvasGroupsLayer } from "./canvas-groups-layer";
import { CanvasMiniMap } from "./canvas-mini-map";
import { CanvasNodePresence } from "./canvas-node-presence";
import { EmptyCanvasHint } from "./empty-canvas-hint";
import {
  CanvasEdgeRuntimeContext,
  CanvasNodeRuntimeContext,
  type CanvasEdgeRuntimeContextValue,
  type CanvasNodeRuntimeContextValue,
} from "./canvas-node-runtime-context";
import { CanvasSelectionToolbar } from "./canvas-selection-toolbar";
import { CanvasShortcutsPanel } from "./canvas-shortcuts-panel";
import { CanvasStarfield } from "./canvas-starfield";
import { CanvasWaterSurface } from "./canvas-water-surface";
import { ConnectionCreateMenu, type PendingConnectionCreate } from "./connection-create-menu";
import { KachangConnectionLine, KachangEdgeComponent } from "./kachang-edge";
import { KachangNode as KachangNodeComponent } from "./kachang-node";
import { NodeConfigurationComposer } from "./node-configuration-composer";
import { NodePromptComposer } from "./node-prompt-composer";
import { ProjectSidebar } from "./project-sidebar";
import { StorageTipBanner } from "./storage-tip-banner";
import { TopBar } from "./top-bar";
import { ZoomControl } from "./zoom-control";

const nodeTypes = { kachang: KachangNodeComponent };
const edgeTypes = { default: KachangEdgeComponent, kachang: KachangEdgeComponent };
// Above this many nodes the per-node shadows/borders become the dominant paint
// cost, so we degrade them to keep the canvas interactive on lower-end GPUs.
const DENSE_NODE_THRESHOLD = 24;
const defaultEdgeOptions = { style: { strokeWidth: 1.5 }, interactionWidth: 28 };
const connectionLineStyle = { strokeWidth: 1.5 };
const multiSelectionKeyCode = ["Shift", "Control", "Meta"];
const zoomActivationKeyCode = ["Control", "Meta"];
const panActivationKeyCode = "Space";
const VIEWPORT_COMMIT_DEBOUNCE_MS = 150;
const MAX_ENDPOINT_ENERGY_EDGES = 12;
const proOptions = { hideAttribution: true };

function readPersistedMiniMapOpen() {
  try {
    return localStorage.getItem("kachang-canvas:minimap") === "open";
  } catch {
    return false;
  }
}

// 连线拖拽期间 React Flow 每次指针移动都会调用该函数，指针事件可达 120Hz。
// 原先每次都线性扫描整份 edges，节点/连线变多后拖拽连线会明显掉帧；
// 这里按 edges 引用缓存端点集合，只在连线增删时重建一次。
let connectionKeysSource: readonly KachangEdge[] | null = null;
let connectionKeys = new Set<string>();

function connectionKeysFor(edges: readonly KachangEdge[]) {
  if (connectionKeysSource === edges) return connectionKeys;
  connectionKeysSource = edges;
  connectionKeys = new Set(edges.map((edge) => `${edge.source}\u0000${edge.target}`));
  return connectionKeys;
}

const isValidCanvasConnection: IsValidConnection<KachangEdge> = (connection) => {
  if (!connection.source || !connection.target || connection.source === connection.target) return false;
  if (connectionKeysFor(useCanvasStore.getState().edges).has(`${connection.source}\0${connection.target}`)) return false;
  // 类型级策略由节点定义声明（node-registry），缺省走上面的全局规则。
  return connectionPolicyAllows(
    {
      sourceId: connection.source,
      targetId: connection.target,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    },
    useCanvasStore.getState().nodes,
  );
};

const canvasNodeClipDefinitions = (
  <svg className="kc-canvas-svg-definitions" width="0" height="0" aria-hidden="true" focusable="false">
    <defs>
      <clipPath id="kc-imax-screen-clip" clipPathUnits="objectBoundingBox">
        <path d="M0,0 Q.5,.18 1,0 L1,1 Q.5,.82 0,1 Z" />
      </clipPath>
      <clipPath id="kc-imax-screen-inner-clip" clipPathUnits="objectBoundingBox">
        <path d="M0,0 Q.5,.19 1,0 L1,1 Q.5,.81 0,1 Z" />
      </clipPath>
    </defs>
  </svg>
);

type NodeGroupMembershipDrag = {
  draggedId: string;
  originGroupId: string | null;
  boundsByGroup: Map<string, NodeGroupBounds>;
};

type BodyConnectionDrag = NodeBodyConnectionStart & {
  hitNodeId: string | null;
  candidateConnection: Connection | null;
  candidateElement: HTMLElement | null;
};

type CanvasNodePositionChange = Extract<NodeChange<KachangNode>, { type: "position" }>;

const AgentDrawer = lazy(async () => ({ default: (await import("./agent-drawer")).AgentDrawer }));
const DirectorStage = lazy(async () => {
  const module = await import("./director-stage");
  return { default: module.DirectorStage };
});
const ResourceDrawer = lazy(async () => ({ default: (await import("./resource-drawer")).ResourceDrawer }));
/**
 * 点开「卡片与资产」到面板真正画出来之间有一段分包加载时间。这段窗口内的重复点击
 * 按误触处理（用户没看到反应又点了一下），否则纯 toggle 会把第二下当成关闭，
 * 面板就永远打不开。
 *
 * 判定用两个信号：面板还没画出来（无时限，覆盖慢网络），或距打开不足一个系统级
 * 双击阈值（500ms，和操作系统的双击判定保持一致）。面板显示超过这个阈值后的点击
 * 仍然是正常关闭。
 */
const RESOURCE_TOGGLE_REFLEX_MS = 500;

function ResourceDrawerHost({ onPainted, ...props }: ComponentProps<typeof ResourceDrawer> & { onPainted: () => void }) {
  // Suspense 解析后这个 effect 才会提交，因此它是"面板已经画出来"的可信信号。
  useEffect(() => { onPainted(); }, [onPainted]);
  return <ResourceDrawer {...props} />;
}
const ProjectAssetPanel = lazy(async () => ({ default: (await import("./project-asset-panel")).ProjectAssetPanel }));

export function CanvasWorkspace({
  theme,
  onToggleTheme,
  booting = false,
  onReady,
}: {
  theme: ThemeMode;
  onToggleTheme: () => void;
  booting?: boolean;
  onReady?: () => void;
}) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const viewport = useCanvasStore((state) => state.viewport);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const selectEdge = useCanvasStore((state) => state.selectEdge);
  const setStoredViewport = useCanvasStore((state) => state.setViewport);
  const addNode = useCanvasStore((state) => state.addNode);
  const addImportedNodes = useCanvasStore((state) => state.addImportedNodes);
  const addConnectedNode = useCanvasStore((state) => state.addConnectedNode);
  const resizeNodeByFactor = useCanvasStore((state) => state.resizeNodeByFactor);
  const addCapturedImages = useCanvasStore((state) => state.addCapturedImages);
  const projectId = useCanvasStore((state) => state.projectId);
  const cloudLinked = useCloudProjectStore((state) => Boolean(state.links[projectId]));
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setNodeMedia = useCanvasStore((state) => state.setNodeMedia);
  const beginTransaction = useCanvasStore((state) => state.beginTransaction);
  const commitTransaction = useCanvasStore((state) => state.commitTransaction);
  const clearCanvas = useCanvasStore((state) => state.clearCanvas);
  const showToast = useToastStore((state) => state.show);
  const identityStatus = useIdentityStore((state) => state.status);
  const recoverProject = useGenerationStore((state) => state.recoverProject);
  const loadCatalog = useGenerationStore((state) => state.loadCatalog);
  const refreshLoadedCatalogs = useGenerationStore((state) => state.refreshLoadedCatalogs);
  const clearGenerationRuntime = useGenerationStore((state) => state.clearRuntime);
  const canvasBackgroundStyle = useUiPreferencesStore((state) => state.canvasBackgroundStyle);
  const [menu, setMenu] = useState<CanvasMenuState | null>(null);
  const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
  // appearanceOpen 由顶部"设置"键（hover 弹 4 项 / 点击开面板）和底部 UI 设置按钮共用，
  // 提升到 workspace 顶层避免两边各自维护状态导致重复打开。
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceTriggerRef = useRef<HTMLButtonElement>(null);
  const [panMode, setPanMode] = useState(false);
  const [miniMapOpen, setMiniMapOpen] = useState(readPersistedMiniMapOpen);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [resourceOpen, setResourceOpen] = useState(false);
  // resourceOpen 的即时镜像：开合判断要在事件处理里读到最新值，不能依赖 state 更新时序。
  const resourceOpenRef = useRef(false);
  resourceOpenRef.current = resourceOpen;
  const resourceOpenedAtRef = useRef(0);
  const resourcePaintedRef = useRef(false);
  const [activityOpen, setActivityOpen] = useState(false);
  // 专注模式：生成中自动收起画布四周的工具浮岛；Tab 手动开关，Esc 退出，鼠标移近屏幕边缘浮现对应工具。
  const [focusPinned, setFocusPinned] = useState(false);
  // 生成中自动收起后，用户按 Tab/Esc 主动恢复界面时置为 true，避免 generatingActive 仍为真导致按了没反应。
  const [focusSuppressed, setFocusSuppressed] = useState(false);
  // 边缘浮现按「上/左/下」三侧独立判定，左下的缩放条才能和左侧工具栏同时浮现、互不抢占。
  const [focusReveal, setFocusReveal] = useState({ top: false, left: false, bottom: false });
  const [fileDropActive, setFileDropActive] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const fileDragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 右键菜单「上传文件到此处」记住的落点；null 表示走视口中心的普通导入。
  const uploadAnchorRef = useRef<XYPosition | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const flowShellRef = useRef<HTMLDivElement>(null);
  const nodeDraggingRef = useRef(false);
  const dragNodeElementsRef = useRef(new Map<string, HTMLElement>());
  const liveNodePositionChangesRef = useRef(new Map<string, CanvasNodePositionChange>());
  const liveNodePositionFrameRef = useRef<number | null>(null);
  const wheelResizeRef = useRef<{ nodeId: string | null; timer: number | null }>({ nodeId: null, timer: null });
  const pendingViewportRef = useRef<Viewport | null>(null);
  const viewportCommitTimerRef = useRef<number | null>(null);
  const nodeGroupMembershipDragRef = useRef<NodeGroupMembershipDrag | null>(null);
  const bodyConnectionDragRef = useRef<BodyConnectionDrag | null>(null);
  const bodyConnectionPointRef = useRef<XYPosition | null>(null);
  const bodyConnectionFrameRef = useRef<number | null>(null);
  const connectionSuccessRef = useRef<{ element: HTMLElement; timer: number } | null>(null);
  const agentOpen = useAgentStore((state) => state.open);
  const toggleAgent = useAgentStore((state) => state.toggle);
  const closeAgent = useAgentStore((state) => state.close);
  const directorOpen = useDirectorStageLaunchStore((state) => state.open);
  const directorLaunchId = useDirectorStageLaunchStore((state) => state.launchId);
  const directorSourceNodeId = useDirectorStageLaunchStore((state) => state.sourceNodeId);
  const directorInitialPacket = useDirectorStageLaunchStore((state) => state.initialPacket);
  const openDirector = useDirectorStageLaunchStore((state) => state.openStandalone);
  const closeDirector = useDirectorStageLaunchStore((state) => state.close);
  const spacePan = useSpacePan(workspaceRef);
  const marqueeActive = useStore((state) => state.userSelectionActive);
  const {
    screenToFlowPosition,
    getViewport,
    setViewport: setFlowViewport,
  } = useReactFlow<KachangNode, KachangEdge>();
  const flowStore = useStoreApi<KachangNode, KachangEdge>();
  const incidentNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of edges) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
    return ids;
  }, [edges]);
  const setNodeDragging = useCallback((dragging: boolean) => {
    nodeDraggingRef.current = dragging;
    // 拖拽结束后释放 DOM 缓存，避免长期持有已卸载节点的元素引用。
    if (!dragging) dragNodeElementsRef.current.clear();
    workspaceRef.current?.classList.toggle("is-node-dragging", dragging);
    document.body.classList.toggle("is-canvas-node-dragging", dragging);
  }, []);
  // 多选拖拽时每帧都要写多个节点的 transform，逐帧 querySelector 会随选中数量线性变慢。
  // 缓存后只在元素失效（虚拟化卸载/重建）时才重新查询。
  const resolveDragNodeElement = useCallback((id: string) => {
    const cached = dragNodeElementsRef.current.get(id);
    if (cached?.isConnected) return cached;
    const element = flowShellRef.current?.querySelector<HTMLElement>(
      `.react-flow__node-kachang[data-id="${CSS.escape(id)}"]`,
    ) ?? null;
    if (element) dragNodeElementsRef.current.set(id, element);
    else dragNodeElementsRef.current.delete(id);
    return element;
  }, []);
  const flushLiveNodePositions = useCallback(() => {
    if (liveNodePositionFrameRef.current !== null) {
      window.cancelAnimationFrame(liveNodePositionFrameRef.current);
      liveNodePositionFrameRef.current = null;
    }
    if (!liveNodePositionChangesRef.current.size) return;
    const changes = [...liveNodePositionChangesRef.current.values()];
    liveNodePositionChangesRef.current.clear();
    const state = flowStore.getState();
    state.setNodes(applyNodeChanges(changes, state.nodes));
  }, [flowStore]);
  const handleNodesChange = useCallback((changes: NodeChange<KachangNode>[]) => {
    onNodesChange(changes);
    if (!changes.length || !changes.every((change) => change.type === "position" && change.dragging === true)) return;

    const state = flowStore.getState();
    for (const change of changes as CanvasNodePositionChange[]) {
      if (incidentNodeIds.has(change.id)) liveNodePositionChangesRef.current.set(change.id, change);
      const position = change.positionAbsolute ?? change.position;
      if (!position) continue;
      const internalNode = state.nodeLookup.get(change.id);
      const offsetX = change.positionAbsolute || !change.position || !internalNode
        ? 0
        : internalNode.internals.positionAbsolute.x - internalNode.position.x;
      const offsetY = change.positionAbsolute || !change.position || !internalNode
        ? 0
        : internalNode.internals.positionAbsolute.y - internalNode.position.y;
      const element = resolveDragNodeElement(change.id);
      if (element) element.style.transform = `translate3d(${position.x + offsetX}px, ${position.y + offsetY}px, 0)`;
    }
    if (liveNodePositionChangesRef.current.size && liveNodePositionFrameRef.current === null) {
      liveNodePositionFrameRef.current = window.requestAnimationFrame(() => {
        liveNodePositionFrameRef.current = null;
        flushLiveNodePositions();
      });
    }
  }, [flowStore, flushLiveNodePositions, incidentNodeIds, onNodesChange]);
  const finishNodeDragForTouchNavigation = useCallback(() => {
    nodeGroupMembershipDragRef.current = null;
    setNodeDragging(false);
    commitTransaction();
  }, [commitTransaction, setNodeDragging]);
  const touchCanvasNavigation = useTouchCanvasNavigation({
    flowShellRef,
    getViewport,
    setViewport: setFlowViewport,
    commitViewport: setStoredViewport,
    minZoom: MIN_CANVAS_ZOOM,
    maxZoom: MAX_CANVAS_ZOOM,
    onGestureStart: finishNodeDragForTouchNavigation,
  });
  const handleFlowInit = useCallback(() => onReady?.(), [onReady]);

  const getFlowCenterScreen = useCallback(() => {
    const bounds = flowShellRef.current?.getBoundingClientRect();
    return bounds
      ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }, []);

  useProjectPersistence();
  useCanvasKeyboard();

  // 项目工作资产库：左上角入口 + 画布资产自动收集（后台、幂等、失败静默）。
  const assetPanelOpen = useProjectAssetStore((state) => state.open);
  useEffect(() => {
    startProjectAssetAutoCapture();
  }, []);
  // 官方插件装载（懒加载 chunk）：装好后创建菜单/类型标签经注册表自动出现。
  useEffect(() => {
    void loadOfficialPlugins();
  }, []);

  useEffect(() => {
    void Promise.all([
      loadCatalog("image"),
      loadCatalog("video"),
      loadCatalog("audio"),
      loadCatalog("text"),
    ]);
  }, [loadCatalog]);

  useEffect(() => {
    try {
      localStorage.setItem("kachang-canvas:minimap", miniMapOpen ? "open" : "closed");
    } catch {
      // The minimap remains usable for this session when storage is restricted.
    }
  }, [miniMapOpen]);

  useEffect(() => {
    if (identityStatus === "authenticated") void recoverProject(projectId);
    if (identityStatus === "anonymous") clearGenerationRuntime();
  }, [clearGenerationRuntime, identityStatus, projectId, recoverProject]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshLoadedCatalogs(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshLoadedCatalogs]);

  const canvasDepthStyle = useMemo(() => ({
    "--kc-canvas-zoom": viewport.zoom.toFixed(3),
    "--kc-canvas-grid-opacity": String(Math.max(0.14, Math.min(0.42, 0.2 + viewport.zoom * 0.12))),
    "--kc-canvas-grid-heavy-opacity": String(Math.max(0.1, Math.min(0.34, 0.16 + viewport.zoom * 0.08))),
  }) as CSSProperties, [viewport.zoom]);
  const { selectedNodeIds, soleSelectedNode, multipleSelectionActive } = useMemo(() => {
    const selected = nodes.filter((node) => node.selected);
    const selectedNodeIds = new Set(selected.map((node) => node.id));
    return {
      selectedNodeIds,
      soleSelectedNode: selected.length === 1 ? selected[0] ?? null : null,
      multipleSelectionActive: selected.length > 1,
    };
  }, [nodes]);
  const overviewZoom = viewport.zoom < 0.62;
  const endpointEnergyEdgeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedNodeIds.size) return ids;
    for (const edge of edges) {
      if (!selectedNodeIds.has(edge.source) && !selectedNodeIds.has(edge.target)) continue;
      ids.add(edge.id);
      if (ids.size >= MAX_ENDPOINT_ENERGY_EDGES) break;
    }
    return ids;
  }, [edges, selectedNodeIds]);
  const ambientEnergyEdgeIds = useMemo(() => new Set<string>(), []);
  const nodeRuntimeContext = useMemo<CanvasNodeRuntimeContextValue>(() => ({
    overviewZoom,
    marqueeActive,
    multipleSelectionActive,
    projectId,
    cloudLinked,
    // 只保留 2 位小数：跨档（0.45/0.22）才变化，平移/微缩放不触发节点重渲染。
    canvasZoom: Math.round(viewport.zoom * 100) / 100,
  }), [cloudLinked, marqueeActive, multipleSelectionActive, overviewZoom, projectId, viewport.zoom]);
  const edgeRuntimeContext = useMemo<CanvasEdgeRuntimeContextValue>(() => ({
    endpointEnergyEdgeIds,
    ambientEnergyEdgeIds,
  }), [ambientEnergyEdgeIds, endpointEnergyEdgeIds]);

  useEffect(() => {
    const clearDragging = () => setNodeDragging(false);
    const abortDragging = () => {
      nodeGroupMembershipDragRef.current = null;
      clearDragging();
      commitTransaction();
    };
    window.addEventListener("pointerup", clearDragging);
    window.addEventListener("pointercancel", abortDragging);
    window.addEventListener("blur", abortDragging);
    return () => {
      window.removeEventListener("pointerup", clearDragging);
      window.removeEventListener("pointercancel", abortDragging);
      window.removeEventListener("blur", abortDragging);
      nodeDraggingRef.current = false;
      document.body.classList.remove("is-canvas-node-dragging");
      if (liveNodePositionFrameRef.current !== null) window.cancelAnimationFrame(liveNodePositionFrameRef.current);
      liveNodePositionFrameRef.current = null;
      liveNodePositionChangesRef.current.clear();
    };
  }, [commitTransaction, setNodeDragging]);

  const commitPendingViewport = useCallback(() => {
    if (viewportCommitTimerRef.current !== null) {
      window.clearTimeout(viewportCommitTimerRef.current);
      viewportCommitTimerRef.current = null;
    }
    const next = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (next) setStoredViewport(next);
  }, [setStoredViewport]);

  const schedulePendingViewportCommit = useCallback(() => {
    if (viewportCommitTimerRef.current !== null) return;
    // 滚轮每帧只更新 XYFlow 瞬时视口并记录在 ref；Canvas store 与持久化
    // 在 onMoveEnd 或 150ms 有界 debounce 后只提交一次。
    viewportCommitTimerRef.current = window.setTimeout(() => {
      viewportCommitTimerRef.current = null;
      commitPendingViewport();
    }, VIEWPORT_COMMIT_DEBOUNCE_MS);
  }, [commitPendingViewport]);

  const onMoveStart = useCallback(() => workspaceRef.current?.classList.add("is-viewport-moving"), []);
  const onMoveEnd = useCallback<OnMoveEnd>((_, nextViewport) => {
    workspaceRef.current?.classList.remove("is-viewport-moving");
    if (viewportCommitTimerRef.current !== null) {
      window.clearTimeout(viewportCommitTimerRef.current);
      viewportCommitTimerRef.current = null;
    }
    pendingViewportRef.current = null;
    setStoredViewport(nextViewport);
  }, [setStoredViewport]);

  const zoomCanvasAtPointer = useCallback((clientX: number, clientY: number, deltaY: number) => {
      const bounds = flowShellRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const pointer = {
        x: Math.min(bounds.width, Math.max(0, clientX - bounds.left)),
        y: Math.min(bounds.height, Math.max(0, clientY - bounds.top)),
      };
      const current = getViewport();
      const factor = Math.pow(1.1, -deltaY / 100);
      const zoom = Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, current.zoom * factor));
      if (!Number.isFinite(zoom) || Math.abs(zoom - current.zoom) < 0.0001) return;

      const flowX = (pointer.x - current.x) / current.zoom;
      const flowY = (pointer.y - current.y) / current.zoom;
      const next = {
        x: pointer.x - flowX * zoom,
        y: pointer.y - flowY * zoom,
        zoom,
      };
      pendingViewportRef.current = next;
      void setFlowViewport(next, { duration: 0 });
      schedulePendingViewportCommit();
  }, [getViewport, schedulePendingViewportCommit, setFlowViewport]);

  const handleCanvasWheel = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    // Always consume modified wheel events. Otherwise a portal panel (Agent,
    // node editor, or dialog) lets the browser change the page zoom.
    event.preventDefault();
    if (!target || !flowShellRef.current) return;

    const promptTarget = target.closest("[data-node-prompt-composer]");
    const insideFlow = flowShellRef.current.contains(target);
    if (!insideFlow && !promptTarget) return;

    if (promptTarget) {
      event.stopPropagation();
      zoomCanvasAtPointer(event.clientX, event.clientY, event.deltaY);
      return;
    }

    if (target.closest("[data-canvas-node-toolbar],button,input,textarea,select,a,audio,video")) return;

    const nodeElement = target.closest<HTMLElement>("[data-kc-node-id]");
    const nodeId = nodeElement?.dataset.kcNodeId;
    if (!nodeId) return;

    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    if (!node?.selected) return;

    event.stopPropagation();

    const factor = Math.pow(1.1, -event.deltaY / 100);
    if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.0001) return;

    const active = wheelResizeRef.current;
    if (active.nodeId !== nodeId) {
      if (active.timer !== null) window.clearTimeout(active.timer);
      if (active.nodeId) commitTransaction();
      beginTransaction();
      active.nodeId = nodeId;
    }

    resizeNodeByFactor(nodeId, factor, false);
    if (active.timer !== null) window.clearTimeout(active.timer);
    active.timer = window.setTimeout(() => {
      commitTransaction();
      wheelResizeRef.current = { nodeId: null, timer: null };
    }, 180);
  }, [beginTransaction, commitTransaction, resizeNodeByFactor, zoomCanvasAtPointer]);

  useEffect(() => {
    window.addEventListener("wheel", handleCanvasWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", handleCanvasWheel, { capture: true });
  }, [handleCanvasWheel]);

  useEffect(() => () => {
    const active = wheelResizeRef.current;
    if (active.timer !== null) window.clearTimeout(active.timer);
    if (active.nodeId) commitTransaction();
  }, [commitTransaction]);

  useEffect(() => () => {
    if (viewportCommitTimerRef.current !== null) {
      window.clearTimeout(viewportCommitTimerRef.current);
      viewportCommitTimerRef.current = null;
    }
    if (pendingViewportRef.current) {
      const next = pendingViewportRef.current;
      pendingViewportRef.current = null;
      setStoredViewport(next);
    }
  }, [setStoredViewport]);

  const clearBodyConnectionCandidate = useCallback(() => {
    const active = bodyConnectionDragRef.current;
    active?.candidateElement?.classList.remove("is-connection-drop-target");
    active?.candidateElement?.removeAttribute("data-connection-drop-side");
    if (active) {
      active.candidateConnection = null;
      active.candidateElement = null;
    }
  }, []);

  const updateBodyConnectionCandidate = useCallback((point: XYPosition) => {
    const active = bodyConnectionDragRef.current;
    if (!active) return;
    const hit = document.elementFromPoint(point.x, point.y);
    const nodeElement = hit?.closest<HTMLElement>(".react-flow__node-kachang") ?? null;
    const hitNodeId = nodeElement?.dataset.id ?? null;
    if (hitNodeId === active.hitNodeId) return;

    clearBodyConnectionCandidate();
    active.hitNodeId = hitNodeId;
    if (!nodeElement || !hitNodeId) return;
    const connection = createNodeBodyConnection(active, hitNodeId, useCanvasStore.getState().edges);
    if (!connection) return;

    active.candidateConnection = connection;
    active.candidateElement = nodeElement;
    nodeElement.classList.add("is-connection-drop-target");
    nodeElement.dataset.connectionDropSide = active.handleType === "source" ? "left" : "right";
  }, [clearBodyConnectionCandidate]);

  const trackBodyConnectionPointer = useCallback((event: PointerEvent) => {
    if (!bodyConnectionDragRef.current || !event.isPrimary) return;
    bodyConnectionPointRef.current = { x: event.clientX, y: event.clientY };
    if (bodyConnectionFrameRef.current !== null) return;
    bodyConnectionFrameRef.current = window.requestAnimationFrame(() => {
      bodyConnectionFrameRef.current = null;
      const point = bodyConnectionPointRef.current;
      bodyConnectionPointRef.current = null;
      if (point) updateBodyConnectionCandidate(point);
    });
  }, [updateBodyConnectionCandidate]);

  const stopBodyConnectionDrag = useCallback(() => {
    window.removeEventListener("pointermove", trackBodyConnectionPointer, true);
    if (bodyConnectionFrameRef.current !== null) window.cancelAnimationFrame(bodyConnectionFrameRef.current);
    bodyConnectionFrameRef.current = null;
    bodyConnectionPointRef.current = null;
    clearBodyConnectionCandidate();
    bodyConnectionDragRef.current = null;
    setCanvasConnectionDragging(false);
  }, [clearBodyConnectionCandidate, trackBodyConnectionPointer]);

  const handleConnectStart = useCallback<OnConnectStart>((_event, params) => {
    stopBodyConnectionDrag();
    setPendingConnectionCreate(null);
    if (!params.nodeId || !params.handleId || !params.handleType) return;
    bodyConnectionDragRef.current = {
      nodeId: params.nodeId,
      handleId: params.handleId,
      handleType: params.handleType,
      hitNodeId: null,
      candidateConnection: null,
      candidateElement: null,
    };
    setCanvasConnectionDragging(true);
    window.addEventListener("pointermove", trackBodyConnectionPointer, { capture: true, passive: true });
  }, [stopBodyConnectionDrag, trackBodyConnectionPointer]);

  const showConnectionSuccess = useCallback((nodeId: string) => {
    const previous = connectionSuccessRef.current;
    if (previous) {
      window.clearTimeout(previous.timer);
      previous.element.classList.remove("is-connection-drop-success");
    }
    const nodeElement = flowShellRef.current?.querySelector<HTMLElement>(
      `.react-flow__node-kachang[data-id="${CSS.escape(nodeId)}"]`,
    );
    if (!nodeElement) {
      connectionSuccessRef.current = null;
      return;
    }
    nodeElement.classList.add("is-connection-drop-success");
    const timer = window.setTimeout(() => {
      nodeElement.classList.remove("is-connection-drop-success");
      if (connectionSuccessRef.current?.element === nodeElement) connectionSuccessRef.current = null;
    }, 520);
    connectionSuccessRef.current = { element: nodeElement, timer };
  }, []);

  useEffect(() => () => {
    stopBodyConnectionDrag();
    const success = connectionSuccessRef.current;
    if (!success) return;
    window.clearTimeout(success.timer);
    success.element.classList.remove("is-connection-drop-success");
  }, [stopBodyConnectionDrag]);

  useEffect(() => {
    const cancelBodyConnection = () => stopBodyConnectionDrag();
    window.addEventListener("pointercancel", cancelBodyConnection, true);
    window.addEventListener("blur", cancelBodyConnection);
    return () => {
      window.removeEventListener("pointercancel", cancelBodyConnection, true);
      window.removeEventListener("blur", cancelBodyConnection);
    };
  }, [stopBodyConnectionDrag]);

  const handleConnect = useCallback((connection: Connection) => {
    setPendingConnectionCreate(null);
    const edgeCount = useCanvasStore.getState().edges.length;
    onConnect(connection);
    if (useCanvasStore.getState().edges.length === edgeCount) return;
    const active = bodyConnectionDragRef.current;
    const dropNodeId = active?.nodeId === connection.source ? connection.target : connection.source;
    showConnectionSuccess(dropNodeId);
  }, [onConnect, showConnectionSuccess]);

  const handleConnectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    const point = connectionEventPoint(event);
    if (bodyConnectionFrameRef.current !== null) window.cancelAnimationFrame(bodyConnectionFrameRef.current);
    bodyConnectionFrameRef.current = null;
    bodyConnectionPointRef.current = null;
    if (event.type.endsWith("cancel")) {
      stopBodyConnectionDrag();
      return;
    }
    if (point) updateBodyConnectionCandidate(point);
    const bodyDropConnection = bodyConnectionDragRef.current?.candidateConnection ?? null;
    const hitNodeId = bodyConnectionDragRef.current?.hitNodeId ?? null;
    if (!connectionState.isValid && bodyDropConnection) {
      handleConnect(bodyDropConnection);
      stopBodyConnectionDrag();
      return;
    }
    stopBodyConnectionDrag();
    if (!connectionState.fromNode || !connectionState.fromHandle || connectionState.toNode || connectionState.isValid || hitNodeId || !point) return;
    setPendingConnectionCreate({
      anchorId: connectionState.fromNode.id,
      side: connectionState.fromHandle.type === "source" ? "right" : "left",
      flowPosition: screenToFlowPosition(point),
      clientPosition: point,
      zoom: getViewport().zoom,
    });
  }, [getViewport, handleConnect, screenToFlowPosition, stopBodyConnectionDrag, updateBodyConnectionCandidate]);

  const createPendingConnectedNode = useCallback((kind: CanvasNodeKind) => {
    if (!pendingConnectionCreate) return;
    const dimensions = nodeCreationDimensions(
      kind,
      useUiPreferencesStore.getState().defaultNodeAspectRatio,
    );
    const position = {
      x: pendingConnectionCreate.side === "right"
        ? pendingConnectionCreate.flowPosition.x
        : pendingConnectionCreate.flowPosition.x - dimensions.width,
      y: pendingConnectionCreate.flowPosition.y - dimensions.height / 2,
    };
    addConnectedNode(
      pendingConnectionCreate.anchorId,
      pendingConnectionCreate.side,
      kind,
      position,
    );
    setPendingConnectionCreate(null);
  }, [addConnectedNode, pendingConnectionCreate]);

  const openPaneMenu = useCallback((event: globalThis.MouseEvent | ReactMouseEvent<Element>) => {
    event.preventDefault();
    setMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      zoom: getViewport().zoom,
    });
  }, [getViewport, screenToFlowPosition]);

  // 左键双击空白画布：在光标处弹出与右键一致的添加节点菜单。
  // zoomOnDoubleClick 已关闭，不会与缩放手势冲突；只响应空白 pane，
  // 节点/连线上的双击不受影响。
  const handlePaneDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    // 节点都渲染在 pane 内部，仅凭 closest(".react-flow__pane") 无法区分空白处，
    // 必须在节点/连线/端口上排除，否则双击节点也会弹出添加节点菜单。
    if (!target || !target.closest(".react-flow__pane")) return;
    if (target.closest(".react-flow__node, .react-flow__edge, .react-flow__handle, .react-flow__connection")) return;
    setMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      zoom: getViewport().zoom,
    });
  }, [getViewport, screenToFlowPosition]);

  const handleNodeDragStart = useCallback<OnNodeDrag<KachangNode>>((_event, node) => {
    setNodeDragging(true);
    beginTransaction();
    nodeGroupMembershipDragRef.current = null;
    const state = useCanvasStore.getState();
    const selectedCount = state.nodes.reduce((count, item) => count + (item.selected ? 1 : 0), 0);
    if (node.selected && selectedCount > 1) return;
    const nodeIndex = indexCanvasNodes(state.nodes);
    const boundsByGroup = new Map<string, NodeGroupBounds>();
    for (const group of state.groups) {
      const bounds = getGroupBounds(group, state.nodes, nodeIndex);
      if (bounds) boundsByGroup.set(group.id, bounds);
    }
    nodeGroupMembershipDragRef.current = {
      draggedId: node.id,
      originGroupId: state.groups.find((group) => group.nodeIds.includes(node.id))?.id ?? null,
      boundsByGroup,
    };
  }, [beginTransaction, setNodeDragging]);

  const handleNodeDragStop = useCallback<OnNodeDrag<KachangNode>>((_event, node) => {
    flushLiveNodePositions();
    const drag = nodeGroupMembershipDragRef.current;
    if (drag?.draggedId === node.id) {
      const width = node.measured?.width ?? node.width ?? 280;
      const height = node.measured?.height ?? node.height ?? 160;
      const center = { x: node.position.x + width / 2, y: node.position.y + height / 2 };
      const contains = (bounds: NodeGroupBounds | undefined) => Boolean(
        bounds
        && center.x >= bounds.x
        && center.x <= bounds.x + bounds.width
        && center.y >= bounds.y
        && center.y <= bounds.y + bounds.height,
      );
      let targetGroupId = contains(drag.originGroupId ? drag.boundsByGroup.get(drag.originGroupId) : undefined)
        ? drag.originGroupId
        : null;
      if (!targetGroupId) {
        const liveGroupIds = new Set(useCanvasStore.getState().groups.map((group) => group.id));
        targetGroupId = [...drag.boundsByGroup.entries()]
          .filter(([groupId, bounds]) => groupId !== drag.originGroupId && liveGroupIds.has(groupId) && contains(bounds))
          .sort((left, right) => left[1].width * left[1].height - right[1].width * right[1].height)[0]?.[0] ?? null;
      }
      useCanvasStore.getState().setNodeGroupMembership(node.id, targetGroupId);
    }
    nodeGroupMembershipDragRef.current = null;
    setNodeDragging(false);
    commitTransaction();
  }, [commitTransaction, flushLiveNodePositions, setNodeDragging]);

  const handleSelectionDragStart = useCallback(() => {
    setNodeDragging(true);
    beginTransaction();
  }, [beginTransaction, setNodeDragging]);

  const handleSelectionDragStop = useCallback(() => {
    flushLiveNodePositions();
    setNodeDragging(false);
    commitTransaction();
  }, [commitTransaction, flushLiveNodePositions, setNodeDragging]);

  const openNodeMenu = useCallback<NodeMouseHandler<KachangNode>>((event, node) => {
    event.preventDefault();
    const currentNodes = useCanvasStore.getState().nodes;
    if (!currentNodes.find((item) => item.id === node.id)?.selected) {
      onNodesChange(currentNodes.map((item) => ({ id: item.id, type: "select" as const, selected: item.id === node.id })));
    }
    setMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      zoom: getViewport().zoom,
      nodeId: node.id,
    });
  }, [getViewport, onNodesChange, screenToFlowPosition]);

  const openEdgeMenu = useCallback<EdgeMouseHandler<KachangEdge>>((event, edge) => {
    event.preventDefault();
    selectEdge(edge.id);
    setMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      zoom: getViewport().zoom,
      edgeId: edge.id,
    });
  }, [getViewport, screenToFlowPosition, selectEdge]);

  const ingestFiles = useCallback(async (files: File[], anchor: XYPosition) => {
    // 产品规则：画布上传只收图片和视频；音频/文本/其他类型明确提示忽略。
    const supported: Array<{ file: File; kind: "image" | "video" }> = [];
    let ignoredCount = 0;
    for (const file of files) {
      const kind = await inferCanvasFileKind(file);
      if (kind === "image" || kind === "video") supported.push({ file, kind });
      else ignoredCount++;
    }
    if (ignoredCount) showToast(`仅支持上传图片和视频，已忽略 ${ignoredCount} 个文件`, "error");
    if (!supported.length) return;

    // 先落节点：用户拖入/选完文件立刻看到卡片在长，再在后台上传，
    // 避免"点完没反应"的错觉。上传默认走服务端（元数据进数据库、字节进对象存储，
    // 与工作台/生成结果同一条路径，跨设备可见）；服务端不可用时回退本地媒体库。
    const nodeIds = addImportedNodes(layoutCanvasIngestDrafts(
      supported.map(({ kind }) => ({ kind, data: { media: null, uploading: true, status: "idle" } })),
      anchor,
      useUiPreferencesStore.getState().defaultNodeAspectRatio,
    ));

    const results = await Promise.allSettled(supported.map(async ({ file, kind }) => {
      let media: CanvasMedia;
      try {
        media = await uploadMediaToServer(file, kind);
      } catch (serverError) {
        console.warn("[canvas] 服务端上传失败，回退本地媒体库", file.name, serverError);
        media = await storeMedia(file, kind);
      }
      return media;
    }));

    const failures: Array<{ index: number; reason: unknown }> = [];
    results.forEach((result, index) => {
      const nodeId = nodeIds[index];
      if (!nodeId) return;
      if (result.status === "fulfilled") {
        setNodeMedia(nodeId, result.value, false);
        updateNodeData(nodeId, { uploading: false, status: "success" }, false);
        return;
      }
      failures.push({ index, reason: result.reason });
      const message = result.reason instanceof Error && result.reason.message
        ? result.reason.message
        : "未知错误，请查看控制台";
      const current = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data;
      updateNodeData(nodeId, {
        uploading: false,
        status: "error",
        ...(current ? { generation: { ...current.generation, error: message } } : {}),
      }, false);
    });

    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    if (succeeded) showToast(succeeded === 1 ? "素材已加入画布" : `${succeeded} 个素材已加入画布`, "success");
    for (const failure of failures) console.error("[canvas] 文件无法加入画布", failure.reason);
    if (failures.length) {
      const reason = failures
        .map((failure) => failure.reason)
        .find((reason): reason is Error => reason instanceof Error && Boolean(reason.message));
      showToast(`${failures.length} 个文件无法加入画布：${reason?.message ?? "未知错误，请查看控制台"}`, "error");
    }
  }, [addImportedNodes, setNodeMedia, showToast, updateNodeData]);

  const getClipboardAnchor = useCallback(() => screenToFlowPosition(getFlowCenterScreen()), [getFlowCenterScreen, screenToFlowPosition]);

  const pasteText = useCallback((text: string, anchor: XYPosition) => {
    if (!text.trim()) return;
    addImportedNodes(layoutCanvasIngestDrafts(
      [{ kind: "text", data: { body: text.slice(0, 100_000) } }],
      anchor,
      useUiPreferencesStore.getState().defaultNodeAspectRatio,
    ));
  }, [addImportedNodes]);

  useCanvasClipboard({ getAnchor: getClipboardAnchor, onPasteFiles: ingestFiles, onPasteText: pasteText });

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    fileDragDepth.current = 0;
    setFileDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    await ingestFiles(files, position);
  };

  const importFilesAtCenter = useCallback(async (files: File[]) => {
    if (!files.length) return;
    await ingestFiles(files, screenToFlowPosition(getFlowCenterScreen()));
  }, [getFlowCenterScreen, ingestFiles, screenToFlowPosition]);

  const handleFileDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    fileDragDepth.current += 1;
    setFileDropActive(true);
  };

  const handleFileDragLeave = () => {
    fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
    if (!fileDragDepth.current) setFileDropActive(false);
  };

  const handleDirectorCapture = useCallback(async (captures: DirectorStageCapture[]) => {
    const columns = Math.min(3, captures.length);
    const currentViewport = getViewport();
    const dimensions = nodeCreationDimensions(
      "image",
      useUiPreferencesStore.getState().defaultNodeAspectRatio,
    );
    const flowCenter = getFlowCenterScreen();
    const center = {
      x: (flowCenter.x - currentViewport.x) / currentViewport.zoom,
      y: (flowCenter.y - currentViewport.y) / currentViewport.zoom,
    };
    const results = await Promise.allSettled(captures.map(async (capture, index) => {
      const response = await fetch(capture.dataUrl);
      const blob = await response.blob();
      const file = new File([blob], `${capture.shotId}.png`, { type: "image/png" });
      const media = await storeMedia(file, "image");
      const column = index % columns;
      const row = Math.floor(index / columns);
      return {
        position: {
          x: center.x + (column - (columns - 1) / 2) * (dimensions.width + 38) - dimensions.width / 2,
          y: center.y + row * (dimensions.height + 38) - dimensions.height / 2,
        },
        media,
        body: capture.title,
        directorCapture: {
          shotId: capture.shotId,
          slot: capture.slot,
          prompt: capture.prompt,
        },
      };
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      await Promise.all(results.flatMap((result) => result.status === "fulfilled" ? [removeMedia(result.value.media.id)] : []));
      throw failed.reason;
    }
    const stored = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    return addCapturedImages(stored, directorSourceNodeId);
  }, [addCapturedImages, directorSourceNodeId, getFlowCenterScreen, getViewport]);

  const insertResourceAsset = useCallback((asset: { kind: CanvasNodeKind; body: string; media: Parameters<typeof setNodeMedia>[1] | null; extraMedia?: Parameters<typeof setNodeMedia>[1][] }) => {
    const state = useCanvasStore.getState();
    const center = screenToFlowPosition(getFlowCenterScreen());
    const dimensions = nodeCreationDimensions(asset.kind, useUiPreferencesStore.getState().defaultNodeAspectRatio);
    const id = state.addNode(
      asset.kind,
      { x: center.x - dimensions.width / 2, y: center.y - dimensions.height / 2 },
    );
    if (asset.body) state.updateNodeData(id, { body: asset.body }, false);
    if (asset.media) state.setNodeMedia(id, asset.media, false);
    // 多图卡片：其余图片在主图右侧横向排布，保持默认间距。
    (asset.extraMedia ?? []).forEach((media, index) => {
      const extraId = state.addNode(
        asset.kind,
        { x: center.x - dimensions.width / 2 + (dimensions.width + 40) * (index + 1), y: center.y - dimensions.height / 2 },
      );
      if (asset.body) state.updateNodeData(extraId, { body: asset.body }, false);
      state.setNodeMedia(extraId, media, false);
    });
  }, [getFlowCenterScreen, screenToFlowPosition]);

  const handleToggleResource = useCallback(() => {
    const open = resourceOpenRef.current;
    if (open) {
      // 面板还没画出来，或刚画出来的一瞬：用户多半是"没看到反应又点了一下"。
      if (!resourcePaintedRef.current || performance.now() - resourceOpenedAtRef.current < RESOURCE_TOGGLE_REFLEX_MS) return;
      setResourceOpen(false);
      return;
    }
    resourcePaintedRef.current = false;
    resourceOpenedAtRef.current = performance.now();
    closeAgent();
    setResourceOpen(true);
  }, [closeAgent]);

  const handleToggleAgent = useCallback(() => {
    setResourceOpen(false);
    toggleAgent();
  }, [toggleAgent]);

  const handleToggleMiniMap = useCallback(() => {
    setMiniMapOpen((value) => !value);
  }, []);

  const handleOpenShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const handleToggleActivity = useCallback(() => setActivityOpen((value) => !value), []);
  const handleCloseActivity = useCallback(() => setActivityOpen(false), []);
  const handleTogglePan = useCallback(() => setPanMode((value) => !value), []);
  const handleImport = useCallback(() => fileInputRef.current?.click(), []);
  const handleContextUpload = useCallback((anchor: XYPosition) => {
    uploadAnchorRef.current = anchor;
    fileInputRef.current?.click();
  }, []);
  const handleRequestClear = useCallback(() => setClearConfirmOpen(true), []);
  const handleCloseClear = useCallback(() => setClearConfirmOpen(false), []);
  const handleCloseResource = useCallback(() => setResourceOpen(false), []);
  const handleResourceDrawerPainted = useCallback(() => { resourcePaintedRef.current = true; }, []);
  const handlePaneClick = useCallback(() => {
    setMenu(null);
    setPendingConnectionCreate(null);
  }, []);
  const handleConfirmClear = useCallback(() => {
    clearCanvas();
    setClearConfirmOpen(false);
  }, [clearCanvas]);

  const dense = nodes.length >= DENSE_NODE_THRESHOLD;

  // 专注模式：任一节点在生成即视为创作中，自动收起工具浮岛；Tab 随时手动开关，Esc 退出。
  const generatingActive = nodes.some((node) => node.data.status === "running");
  // 用户主动恢复（focusSuppressed）优先于「生成中自动收起」，否则生成期间按 Tab/Esc 会没反应。
  const focusActive = (focusPinned || generatingActive) && !focusSuppressed;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
        event.preventDefault();
        if (focusActive) {
          setFocusPinned(false);
          setFocusSuppressed(true);
        } else {
          setFocusPinned(true);
          setFocusSuppressed(false);
        }
        return;
      }
      if (event.key === "Escape" && focusActive) {
        setFocusPinned(false);
        setFocusSuppressed(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusActive]);

  // 生成结束后清掉「主动恢复」标记，让下一次生成能重新自动收起。
  useEffect(() => {
    if (!generatingActive) setFocusSuppressed(false);
  }, [generatingActive]);

  // 专注模式下鼠标移近屏幕边缘浮现对应侧的工具浮岛。浮现带（76px）比浮岛本身（最厚 72px）更宽，
  // 且三侧独立判定：鼠标移到浮岛上点击时不会因越过旧的 28px 触发线而被立刻收回（旧版会卡死）。
  useEffect(() => {
    if (!focusActive) {
      setFocusReveal({ top: false, left: false, bottom: false });
      return;
    }
    const band = 76;
    const onMouseMove = (event: MouseEvent) => {
      const next = {
        top: event.clientY <= band,
        left: event.clientX <= band,
        bottom: event.clientY >= window.innerHeight - band,
      };
      setFocusReveal((prev) =>
        prev.top === next.top && prev.left === next.left && prev.bottom === next.bottom ? prev : next,
      );
    };
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, [focusActive]);

  const focusEnteredRef = useRef(false);
  useEffect(() => {
    if (focusActive && !focusEnteredRef.current) {
      showToast(generatingActive && !focusPinned ? "生成中已收起界面 · 按 Tab 或 Esc 恢复" : "专注模式 · 按 Tab 或 Esc 恢复界面");
    }
    focusEnteredRef.current = focusActive;
  }, [focusActive, focusPinned, generatingActive, showToast]);

  return (
    <main
      ref={workspaceRef}
      className={`kc-workspace ${panMode ? "is-space-pan" : ""} ${overviewZoom ? "is-overview-zoom" : ""} ${agentOpen ? "is-agent-open" : ""} ${dense ? "is-dense" : ""} ${focusActive ? "is-focus" : ""} ${focusActive && focusReveal.top ? "is-focus-reveal-top" : ""} ${focusActive && focusReveal.left ? "is-focus-reveal-left" : ""} ${focusActive && focusReveal.bottom ? "is-focus-reveal-bottom" : ""}`}
      aria-hidden={booting ? "true" : undefined}
    >
      {canvasNodeClipDefinitions}
      <PointerFeedback />
      {!agentOpen ? (
        <TopBar
          theme={theme}
          onToggleTheme={onToggleTheme}
          onOpenShortcuts={handleOpenShortcuts}
          onToggleActivity={handleToggleActivity}
          appearanceOpen={appearanceOpen}
          appearanceTriggerRef={appearanceTriggerRef}
          onToggleAppearance={() => setAppearanceOpen((value) => !value)}
          onCloseAppearance={() => setAppearanceOpen(false)}
        />
      ) : null}
      {!agentOpen ? <StorageTipBanner /> : null}
      <AgentCompanion open={agentOpen} onToggle={handleToggleAgent} />
      <ProjectSidebar />
      <div
        ref={flowShellRef}
        className={`kc-flow-shell ${fileDropActive ? "is-file-drop-active" : ""}`}
        data-canvas-background={canvasBackgroundStyle}
        style={canvasDepthStyle}
        onDragEnter={handleFileDragEnter}
        onDragLeave={handleFileDragLeave}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => void handleDrop(event)}
      >
        <input
          ref={fileInputRef}
          className="kc-visually-hidden"
          type="file"
          multiple
          accept="image/*,video/*"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            const anchor = uploadAnchorRef.current;
            uploadAnchorRef.current = null;
            if (anchor) void ingestFiles(files, anchor);
            else void importFilesAtCenter(files);
          }}
        />
        <CanvasNodeRuntimeContext.Provider value={nodeRuntimeContext}>
        <CanvasEdgeRuntimeContext.Provider value={edgeRuntimeContext}>
        <ReactFlow<KachangNode, KachangEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultViewport={viewport}
          defaultEdgeOptions={defaultEdgeOptions}
          onInit={handleFlowInit}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          isValidConnection={isValidCanvasConnection}
          onConnectStart={handleConnectStart}
          onConnectEnd={handleConnectEnd}
          onMoveStart={onMoveStart}
          onMoveEnd={onMoveEnd}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onSelectionDragStart={handleSelectionDragStart}
          onSelectionDragStop={handleSelectionDragStop}
          onPaneClick={handlePaneClick}
          onPaneContextMenu={openPaneMenu}
          onDoubleClick={handlePaneDoubleClick}
          onNodeContextMenu={openNodeMenu}
          onEdgeContextMenu={openEdgeMenu}
          minZoom={MIN_CANVAS_ZOOM}
          maxZoom={MAX_CANVAS_ZOOM}
          nodeDragThreshold={2}
          paneClickDistance={6}
          connectionRadius={34}
          connectionLineStyle={connectionLineStyle}
          connectionLineComponent={KachangConnectionLine}
          selectionMode={SelectionMode.Partial}
          selectionOnDrag={!panMode && !touchCanvasNavigation}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={multiSelectionKeyCode}
          panOnDrag={panMode}
          panActivationKeyCode={panActivationKeyCode}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          zoomOnScroll
          zoomActivationKeyCode={zoomActivationKeyCode}
          zoomOnPinch
          zoomOnDoubleClick={false}
          preventScrolling
          deleteKeyCode={null}
          elevateNodesOnSelect
          // 可见性裁剪改由 CanvasNodePresence 接管：余量 + 滞后 + display:none
          // 保留挂载。onlyRenderVisibleElements 的精确视口卸载会在平移时成批
          // 重挂重组件（xyflow #3883/#5656），是 60+ 节点画布平移卡顿的主因。
          onlyRenderVisibleElements={false}
          proOptions={proOptions}
        >
          <CanvasNodePresence />
          {canvasBackgroundStyle === "zoom-dots" ? (
            <CanvasZoomDotGrid />
          ) : canvasBackgroundStyle === "starfield" ? (
            <CanvasStarfield />
          ) : canvasBackgroundStyle === "water" ? (
            <CanvasWaterSurface />
          ) : (
            <>
              <Background
                id="canvas-dot-field"
                variant={BackgroundVariant.Lines}
                gap={theme === "light" ? 32 : 30}
                size={1}
                color={theme === "light" ? "#c7ccc7" : "#252826"}
              />
              <Background
                id="canvas-dot-depth"
                variant={BackgroundVariant.Dots}
                gap={theme === "light" ? 128 : 120}
                size={theme === "light" ? 1.3 : 1.45}
                color={theme === "light" ? "#a9b0aa" : "#343a36"}
              />
            </>
          )}
          <CanvasGroupsLayer />
          <CanvasSelectionToolbar />
          {!marqueeActive && soleSelectedNode?.data.kind === "config" ? (
            <NodeConfigurationComposer key={`config-${soleSelectedNode.id}`} nodeId={soleSelectedNode.id} data={soleSelectedNode.data} />
          ) : !marqueeActive && soleSelectedNode && soleSelectedNode.data.kind !== "audio" && soleSelectedNode.data.kind !== "edit" ? (
            <NodePromptComposer
              key={`prompt-${soleSelectedNode.id}`}
              nodeId={soleSelectedNode.id}
              data={soleSelectedNode.data}
              dragging={Boolean(soleSelectedNode.dragging)}
            />
          ) : null}
          <CanvasMiniMap open={miniMapOpen} theme={theme} />
          <BottomToolbar
            panMode={panMode}
            resourceOpen={resourceOpen}
            onTogglePan={handleTogglePan}
            onToggleResource={handleToggleResource}
            onOpenDirector={openDirector}
            onImport={handleImport}
            onRequestClear={handleRequestClear}
            getCanvasCenter={getFlowCenterScreen}
            appearanceOpen={appearanceOpen}
            appearanceTriggerRef={appearanceTriggerRef}
            onToggleAppearance={() => setAppearanceOpen((value) => !value)}
            onCloseAppearance={() => setAppearanceOpen(false)}
            onInsertAsset={insertResourceAsset}
          />
          <ZoomControl miniMapOpen={miniMapOpen} onToggleMiniMap={handleToggleMiniMap} />
        </ReactFlow>
        <EmptyCanvasHint />
        {/* 自绘光标只挂在工作区：首屏/登录页仍是原生光标（那里主线程最忙，且
            自绘光标要隐藏系统光标才成立）。panMode 就是空格平移手势，抬头交给
            它决定是否显示"抓手"。 */}
        <AppCursor panActive={panMode} />
        </CanvasEdgeRuntimeContext.Provider>
        </CanvasNodeRuntimeContext.Provider>
        {pendingConnectionCreate ? (
          <ConnectionCreateMenu
            pending={pendingConnectionCreate}
            onCreate={createPendingConnectedNode}
            onClose={() => setPendingConnectionCreate(null)}
          />
        ) : null}
        {menu ? <CanvasContextMenu menu={menu} onClose={() => setMenu(null)} onRequestClear={handleRequestClear} onRequestUpload={handleContextUpload} /> : null}
      </div>
      {resourceOpen ? (
        <Suspense fallback={<div className="kc-resource-drawer-loading" role="status">正在打开卡片与资产…</div>}>
          <ResourceDrawerHost
            open
            onClose={handleCloseResource}
            onInsert={insertResourceAsset}
            onPainted={handleResourceDrawerPainted}
          />
        </Suspense>
      ) : null}
      {assetPanelOpen ? (
        <Suspense fallback={null}>
          <ProjectAssetPanel onInsert={insertResourceAsset} />
        </Suspense>
      ) : null}
      {agentOpen ? <Suspense fallback={null}><AgentDrawer /></Suspense> : null}
      <CanvasControlBridge />
      {activityOpen ? <ActivityPanel projectId={projectId} defaultTab="credits" surface="canvas" onClose={handleCloseActivity} /> : null}
      <CanvasShortcutsPanel open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <CanvasClearDialog
        open={clearConfirmOpen}
        nodeCount={nodes.length}
        onClose={handleCloseClear}
        onConfirm={handleConfirmClear}
      />
      {directorOpen ? (
        <Suspense fallback={<div className="kc-director-loading" role="status">导演台正在准备</div>}>
          <DirectorStage
            key={`${projectId}:${directorLaunchId}`}
            open
            projectId={projectId}
            theme={theme}
            initialPacket={directorInitialPacket}
            onClose={closeDirector}
            onCapture={handleDirectorCapture}
          />
        </Suspense>
      ) : null}
    </main>
  );
}

function connectionEventPoint(event: globalThis.MouseEvent | TouchEvent): XYPosition | null {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}
