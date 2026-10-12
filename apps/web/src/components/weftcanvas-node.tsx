import { type CanvasEditData, type CanvasMedia } from "@weftcanvas/contracts";
import { getNodeDefinition, nodeLabel, useCreatableNodeDefinitions } from "../lib/node-registry";
import { applyCanvasOps } from "../lib/plugin-host";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  ArrowRight,
  AlertCircle,
  Clapperboard,
  Disc3,
  ExternalLink,
  FileText,
  ImagePlus,
  LoaderCircle,
  Music2,
  Plus,
  Upload,
  Video,
} from "lucide-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import { useMediaLodThumbUrlForProject, useMediaUrlForProject } from "../hooks/use-media-url";
import { useBoundedImage } from "../hooks/use-bounded-image";
import { useGenerationStall } from "../hooks/use-generation-stall";
import { useNodePresence } from "./canvas-node-presence";
import { resolveMusicLink } from "../lib/api-client";
import {
  localMediaMaxBytes,
  queueServerMediaBlobCache,
  readMedia,
  removeMedia,
  storeMedia,
} from "../lib/media-store";
import {
  clipDurationMs,
  compositionDurationMs,
  formatTimecode,
  trackClips,
} from "../lib/clip-composition";
import {
  createFaceGridArtifacts,
  type FaceGridArtifacts,
  type FaceGridManualSelection,
} from "../lib/face-grid";
import { selectCanvasContentGraph } from "../lib/canvas-content-graph";
import { downloadUrl } from "../lib/download";
import {
  findConfigurationSourceWithIndex,
  getSharedConfigurationIndex,
} from "../lib/node-configuration";
import { useCanvasStore } from "../state/canvas-store";
import { getMergedModels, useCustomApiStore } from "../state/custom-api-store";
import { useDirectorStageLaunchStore } from "../state/director-stage-launch-store";
import { useGenerationStore } from "../state/generation-store";
import { useToastStore } from "../state/toast-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import type { WeftcanvasNode as WeftcanvasNodeType } from "../types";
import { NodeActionToolbar } from "./node-action-toolbar";
import { PluginBodyBoundary } from "./plugin-body-boundary";
import { CanvasNodeRuntimeContext } from "./canvas-node-runtime-context";
import {
  FaceGridPanel,
  defaultFaceGridSettings,
  type FaceGridDetectionStatus,
  type FaceGridSettings,
} from "./face-grid-panel";
import { ImageAnnotatePanel } from "./image-annotate-panel";
import { NodeGenerationPanel } from "./node-generation-panel";
import { NodeLoadingState } from "./node-loading-state";
import { MiniAudioPlayer } from "./mini-audio-player";
import { NodeOverlay, type NodeOverlayMode } from "./node-overlay";
import { NodeVideoPlayer, type NodeVideoPlayerHandle } from "./node-video-player";
// 节点预览样式必须随节点本体加载：剪辑器是懒加载分包，不能把节点外观挂在它上面。
import "./edit-node-preview.css";
// 剪辑工作台按需加载：避免把编辑器与其依赖（media-store、确认框等）塞进首屏主包。
const ClipEditorHost = lazy(() =>
  import("./clip-editor").then((mod) => ({ default: mod.ClipEditorHost })),
);

type MediaNodeKind = "image" | "video" | "audio";

const audioWaveHeights = Array.from({ length: 18 }, (_, index) => 24 + ((index * 17) % 58));

type PendingMediaDimension = {
  id: string;
  mediaId: string;
  width: number;
  height: number;
};

const pendingMediaDimensions = new Map<string, PendingMediaDimension>();
let mediaDimensionFrame: number | null = null;
let mediaDimensionDeferTimer: number | null = null;
let mediaDimensionDeferObserver: MutationObserver | null = null;

// Video/image metadata events arrive while the user may be dragging a node,
// panning the viewport, or actively dragging a connection between ports. Any
// of those gestures must not be destabilized by an async node resize: the
// writeback is deferred until the gesture ends.
function mediaDimensionGestureActive() {
  const workspace = document.querySelector<HTMLElement>(".wc-workspace");
  return Boolean(
    workspace?.classList.contains("is-viewport-moving") ||
    workspace?.classList.contains("is-node-dragging") ||
    workspace?.classList.contains("is-connection-dragging"),
  );
}

// A gesture can legitimately last over a second (a long connection drag). The
// observer flushes as soon as the gesture class clears; this timer is only a
// bounded safety net so a stuck gesture state can never defer the resize
// forever, but it is far longer than any normal drag so the writeback never
// fires mid-gesture.
const MEDIA_DIMENSION_MAX_DEFER_MS = 3_000;

function flushPendingMediaDimensions() {
  if (mediaDimensionFrame !== null) {
    window.cancelAnimationFrame(mediaDimensionFrame);
    mediaDimensionFrame = null;
  }
  if (!pendingMediaDimensions.size) return;
  const updates = [...pendingMediaDimensions.values()];
  pendingMediaDimensions.clear();
  useCanvasStore.getState().setNodeMediaDimensions(updates);
}

function ensureMediaDimensionDeferObserver() {
  if (mediaDimensionDeferObserver || typeof MutationObserver === "undefined") return;
  const workspace = document.querySelector<HTMLElement>(".wc-workspace");
  if (!workspace) return;
  mediaDimensionDeferObserver = new MutationObserver(() => {
    if (mediaDimensionGestureActive()) return;
    if (mediaDimensionDeferTimer !== null) {
      window.clearTimeout(mediaDimensionDeferTimer);
      mediaDimensionDeferTimer = null;
    }
    flushPendingMediaDimensions();
  });
  mediaDimensionDeferObserver.observe(workspace, { attributes: true, attributeFilter: ["class"] });
}

/**
 * 图片和视频的元数据事件经常在同一渲染帧内成批到达，统一提交以避免每个节点各自重写整份画布历史。
 * 平移/拖拽/连线手势期间推迟非关键尺寸回写，手势结束后统一补齐，避免手势帧触发整图持久化，
 * 也避免正在连线/拖拽的节点因异步改尺寸而跳动或丢失命中目标。
 */
function queueMediaDimensionUpdate(id: string, media: CanvasMedia, width: number, height: number) {
  pendingMediaDimensions.set(id, { id, mediaId: media.id, width, height });
  if (mediaDimensionFrame !== null) return;
  mediaDimensionFrame = window.requestAnimationFrame(() => {
    mediaDimensionFrame = null;
    if (mediaDimensionGestureActive()) {
      ensureMediaDimensionDeferObserver();
      if (mediaDimensionDeferTimer === null) {
        mediaDimensionDeferTimer = window.setTimeout(() => {
          mediaDimensionDeferTimer = null;
          flushPendingMediaDimensions();
        }, MEDIA_DIMENSION_MAX_DEFER_MS);
      }
      return;
    }
    flushPendingMediaDimensions();
  });
}

const configurationModalityLabels = {
  image: "图片",
  video: "视频",
  audio: "音频",
} as const;

// 入场动画只属于「真正新建」的节点。画布切项目/重进画布时全部节点都会
// 首次挂载，这仍然是入场；但同一会话内的重挂（比如从缩略图放大回画布）
// 不该再播一次。用挂载记录区分这两类首次渲染。
const nodesWithEntrancePlayed = new Set<string>();

function shouldPlayNodeEntrance(id: string, createdAt: number | null | undefined): boolean {
  if (nodesWithEntrancePlayed.has(id)) return false;
  // 老节点（项目加载即挂载的一批）不播入场：那是「打开项目」，不是「生成新节点」。
  // 以创建时间与挂载时刻的间隔判断：刚创建的节点通常在几百毫秒内挂载。
  if (createdAt === null || createdAt === undefined) return false;
  nodesWithEntrancePlayed.add(id);
  return Date.now() - createdAt < 4_000;
}

function ConfigurationBody({ id, data }: { id: string; data: WeftcanvasNodeType["data"] }) {
  const modality = data.config?.modality ?? "image";
  const catalog = useGenerationStore((state) => state.catalogs[modality]);
  const loadCatalog = useGenerationStore((state) => state.loadCatalog);
  const customProfiles = useCustomApiStore((state) => state.profiles);
  const hiddenModelKeys = useCustomApiStore((state) => state.hiddenModelKeys);
  const pullAllProfiles = useCustomApiStore((state) => state.pullAllProfiles);
  const contentGraph = useCanvasStore(selectCanvasContentGraph);
  const targetCount = useMemo(() => {
    // 索引在共享同一份 nodes/edges 引用的节点之间复用，避免每个节点各自重建。
    const index = getSharedConfigurationIndex(contentGraph.nodes, contentGraph.edges);
    let count = 0;
    for (const edge of contentGraph.edges) {
      if (edge.source !== id) continue;
      if (index.nodeById.get(edge.target)?.data.kind !== modality) continue;
      if (findConfigurationSourceWithIndex(index, edge.target)?.id === id) count += 1;
    }
    return count;
  }, [contentGraph, id, modality]);

  useEffect(() => {
    if (!data.generation.modelId) return;
    void loadCatalog(modality);
    if (customProfiles.length) void pullAllProfiles();
  }, [customProfiles.length, data.generation.modelId, loadCatalog, modality, pullAllProfiles]);

  const models = useMemo(
    () => getMergedModels(catalog.data?.models ?? [], modality, customProfiles, hiddenModelKeys),
    [catalog.data?.models, customProfiles, hiddenModelKeys, modality],
  );
  const modelLabel =
    models.find((model) => model.id === data.generation.modelId)?.label ??
    (catalog.status === "loading"
      ? "正在读取模型"
      : data.generation.modelId
        ? "已选模型"
        : "尚未选择模型");
  const parameterCount = Object.values(data.generation.parameters).filter(
    (value) => value !== undefined,
  ).length;

  return (
    <div className="wc-config-node-preview">
      <div className="wc-config-node-state">
        <i className={data.generation.modelId ? "is-ready" : undefined} aria-hidden="true" />
        <span>{configurationModalityLabels[modality]}配置</span>
        <small>{data.generation.modelId ? "已就绪" : "待配置"}</small>
      </div>
      <strong title={modelLabel}>{modelLabel}</strong>
      <div className="wc-config-node-meta">
        <span>{parameterCount} 项参数</span>
        <span>{targetCount} 个节点</span>
      </div>
    </div>
  );
}

function mediaKindLabel(kind: MediaNodeKind) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}

function faceGridColor(color: string, opacity: number) {
  const matched = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color.trim());
  if (!matched) return `rgba(255, 255, 255, ${Math.min(1, Math.max(0.1, opacity))})`;
  const [red, green, blue] = matched.slice(1).map((part) => Number.parseInt(part, 16));
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0.1, opacity))})`;
}

function faceGridArtifactKey(settings: FaceGridSettings) {
  return `${settings.mode}:${settings.color}:${settings.lineWidth}:${settings.opacity}`;
}

function faceGridDetectionKey(selection: FaceGridManualSelection | null) {
  if (!selection) return "auto";
  return `manual:${selection.x.toFixed(5)}:${selection.y.toFixed(5)}:${selection.width.toFixed(5)}:${selection.height.toFixed(5)}`;
}

function faceGridOptions(settings: FaceGridSettings) {
  const color = faceGridColor(settings.color, settings.opacity);
  return {
    gridLineWidth: settings.lineWidth,
    gridColor: color,
    chipGridColor: color,
    holeGridColor: color,
  };
}

function faceGridOutputName(name: string | undefined, mode: FaceGridSettings["mode"]) {
  const baseName = name?.trim().replace(/\.[^.]+$/, "") || "image";
  return `${baseName}-${mode === "recompose" ? "face-recompose" : "face-grid"}.png`;
}

function annotateOutputName(name: string | undefined) {
  const baseName = name?.trim().replace(/\.[^.]+$/, "") || "image";
  return `${baseName}-annotated.png`;
}

/**
 * 剪辑节点预览：一格序列条（按片段时长比例分配宽度），片段之间靠明度和 1px
 * 缝分层，音频用细竖纹区分——不用彩色块，整片灰阶画布里饱和色块既扎眼也显廉价。
 * 空时间线不摆假片段，只留一条虚线基线。缩到 overview 档位时退化为同色阶的
 * 微型序列 + 时长，仍然是一块画过的图形，不是一行裸文本。
 */
function EditNodePreview({ edit, compact }: { edit: CanvasEditData | null; compact: boolean }) {
  const clips = edit?.clips ?? [];
  const videoSegments = trackClips(clips, "video");
  const audioSegments = trackClips(clips, "audio");
  const total = compositionDurationMs(clips);
  const empty = clips.length === 0;
  const blocks = videoSegments.map((segment) => ({
    key: segment.id,
    kind: segment.kind,
    basis: Math.max(8, (clipDurationMs(segment) / Math.max(1, total)) * 100),
  }));

  if (compact) {
    return (
      <div
        className="wc-edit-node-preview wc-edit-node-preview--overview"
        data-empty={empty ? "true" : undefined}
      >
        <span className="wc-edit-node-overview-strip" aria-hidden="true">
          {blocks.slice(0, 10).map((block) => (
            <i
              key={block.key}
              className={`wc-edit-node-overview-block is-${block.kind}`}
              style={{ flexBasis: `${block.basis}%` }}
            />
          ))}
          {audioSegments.length ? (
            <i
              key="audio"
              className="wc-edit-node-overview-block is-audio"
              style={{ flexBasis: "18%" }}
            />
          ) : null}
        </span>
        <span className="wc-edit-node-overview-time">{empty ? "空" : formatTimecode(total)}</span>
      </div>
    );
  }

  const audioTotal = Math.max(1, compositionDurationMs(audioSegments));
  return (
    <div className="wc-edit-node-preview" data-empty={empty ? "true" : undefined}>
      <div className="wc-edit-node-strips" data-testid="edit-node-strips">
        {blocks.length ? (
          blocks.map((block) => (
            <span
              key={block.key}
              className={`wc-edit-node-strip wc-edit-node-strip--${block.kind}`}
              style={{ flexBasis: `${block.basis}%` }}
            />
          ))
        ) : (
          <span className="wc-edit-node-empty-baseline" />
        )}
        {blocks.length ? <span className="wc-edit-node-playhead" aria-hidden="true" /> : null}
      </div>
      {audioSegments.length ? (
        <div className="wc-edit-node-audio-lane" aria-hidden="true">
          {audioSegments.map((segment) => (
            <span
              key={segment.id}
              className="wc-edit-node-audio-clip"
              style={{ flexBasis: `${Math.max(6, (clipDurationMs(segment) / audioTotal) * 100)}%` }}
            />
          ))}
        </div>
      ) : null}
      <div className="wc-edit-node-meta">
        <span>
          <Clapperboard aria-hidden="true" />
          {empty ? "尚未接入素材" : `${clips.length} 段素材`}
        </span>
        <strong>{formatTimecode(total)}</strong>
      </div>
      <div className="wc-edit-node-hint">
        {empty ? "连接素材节点后双击剪辑" : "双击打开剪辑工作台"}
      </div>
    </div>
  );
}

function NodePort({ nodeId, side }: { nodeId: string; side: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [pulling, setPulling] = useState(false);
  const zoneRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  const magnetOriginRef = useRef<DOMRect | null>(null);
  const magnetFrameRef = useRef<number | null>(null);
  const pendingMagnetRef = useRef<{ port: HTMLElement; x: number; y: number } | null>(null);
  const portStyle = useUiPreferencesStore((state) => state.nodePortStyle);
  const creatableNodes = useCreatableNodeDefinitions();

  const resetMagnet = useCallback(() => {
    if (magnetFrameRef.current !== null) window.cancelAnimationFrame(magnetFrameRef.current);
    magnetFrameRef.current = null;
    pendingMagnetRef.current = null;
    magnetOriginRef.current = null;
    const port = zoneRef.current?.querySelector<HTMLElement>(".wc-node-port-core");
    if (!port) return;
    port.style.setProperty("--magnet-x", "0px");
    port.style.setProperty("--magnet-y", "0px");
  }, []);

  const resetInteraction = useCallback(() => {
    pointerRef.current = null;
    setPressed(false);
    setPulling(false);
    resetMagnet();
  }, [resetMagnet]);

  useEffect(() => {
    gestureCleanupRef.current?.();
    setOpen(false);
    resetInteraction();
  }, [portStyle, resetInteraction]);

  useEffect(
    () => () => {
      gestureCleanupRef.current?.();
      if (magnetFrameRef.current !== null) window.cancelAnimationFrame(magnetFrameRef.current);
    },
    [],
  );

  const beginPointerGesture = (event: PointerEvent<Element>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    gestureCleanupRef.current?.();
    suppressClickRef.current = false;
    pointerRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
    };
    setPressed(true);

    const trackPointer = (nextEvent: globalThis.PointerEvent) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.id !== nextEvent.pointerId || pointer.dragging) return;
      if (Math.hypot(nextEvent.clientX - pointer.x, nextEvent.clientY - pointer.y) <= 10) return;
      pointer.dragging = true;
      setPulling(true);
    };
    const finishPointer = (nextEvent: globalThis.PointerEvent) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.id !== nextEvent.pointerId) return;
      suppressClickRef.current = pointer.dragging;
      cleanup();
      resetInteraction();
    };
    const finishOnBlur = () => {
      suppressClickRef.current = Boolean(pointerRef.current?.dragging);
      cleanup();
      resetInteraction();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", trackPointer);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", finishPointer);
      window.removeEventListener("blur", finishOnBlur);
      if (gestureCleanupRef.current === cleanup) gestureCleanupRef.current = null;
    };

    gestureCleanupRef.current = cleanup;
    window.addEventListener("pointermove", trackPointer);
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    window.addEventListener("blur", finishOnBlur);
  };

  useEffect(() => {
    if (!open) return;
    const closeMenu = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && zoneRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const cacheMagnetOrigin = () => {
    const port = zoneRef.current?.querySelector<HTMLElement>(".wc-node-port-core");
    if (!port) return;
    magnetOriginRef.current = port.getBoundingClientRect();
  };

  const queueMagnet = (port: HTMLElement, x: number, y: number) => {
    pendingMagnetRef.current = { port, x, y };
    if (magnetFrameRef.current !== null) return;
    magnetFrameRef.current = window.requestAnimationFrame(() => {
      magnetFrameRef.current = null;
      const pending = pendingMagnetRef.current;
      pendingMagnetRef.current = null;
      if (!pending) return;
      pending.port.style.setProperty("--magnet-x", `${pending.x}px`);
      pending.port.style.setProperty("--magnet-y", `${pending.y}px`);
    });
  };

  const moveMagnet = (event: PointerEvent<HTMLDivElement>) => {
    const port = zoneRef.current?.querySelector<HTMLElement>(".wc-node-port-core");
    if (!port) return;
    const rect = magnetOriginRef.current ?? port.getBoundingClientRect();
    magnetOriginRef.current = rect;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    const range = portStyle === "classic" ? 96 : 68;
    const maxPull = portStyle === "classic" ? 22 : 11;
    if (!distance || distance > range) {
      resetMagnet();
      return;
    }
    const pull = 1 - Math.pow(1 - distance / range, 2);
    const x = (dx / distance) * maxPull * pull;
    const y = (dy / distance) * maxPull * pull;
    queueMagnet(port, x, y);
  };

  return (
    <div
      ref={zoneRef}
      className={`wc-node-port-zone wc-node-port-zone--${side} wc-node-port-zone--${portStyle} nodrag nopan nowheel ${pressed ? "is-pressed" : ""} ${pulling ? "is-pulling" : ""}`}
      data-node-port-style={portStyle}
      onPointerEnter={cacheMagnetOrigin}
      onPointerMove={moveMagnet}
      onPointerLeave={resetMagnet}
    >
      <Handle
        id={`${side}-${side === "left" ? "target" : "source"}`}
        type={side === "left" ? "target" : "source"}
        position={side === "left" ? Position.Left : Position.Right}
        className="wc-node-port nodrag nopan"
        title={side === "left" ? "连接到此节点" : "从此节点连接"}
        onPointerDown={beginPointerGesture}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          setOpen((value) => !value);
        }}
      >
        <span className="wc-node-port-core" aria-hidden="true">
          <Plus />
        </span>
      </Handle>

      {open ? (
        <div
          className={`wc-node-quick-add wc-node-quick-add--${side} nodrag nowheel`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {creatableNodes.map((definition) => {
            const Icon = definition.icon;
            return (
              <button
                key={definition.kind}
                type="button"
                className={`wc-quick-add--${definition.kind}`}
                aria-label={`添加${definition.label()}`}
                title={definition.label()}
                onClick={(event) => {
                  event.stopPropagation();
                  useCanvasStore.getState().addConnectedNode(nodeId, side, definition.kind);
                  setOpen(false);
                }}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function OverviewNodePorts() {
  return (
    <>
      <Handle
        id="left-target"
        type="target"
        position={Position.Left}
        className="wc-node-port-overview nodrag nopan"
        isConnectable={false}
      />
      <Handle
        id="right-source"
        type="source"
        position={Position.Right}
        className="wc-node-port-overview nodrag nopan"
        isConnectable={false}
      />
    </>
  );
}

function MediaBody({
  id,
  kind,
  media,
  music,
  input,
  url,
  displayUrl,
  missing,
  loading,
  priority,
  videoPlayer,
}: {
  id: string;
  kind: MediaNodeKind;
  media: WeftcanvasNodeType["data"]["media"];
  /** 音频节点的音乐链接数据：无本地/服务器媒体时接管节点内容（流播放或外链卡片）。 */
  music: WeftcanvasNodeType["data"]["music"];
  input: RefObject<HTMLInputElement | null>;
  url: string | null;
  /** 图片展示地址（服务器图片为缩略变体）；视频/音频忽略此参数。 */
  displayUrl: string | null;
  missing: boolean;
  loading: boolean;
  priority: boolean;
  videoPlayer: RefObject<NodeVideoPlayerHandle | null>;
}) {
  const setNodeMedia = useCanvasStore.getState().setNodeMedia;
  const showToast = useToastStore((state) => state.show);
  const mediaRef = useRef(media);
  const Icon = kind === "image" ? ImagePlus : kind === "video" ? Video : Music2;
  const kindLabel = mediaKindLabel(kind);

  mediaRef.current = media;

  // 图片解码/校验/落盘全部围绕展示地址：缩略变体本身就是节点所见内容，
  // 本地缓存命中时（objectURL）displayUrl 与 url 一致，行为不变。
  const imageSourceUrl = kind === "image" ? (displayUrl ?? url) : null;
  const { asset: decodedImage, error: imageError } = useBoundedImage(imageSourceUrl, {
    priority: priority ? "high" : "normal",
    credentials: "include",
  });
  const imageState =
    kind !== "image" || !imageSourceUrl
      ? "idle"
      : imageError
        ? "error"
        : decodedImage
          ? "ready"
          : "loading";

  const reportMediaDimensions = useCallback(
    (width: number, height: number) => {
      const current = mediaRef.current;
      if (!current || !Number.isFinite(width) || !Number.isFinite(height)) return current;
      const measuredWidth = Math.round(width);
      const measuredHeight = Math.round(height);
      if (measuredWidth <= 0 || measuredHeight <= 0) return current;
      if (current.width === measuredWidth && current.height === measuredHeight) return current;
      const measured = { ...current, width: measuredWidth, height: measuredHeight };
      queueMediaDimensionUpdate(id, measured, measuredWidth, measuredHeight);
      return measured;
    },
    [id],
  );

  // 播放器解码元数据时报回时长：画布上刚生成的视频工件不带时长（服务端只在
  // 内容被播放/下载后回写任务工件，且不回流本地节点），这里补进节点素材，
  // 让参考视频时长参数、15 秒上限校验和按秒计费的预估都在本地成立。
  const reportMediaDurationMs = useCallback(
    (durationMs: number) => {
      if (kind !== "video") return;
      const current = mediaRef.current;
      if (!current || current.durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return;
      setNodeMedia(id, { ...current, durationMs: Math.round(durationMs) }, false);
    },
    [id, kind, setNodeMedia],
  );

  useEffect(() => {
    if (kind !== "image" || !decodedImage) return;
    const current = mediaRef.current;
    // 节点媒体记录存的是原图宽高。缩略变体的解码宽高（≤512px）只在记录
    // 尚无尺寸时作为兜底写入；已有真实尺寸时不得用缩略值覆盖。
    if (decodedImage.width && decodedImage.height && !(current?.width && current?.height)) {
      reportMediaDimensions(decodedImage.width, decodedImage.height);
    }
    if (current?.source === "server" && decodedImage.blob) {
      // 有界加载器已经解码/校验过 blob，这里复用其宽高低优先级落盘，
      // 不再二次解码，且手势期间推迟写盘避免阻塞平移/拖拽帧。
      void queueServerMediaBlobCache(current, decodedImage.blob, {
        width: decodedImage.width,
        height: decodedImage.height,
      });
    }
  }, [decodedImage, kind, reportMediaDimensions]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith(`${kind}/`)) {
      showToast(`请选择${kindLabel}文件`, "error");
      return;
    }
    if (file.size > localMediaMaxBytes[kind]) {
      showToast(
        `${kindLabel}不能超过 ${Math.round(localMediaMaxBytes[kind] / 1024 / 1024)} MB`,
        "error",
      );
      return;
    }
    try {
      const next = await storeMedia(file, kind);
      setNodeMedia(id, next, true);
      showToast(`${kindLabel}已加入节点`, "success");
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "媒体保存失败", "error");
    }
  };

  return (
    <div className="wc-node-media-body">
      <input
        ref={input}
        type="file"
        hidden
        accept={`${kind}/*`}
        onChange={(event) => void upload(event)}
      />
      {url ? (
        <div
          className={`wc-node-media-frame wc-node-media-frame--${kind} ${media?.width && media.height ? "is-measured" : "is-unmeasured"} ${kind === "image" && imageState !== "ready" ? "is-loading" : "is-ready"}`}
        >
          {kind === "image" ? (
            <img
              src={decodedImage?.url}
              alt={media?.name || "节点图片"}
              data-media-id={media?.id ?? undefined}
              draggable={false}
              loading="eager"
              decoding="async"
            />
          ) : null}
          {kind === "video" ? (
            <NodeVideoPlayer
              ref={videoPlayer}
              url={url}
              name={media?.name || "节点视频"}
              onDimensions={reportMediaDimensions}
              onDurationMs={reportMediaDurationMs}
              // 旁观节点零字节加载：十兆级视频 * 几十个节点的 preload=metadata
              // 会把 IO 与解码队列全部占满，这是「几段视频就把画布拖死」的原因。
              // 选中/悬停/生成中/展开面板中的节点保持主动加载。
              lazy={!priority}
            />
          ) : null}
          {kind === "audio" ? (
            <div className="wc-node-audio-content">
              <div className="wc-audio-wave" aria-hidden="true">
                {audioWaveHeights.map((height, index) => (
                  <span key={index} style={{ height: `${height}%` }} />
                ))}
              </div>
              <MiniAudioPlayer src={url} label={media?.name || "节点音频"} />
            </div>
          ) : null}
          {kind === "image" && imageState !== "ready" ? (
            <div
              className={`wc-media-result-state ${imageState === "error" ? "is-error" : ""}`}
              role="status"
            >
              {imageState === "error" ? (
                <AlertCircle aria-hidden="true" />
              ) : (
                <span aria-hidden="true" />
              )}
              <strong>{imageState === "error" ? "结果加载失败" : "结果已生成，正在载入"}</strong>
              <small>{imageState === "error" ? "请稍后刷新重试" : "图片可用后会立即显示"}</small>
            </div>
          ) : null}
          <button
            type="button"
            className="wc-media-replace nodrag nowheel"
            title="替换媒体"
            onClick={() => input.current?.click()}
          >
            <Upload aria-hidden="true" />
          </button>
        </div>
      ) : kind === "audio" && !loading && !missing ? (
        // 音频节点没有本地/服务器媒体时交给音乐链接接管：
        // 未解析是贴链接入口，解析后是代理音频流或平台外链卡片。
        <MusicBody id={id} music={music} />
      ) : (
        <div
          className={`wc-media-empty wc-media-empty--passive ${kind === "image" || kind === "video" ? "wc-media-empty--icon-only" : ""} ${missing ? "wc-media-empty--error" : ""} ${loading ? "wc-media-empty--loading" : ""}`}
          aria-label={
            missing
              ? `${kindLabel}文件不可用`
              : loading
                ? `正在载入${kindLabel}结果`
                : `空${kindLabel}节点`
          }
        >
          {loading ? (
            <span className="wc-media-empty-spinner" aria-hidden="true" />
          ) : (
            <Icon aria-hidden="true" />
          )}
          <span>
            {missing ? "媒体文件不可用" : loading ? "结果已生成，正在载入" : `空${kindLabel}节点`}
          </span>
        </div>
      )}
    </div>
  );
}

const musicSourceLabels = {
  netease: "网易云音乐",
  qq: "QQ音乐",
  qishui: "汽水音乐",
  direct: "音频直链",
  link: "网页链接",
} as const;

/**
 * 音乐节点主体：空态是粘贴链接入口；解析结果二选一——
 * 拿到代理音频流（streamPath）就地播放，拿不到（平台防盗链/DRM）渲染
 * 外链卡片。流与封面只接受 /api/v1/music/ 同源代理路径，第三方直链
 * 永远不进 <audio>/<img>。
 */
function MusicBody({ id, music }: { id: string; music: WeftcanvasNodeType["data"]["music"] }) {
  const showToast = useToastStore((state) => state.show);
  const [linkInput, setLinkInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [playing, setPlaying] = useState(false);

  const resolve = async () => {
    const url = linkInput.trim();
    if (!url || resolving) return;
    setResolving(true);
    try {
      const { data } = await resolveMusicLink(url);
      useCanvasStore.getState().updateNodeData(
        id,
        {
          music: {
            pageUrl: data.pageUrl,
            streamPath: data.streamPath,
            coverPath: data.coverPath,
            title: data.title,
            artist: data.artist,
            source: data.source,
            resolvedAt: Date.now(),
          },
          status: "success",
        },
        false,
      );
      showToast(data.kind === "audio" ? "音乐已放进节点" : "已生成平台外链卡片", "success");
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "链接解析失败", "error");
    } finally {
      setResolving(false);
    }
  };

  if (!music || (!music.streamPath && !music.pageUrl)) {
    return (
      <div className="wc-node-music wc-node-music--empty">
        <Disc3 aria-hidden="true" />
        <p>粘贴歌曲链接或音频直链，也可从工具栏上传本地音频</p>
        <div className="wc-node-music-input">
          <input
            value={linkInput}
            onChange={(event) => setLinkInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void resolve();
              }
            }}
            placeholder="music.163.com/song?id=…"
            aria-label="音乐链接"
          />
          <button
            type="button"
            disabled={resolving || !linkInput.trim()}
            onClick={() => void resolve()}
          >
            {resolving ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : (
              <ArrowRight aria-hidden="true" />
            )}
            解析
          </button>
        </div>
      </div>
    );
  }

  const streamSrc = music.streamPath?.startsWith("/api/v1/music/") ? music.streamPath : null;
  const coverSrc = music.coverPath?.startsWith("/api/v1/music/") ? music.coverPath : null;
  return (
    <div className={`wc-node-music ${playing ? "is-playing" : ""}`}>
      <div className="wc-node-music-head">
        <div className="wc-node-music-cover">
          {coverSrc ? (
            <img
              src={coverSrc}
              alt=""
              aria-hidden="true"
              draggable={false}
              loading="eager"
              decoding="async"
            />
          ) : (
            <Disc3 aria-hidden="true" />
          )}
        </div>
        <div className="wc-node-music-meta">
          <strong title={music.title}>{music.title || "未知曲目"}</strong>
          {music.artist ? <small title={music.artist}>{music.artist}</small> : null}
          <span>{musicSourceLabels[music.source] ?? "音乐链接"}</span>
        </div>
      </div>
      {streamSrc ? (
        <MiniAudioPlayer
          src={streamSrc}
          label={music.title || "节点音乐"}
          onPlayingChange={setPlaying}
        />
      ) : (
        <a
          className="wc-node-music-open nodrag nowheel"
          href={music.pageUrl}
          target="_blank"
          rel="noreferrer"
        >
          去平台播放
          <ExternalLink aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

export const WeftcanvasNode = memo(function WeftcanvasNode({
  id,
  data,
  width,
  height,
  selected,
}: NodeProps<WeftcanvasNodeType>) {
  const {
    updateNodeData,
    setNodeMedia,
    beginTransaction,
    commitTransaction,
    deleteNode,
    addConnectedNode,
  } = useCanvasStore.getState();
  const toolbarActive = useCanvasStore((state) => state.activeToolbarNodeId === id);
  const setActiveToolbarNodeId = useCanvasStore.getState().setActiveToolbarNodeId;
  const {
    overviewZoom,
    marqueeActive,
    multipleSelectionActive,
    projectId,
    cloudLinked,
    canvasZoom,
  } = useContext(CanvasNodeRuntimeContext);
  // 余量裁剪：掉出余量视口的节点保持挂载但 display:none（见 canvas-node-presence）。
  const present = useNodePresence(id);
  const isSoleSelectedNode = selected && !multipleSelectionActive;
  const showToast = useToastStore((state) => state.show);
  const openDirectorFromNode = useDirectorStageLaunchStore((state) => state.openFromNode);
  const generationEffectStyle = useUiPreferencesStore((state) => state.generationEffectStyle);
  const mediaInput = useRef<HTMLInputElement>(null);
  const videoPlayer = useRef<NodeVideoPlayerHandle>(null);
  const toolbarCloseTimer = useRef<number | null>(null);
  const expandedPointer = useRef<{ at: number; x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [toolbarDismissed, setToolbarDismissed] = useState(false);
  const [overlayMode, setOverlayMode] = useState<NodeOverlayMode | null>(null);
  const [generationOpen, setGenerationOpen] = useState(false);
  const [clipEditorOpen, setClipEditorOpen] = useState(false);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const [faceGridOpen, setFaceGridOpen] = useState(false);
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [annotateImage, setAnnotateImage] = useState<HTMLImageElement | null>(null);
  const [applyingAnnotate, setApplyingAnnotate] = useState(false);
  const [faceGridSettings, setFaceGridSettings] =
    useState<FaceGridSettings>(defaultFaceGridSettings);
  const [faceGridStatus, setFaceGridStatus] = useState<FaceGridDetectionStatus>("idle");
  const [faceGridError, setFaceGridError] = useState<string | null>(null);
  const [faceGridFaceCount, setFaceGridFaceCount] = useState<number | null>(null);
  const [faceGridManualSelection, setFaceGridManualSelection] =
    useState<FaceGridManualSelection | null>(null);
  const [faceGridSourceUrl, setFaceGridSourceUrl] = useState<string | null>(null);
  const [faceGridPreviewUrl, setFaceGridPreviewUrl] = useState<string | null>(null);
  const [applyingFaceGrid, setApplyingFaceGrid] = useState(false);
  const faceGridRequestId = useRef(0);
  const faceGridSourceBlob = useRef<Blob | null>(null);
  const faceGridDetections = useRef<FaceGridArtifacts["detections"] | null>(null);
  const faceGridArtifacts = useRef<FaceGridArtifacts | null>(null);
  const faceGridArtifactSettings = useRef<string | null>(null);
  const faceGridDetectionSource = useRef<string | null>(null);
  const faceGridManualSelectionRef = useRef<FaceGridManualSelection | null>(null);
  const faceGridSettingsRef = useRef(faceGridSettings);
  const faceGridSourceObjectUrl = useRef<string | null>(null);
  const faceGridPreviewObjectUrl = useRef<string | null>(null);
  const {
    url: mediaUrl,
    missing: mediaMissing,
    loading: mediaLoading,
  } = useMediaUrlForProject(data.media, projectId, cloudLinked);
  // 节点框只放得下 340~4096px，展示层取缩略变体即可（本地缓存命中时仍是原字节）。
  // 多级缩略：随画布 zoom 在 512/256/128px 三档间切换，缩得越远展示位图越小
  // （见 local-media-thumb 的档位表）。全屏预览/下载/落盘走 mediaUrl 原图，
  // 画质不受影响。
  const { url: mediaThumbUrl } = useMediaLodThumbUrlForProject(
    data.media,
    projectId,
    cloudLinked,
    canvasZoom,
  );
  const imageDisplayUrl = data.kind === "image" ? (mediaThumbUrl ?? mediaUrl) : null;
  const Icon = getNodeDefinition(data.kind)?.icon ?? FileText;
  const isMedia = data.kind === "image" || data.kind === "video" || data.kind === "audio";
  const PluginBody = getNodeDefinition(data.kind)?.renderBody;
  // 插件节点体的 ops 通道：与 Agent 命令同一套校验与执行路径（宿主代发）。
  const pluginBodyOps = useMemo(
    () => ({
      apply: async (ops: { type: string; [key: string]: unknown }[]) =>
        applyCanvasOps(`plugin-body-${id}`, ops),
    }),
    [id],
  );
  // Video accent is a visual type token. Normalize legacy coral values at the
  // render boundary so saved nodes cannot make a normal video look failed.
  const visualAccent = data.kind === "video" ? "blue" : data.accent;
  const submissionUnknown = data.generation.jobStatus === "submission_unknown";
  const generationInFlight =
    !submissionUnknown &&
    (data.status === "running" ||
      ["reserved", "submitting", "queued", "running", "validating"].includes(
        data.generation.jobStatus ?? "",
      ));
  // 上传中：节点先建好落在画布上，素材字节还在上传/落库，节点自带加载态。
  const uploadingMedia = data.uploading === true;
  const displayStatus = submissionUnknown ? "error" : generationInFlight ? "running" : data.status;
  const generationError =
    data.generation.error || (submissionUnknown ? "任务提交结果待确认，请勿重复生成" : null);
  const generationProgress = typeof data.progress === "number" ? data.progress : undefined;
  const generationStalled = useGenerationStall({
    jobId: data.generation.jobId,
    jobVersion: data.generation.jobVersion,
    status: data.generation.jobStatus,
  });
  const observationExhausted = useGenerationStore((state) =>
    data.generation.jobId !== null && data.generation.jobId !== undefined
      ? state.exhaustedObservations[data.generation.jobId] === true
      : false,
  );
  const toolbarVisible = toolbarActive && (hovered || (isSoleSelectedNode && !toolbarDismissed));
  const compactOverview =
    overviewZoom &&
    !selected &&
    !hovered &&
    !generationInFlight &&
    !uploadingMedia &&
    !overlayMode &&
    !faceGridOpen &&
    !annotateOpen &&
    !generationOpen &&
    !clipEditorOpen;

  useEffect(() => {
    faceGridSettingsRef.current = faceGridSettings;
  }, [faceGridSettings]);

  const replaceFaceGridUrl = useCallback((kind: "source" | "preview", blob: Blob | null) => {
    const ref = kind === "source" ? faceGridSourceObjectUrl : faceGridPreviewObjectUrl;
    if (ref.current) URL.revokeObjectURL(ref.current);
    const nextUrl = blob ? URL.createObjectURL(blob) : null;
    ref.current = nextUrl;
    if (kind === "source") setFaceGridSourceUrl(nextUrl);
    else setFaceGridPreviewUrl(nextUrl);
  }, []);

  const resetFaceGrid = useCallback(
    (close = true) => {
      faceGridRequestId.current += 1;
      faceGridSourceBlob.current = null;
      faceGridDetections.current = null;
      faceGridArtifacts.current = null;
      faceGridArtifactSettings.current = null;
      faceGridDetectionSource.current = null;
      faceGridManualSelectionRef.current = null;
      replaceFaceGridUrl("source", null);
      replaceFaceGridUrl("preview", null);
      setFaceGridStatus("idle");
      setFaceGridError(null);
      setFaceGridFaceCount(null);
      setFaceGridManualSelection(null);
      setApplyingFaceGrid(false);
      if (close) setFaceGridOpen(false);
    },
    [replaceFaceGridUrl],
  );

  const readFaceGridSource = useCallback(async () => {
    if (data.kind !== "image" || !data.media) throw new Error("请先为图片节点添加图片");
    if (data.media.source === "local") {
      const localMedia = await readMedia(data.media.id);
      if (!localMedia) throw new Error("图片文件不可用，请重新上传后再试");
      return localMedia.blob;
    }

    if (!mediaUrl) throw new Error("图片仍在加载，请稍后再试");
    const response = await fetch(mediaUrl, { credentials: "same-origin" });
    if (!response.ok) throw new Error("无法读取这张图片，请重新上传后再试");
    return response.blob();
  }, [data.kind, data.media, mediaUrl]);

  const renderFaceGrid = useCallback(
    async (
      settings: FaceGridSettings = faceGridSettingsRef.current,
      forceDetection = false,
      manualSelectionOverride: FaceGridManualSelection | null | undefined = undefined,
    ) => {
      const requestId = faceGridRequestId.current + 1;
      faceGridRequestId.current = requestId;
      const manualSelection =
        manualSelectionOverride === undefined
          ? faceGridManualSelectionRef.current
          : manualSelectionOverride;
      const detectionSource = faceGridDetectionKey(manualSelection);
      const canReuseDetections =
        !forceDetection &&
        Boolean(
          faceGridSourceBlob.current &&
          faceGridDetections.current &&
          faceGridDetectionSource.current === detectionSource,
        );
      if (!canReuseDetections) {
        setFaceGridStatus("detecting");
        setFaceGridFaceCount(null);
      }
      setFaceGridError(null);

      try {
        const source = faceGridSourceBlob.current ?? (await readFaceGridSource());
        if (requestId !== faceGridRequestId.current) return null;
        if (!faceGridSourceBlob.current) {
          faceGridSourceBlob.current = source;
          replaceFaceGridUrl("source", source);
        }

        const artifacts = await createFaceGridArtifacts(source, {
          minDetectionConfidence: 0.25,
          minSuppressionThreshold: 0.2,
          maxFaces: 8,
          ...faceGridOptions(settings),
          ...(canReuseDetections && faceGridDetections.current
            ? { detections: faceGridDetections.current }
            : {}),
          ...(!canReuseDetections && manualSelection
            ? { manualSelections: [manualSelection] }
            : {}),
        });
        if (requestId !== faceGridRequestId.current) return null;

        faceGridDetections.current = artifacts.detections;
        faceGridArtifacts.current = artifacts;
        faceGridArtifactSettings.current = faceGridArtifactKey(settings);
        faceGridDetectionSource.current = detectionSource;
        replaceFaceGridUrl(
          "preview",
          settings.mode === "recompose" ? artifacts.recomposedBlob : artifacts.overlayBlob,
        );
        setFaceGridFaceCount(artifacts.detections.length);
        setFaceGridStatus("ready");
        return artifacts;
      } catch (cause) {
        if (requestId !== faceGridRequestId.current) return null;
        faceGridArtifacts.current = null;
        faceGridArtifactSettings.current = null;
        faceGridDetectionSource.current = null;
        setFaceGridStatus("error");
        setFaceGridError(cause instanceof Error ? cause.message : "人脸网格处理失败，请稍后重试");
        return null;
      }
    },
    [readFaceGridSource, replaceFaceGridUrl],
  );

  const openFaceGrid = useCallback(() => {
    if (data.kind !== "image" || !data.media) {
      showToast("先选择一张图片，上传完成后再点人脸网格", "error");
      mediaInput.current?.click();
      return;
    }
    resetFaceGrid(false);
    setFaceGridOpen(true);
    void renderFaceGrid(faceGridSettingsRef.current, true);
  }, [data.kind, data.media, renderFaceGrid, resetFaceGrid, showToast]);

  const openAnnotate = useCallback(async () => {
    if (data.kind !== "image" || !data.media) {
      showToast("先选择一张图片，上传完成后再标注", "error");
      mediaInput.current?.click();
      return;
    }
    setAnnotateOpen(true);
    setAnnotateImage(null);
    try {
      let blob: Blob;
      if (data.media.source === "local") {
        const localMedia = await readMedia(data.media.id);
        if (!localMedia) throw new Error("图片文件不可用，请重新上传后再试");
        blob = localMedia.blob;
      } else {
        if (!mediaUrl) throw new Error("图片仍在加载，请稍后再试");
        const response = await fetch(mediaUrl, { credentials: "same-origin" });
        if (!response.ok) throw new Error("无法读取这张图片，请重新上传后再试");
        blob = await response.blob();
      }
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("图片解码失败，请重新上传后再试"));
        element.src = URL.createObjectURL(blob);
      });
      URL.revokeObjectURL(image.src);
      setAnnotateImage(image);
    } catch (cause) {
      setAnnotateOpen(false);
      showToast(cause instanceof Error ? cause.message : "打开图片标注失败", "error");
    }
  }, [data.kind, data.media, mediaUrl, showToast]);

  const applyAnnotate = useCallback(
    async (blob: Blob) => {
      if (applyingAnnotate || data.kind !== "image" || !data.media) return;
      setApplyingAnnotate(true);
      try {
        const file = new File([blob], annotateOutputName(data.media.name), { type: "image/png" });
        const media = await storeMedia(file, "image");
        const resultNodeId = addConnectedNode(id, "right", "image");
        if (!resultNodeId) {
          await removeMedia(media.id);
          throw new Error("无法创建结果图片节点");
        }
        setNodeMedia(resultNodeId, media, false);
        updateNodeData(resultNodeId, { body: "图片标注结果", status: "success" }, false);
        showToast("标注图片已生成新节点", "success");
        setAnnotateOpen(false);
        setAnnotateImage(null);
      } catch (cause) {
        showToast(cause instanceof Error ? cause.message : "生成标注图片失败", "error");
      } finally {
        setApplyingAnnotate(false);
      }
    },
    [
      addConnectedNode,
      applyingAnnotate,
      data.kind,
      data.media,
      id,
      setNodeMedia,
      showToast,
      updateNodeData,
    ],
  );

  const updateFaceGridSettings = useCallback(
    (next: FaceGridSettings) => {
      faceGridSettingsRef.current = next;
      setFaceGridSettings(next);
      if (faceGridSourceBlob.current && faceGridDetections.current) {
        void renderFaceGrid(next);
      }
    },
    [renderFaceGrid],
  );

  const updateFaceGridManualSelection = useCallback(
    (selection: FaceGridManualSelection | null) => {
      faceGridManualSelectionRef.current = selection;
      setFaceGridManualSelection(selection);
      faceGridDetections.current = null;
      faceGridArtifacts.current = null;
      faceGridArtifactSettings.current = null;
      faceGridDetectionSource.current = null;
      if (selection) {
        void renderFaceGrid(faceGridSettingsRef.current, true, selection);
      }
    },
    [renderFaceGrid],
  );

  const detectFaceGridAutomatically = useCallback(() => {
    faceGridManualSelectionRef.current = null;
    setFaceGridManualSelection(null);
    faceGridDetections.current = null;
    faceGridArtifacts.current = null;
    faceGridArtifactSettings.current = null;
    faceGridDetectionSource.current = null;
    void renderFaceGrid(faceGridSettingsRef.current, true, null);
  }, [renderFaceGrid]);

  const applyFaceGrid = useCallback(
    async (settings: FaceGridSettings) => {
      if (applyingFaceGrid || data.kind !== "image" || !data.media) return;
      setApplyingFaceGrid(true);
      try {
        let artifacts = faceGridArtifacts.current;
        if (!artifacts || faceGridArtifactSettings.current !== faceGridArtifactKey(settings)) {
          artifacts = await renderFaceGrid(settings);
        }
        if (!artifacts || artifacts.detections.length === 0) {
          throw new Error("没有检测到可处理的人脸");
        }

        const output =
          settings.mode === "recompose" ? artifacts.recomposedBlob : artifacts.overlayBlob;
        const file = new File([output], faceGridOutputName(data.media.name, settings.mode), {
          type: "image/png",
        });
        const media = await storeMedia(file, "image");
        const resultNodeId = addConnectedNode(id, "right", "image");
        if (!resultNodeId) {
          await removeMedia(media.id);
          throw new Error("无法创建结果图片节点");
        }
        setNodeMedia(resultNodeId, media, false);
        updateNodeData(
          resultNodeId,
          {
            body: settings.mode === "recompose" ? "人脸重组结果" : "人脸网格结果",
            status: "success",
          },
          false,
        );
        showToast(settings.mode === "recompose" ? "人脸重组已生成" : "人脸网格已生成", "success");
        resetFaceGrid();
      } catch (cause) {
        showToast(cause instanceof Error ? cause.message : "人脸网格生成失败", "error");
      } finally {
        setApplyingFaceGrid(false);
      }
    },
    [
      addConnectedNode,
      applyingFaceGrid,
      data.kind,
      data.media,
      id,
      renderFaceGrid,
      resetFaceGrid,
      setNodeMedia,
      showToast,
      updateNodeData,
    ],
  );

  useEffect(
    () => () => {
      faceGridRequestId.current += 1;
      if (faceGridSourceObjectUrl.current) URL.revokeObjectURL(faceGridSourceObjectUrl.current);
      if (faceGridPreviewObjectUrl.current) URL.revokeObjectURL(faceGridPreviewObjectUrl.current);
    },
    [],
  );

  const cancelToolbarClose = useCallback(() => {
    if (toolbarCloseTimer.current !== null) window.clearTimeout(toolbarCloseTimer.current);
    toolbarCloseTimer.current = null;
  }, []);

  const keepToolbarOpen = useCallback(() => {
    cancelToolbarClose();
    setHovered(true);
    setToolbarDismissed(false);
    setActiveToolbarNodeId(id);
  }, [cancelToolbarClose, id, setActiveToolbarNodeId]);

  const scheduleToolbarClose = useCallback(() => {
    cancelToolbarClose();
    toolbarCloseTimer.current = window.setTimeout(() => {
      setHovered(false);
      toolbarCloseTimer.current = null;
    }, 130);
  }, [cancelToolbarClose]);

  useEffect(
    () => () => {
      cancelToolbarClose();
      const state = useCanvasStore.getState();
      if (state.activeToolbarNodeId === id) state.setActiveToolbarNodeId(null);
    },
    [cancelToolbarClose, id],
  );

  useEffect(() => {
    if (!isSoleSelectedNode || marqueeActive) return;
    setToolbarDismissed(false);
    setActiveToolbarNodeId(id);
  }, [id, isSoleSelectedNode, marqueeActive, setActiveToolbarNodeId]);

  useEffect(() => {
    if (!toolbarVisible) return;
    const dismissOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-canvas-node-toolbar]")) return;
      const targetNode = target.closest<HTMLElement>("[data-wc-node-id]");
      if (targetNode?.dataset.kcNodeId === id) return;
      setHovered(false);
      setToolbarDismissed(true);
      setActiveToolbarNodeId(null);
    };
    window.addEventListener("pointerdown", dismissOutside);
    return () => window.removeEventListener("pointerdown", dismissOutside);
  }, [id, setActiveToolbarNodeId, toolbarVisible]);

  const closeOverlay = useCallback(() => {
    commitTransaction();
    setOverlayMode(null);
  }, [commitTransaction]);

  const downloadMedia = useCallback(async () => {
    if (!mediaUrl || !data.media) return;
    try {
      await downloadUrl(mediaUrl, data.media.name);
      showToast("媒体下载已开始", "success");
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "视频下载失败，请稍后重试", "error");
    }
  }, [data.media, mediaUrl, showToast]);

  const captureVideoFrame = useCallback(async () => {
    if (capturingFrame || data.kind !== "video" || !videoPlayer.current) return;
    setCapturingFrame(true);
    try {
      const blob = await videoPlayer.current.captureCurrentFrame();
      const file = new File([blob], `video-frame-${Date.now()}.png`, { type: "image/png" });
      const media = await storeMedia(file, "image");
      const frameNodeId = addConnectedNode(id, "right", "image");
      if (!frameNodeId) {
        await removeMedia(media.id);
        throw new Error("无法创建截帧节点");
      }
      setNodeMedia(frameNodeId, media, false);
      updateNodeData(frameNodeId, { status: "success" }, false);
      showToast("当前画面已生成图片节点", "success");
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "视频截帧失败", "error");
    } finally {
      setCapturingFrame(false);
    }
  }, [addConnectedNode, capturingFrame, data.kind, id, setNodeMedia, showToast, updateNodeData]);

  const openGenerationEditor = useCallback(() => {
    if (data.kind === "edit") return;
    if (data.kind === "audio" || data.kind === "text") {
      setGenerationOpen(true);
      return;
    }
    const state = useCanvasStore.getState();
    state.onNodesChange(
      state.nodes.map((node) => ({
        id: node.id,
        type: "select" as const,
        selected: node.id === id,
      })),
    );
    window.requestAnimationFrame(() => {
      const selector =
        data.kind === "config"
          ? "[data-node-configuration-composer] .wc-canvas-select-trigger"
          : "[data-node-prompt-composer] [data-prompt-editor]";
      document.querySelector<HTMLElement>(selector)?.focus();
    });
  }, [data.kind, id]);

  const openExpandedContent = useCallback(() => {
    if (data.kind === "edit") {
      setClipEditorOpen(true);
      return;
    }
    if (data.kind !== "text" && data.kind !== "image" && data.kind !== "video") return;
    if ((data.kind === "image" || data.kind === "video") && !mediaUrl) return;
    setOverlayMode(data.kind === "text" ? "edit" : "preview");
  }, [data.kind, mediaUrl]);

  const rememberExpandedPointer = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (
        event.button !== 0 ||
        (data.kind !== "edit" &&
          data.kind !== "text" &&
          data.kind !== "image" &&
          data.kind !== "video")
      )
        return;
      if (data.kind !== "edit" && (data.kind === "image" || data.kind === "video") && !mediaUrl)
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "button, input, textarea, select, a, [contenteditable='true'], [data-canvas-node-toolbar]",
        )
      )
        return;
      expandedPointer.current = { at: performance.now(), x: event.clientX, y: event.clientY };
    },
    [data.kind, mediaUrl],
  );

  useEffect(() => {
    const catchSecondPointer = (event: globalThis.PointerEvent) => {
      const first = expandedPointer.current;
      if (!first || event.button !== 0) return;
      const elapsed = performance.now() - first.at;
      const distance = Math.hypot(event.clientX - first.x, event.clientY - first.y);
      expandedPointer.current = null;
      if (elapsed > 360 || distance > 10) return;
      event.preventDefault();
      event.stopPropagation();
      openExpandedContent();
    };
    window.addEventListener("pointerdown", catchSecondPointer, true);
    return () => window.removeEventListener("pointerdown", catchSecondPointer, true);
  }, [openExpandedContent]);

  // 入场动画只对真正新建的节点播（详见 shouldPlayNodeEntrance）。
  const playEntrance = shouldPlayNodeEntrance(id, data.createdAt);

  return (
    <div
      className={`wc-node-wrap wc-node-wrap--${data.kind} wc-accent--${visualAccent}${playEntrance ? " wc-node-entering" : ""}`}
      data-node-kind={data.kind}
      data-node-status={displayStatus}
      data-wc-node-id={id}
      data-wc-node-absent={present ? undefined : "true"}
      data-node-uploading={uploadingMedia ? "true" : undefined}
      aria-busy={generationInFlight || uploadingMedia}
      onPointerEnter={keepToolbarOpen}
      onPointerLeave={scheduleToolbarClose}
      onPointerDownCapture={rememberExpandedPointer}
    >
      {compactOverview ? null : (
        <span className="wc-node-type-label">
          <Icon aria-hidden="true" />
          {nodeLabel(data.kind)}
        </span>
      )}
      {toolbarVisible ? (
        <NodeActionToolbar
          visible
          kind={data.kind}
          hasMedia={Boolean(mediaUrl)}
          showGenerationAction={
            data.kind !== "edit" &&
            (data.kind === "audio" || data.kind === "text" || !isSoleSelectedNode)
          }
          onInfo={() => setOverlayMode("info")}
          onGenerate={openGenerationEditor}
          onEdit={
            data.kind === "edit" ? () => setClipEditorOpen(true) : () => setOverlayMode("edit")
          }
          onPreview={() => setOverlayMode("preview")}
          onDownload={downloadMedia}
          onFaceGrid={openFaceGrid}
          onAnnotate={() => void openAnnotate()}
          onCaptureVideoFrame={() => void captureVideoFrame()}
          onOpenDirector={() => openDirectorFromNode(id, data.body)}
          onUpload={() => mediaInput.current?.click()}
          onDelete={() => {
            setActiveToolbarNodeId(null);
            deleteNode(id);
          }}
          onPointerEnter={keepToolbarOpen}
          onPointerLeave={scheduleToolbarClose}
        />
      ) : null}
      <div className="wc-node-drag-strip" aria-hidden="true" />
      <section className="wc-node-surface">
        {isMedia ? (
          <MediaBody
            id={id}
            kind={data.kind as MediaNodeKind}
            media={data.media}
            music={data.music}
            input={mediaInput}
            url={mediaUrl}
            // 图片展示用缩略变体；视频/音频仍走原 URL（音频无画面，视频有独立播放器）。
            displayUrl={imageDisplayUrl}
            missing={mediaMissing}
            loading={mediaLoading}
            priority={selected || hovered || data.status === "running"}
            videoPlayer={videoPlayer}
          />
        ) : PluginBody ? (
          <PluginBodyBoundary pluginKind={data.kind}>
            <PluginBody
              kind={data.kind}
              nodeId={id}
              projectId={projectId}
              data={data}
              ops={pluginBodyOps}
              updateBody={(nextBody) =>
                useCanvasStore.getState().updateNodeData(id, { body: nextBody }, true)
              }
            />
          </PluginBodyBoundary>
        ) : data.kind === "config" ? (
          compactOverview ? (
            <div className="wc-config-node-preview wc-config-node-preview--overview">
              <strong>{configurationModalityLabels[data.config?.modality ?? "image"]}配置</strong>
            </div>
          ) : (
            <ConfigurationBody id={id} data={data} />
          )
        ) : data.kind === "text" ? (
          <div
            className="wc-node-text-preview nowheel"
            tabIndex={0}
            aria-label={`${nodeLabel(data.kind)}内容`}
          >
            {data.body || <span>输入创作内容</span>}
          </div>
        ) : data.kind === "edit" ? (
          <EditNodePreview edit={data.edit} compact={compactOverview} />
        ) : null}
        {uploadingMedia ? (
          <NodeLoadingState
            variant={data.kind === "image" || data.kind === "video" ? data.kind : "default"}
            activity="loading"
            label={
              data.kind === "video"
                ? "正在上传视频"
                : data.kind === "image"
                  ? "正在上传图片"
                  : "正在上传素材"
            }
          />
        ) : null}
        {generationInFlight && !uploadingMedia ? (
          <NodeLoadingState
            variant={data.kind === "image" || data.kind === "video" ? data.kind : "default"}
            activity="generation"
            status={data.generation.jobStatus}
            progress={generationProgress}
            stalled={generationStalled}
            observationExhausted={observationExhausted}
            generationEffectStyle={generationEffectStyle}
          />
        ) : null}
        {displayStatus === "error" && generationError ? (
          <button
            type="button"
            className="wc-node-generation-failure nodrag nowheel"
            title={generationError}
            onClick={() => setGenerationOpen(true)}
          >
            <AlertCircle aria-hidden="true" />
            <span>{generationError}</span>
          </button>
        ) : null}
      </section>
      {compactOverview ? (
        <OverviewNodePorts />
      ) : (
        <>
          <NodePort nodeId={id} side="left" />
          <NodePort nodeId={id} side="right" />
        </>
      )}
      {overlayMode ? (
        <NodeOverlay
          mode={overlayMode}
          data={data}
          width={width}
          height={height}
          mediaUrl={mediaUrl}
          onClose={closeOverlay}
          onBodyChange={(body) => updateNodeData(id, { body }, false)}
          onEditFocus={beginTransaction}
          onEditBlur={commitTransaction}
        />
      ) : null}
      {faceGridOpen ? (
        <FaceGridPanel
          open
          sourceUrl={faceGridSourceUrl}
          sourceName={data.media?.name}
          value={faceGridSettings}
          status={faceGridStatus}
          error={faceGridError}
          faceCount={faceGridFaceCount}
          previewUrl={faceGridPreviewUrl}
          manualSelection={faceGridManualSelection}
          applying={applyingFaceGrid}
          onChange={updateFaceGridSettings}
          onDetect={detectFaceGridAutomatically}
          onManualSelectionChange={updateFaceGridManualSelection}
          onApply={applyFaceGrid}
          onClose={resetFaceGrid}
        />
      ) : null}
      {annotateOpen ? (
        <ImageAnnotatePanel
          open
          image={annotateImage}
          sourceName={data.media?.name}
          applying={applyingAnnotate}
          onApply={applyAnnotate}
          onClose={() => {
            setAnnotateOpen(false);
            setAnnotateImage(null);
          }}
        />
      ) : null}
      {generationOpen ? (
        <NodeGenerationPanel
          nodeId={id}
          data={data}
          onClose={() => {
            commitTransaction();
            setGenerationOpen(false);
          }}
        />
      ) : null}
      {clipEditorOpen ? (
        <Suspense fallback={null}>
          <ClipEditorHost
            nodeId={id}
            data={data}
            projectId={projectId}
            cloudLinked={cloudLinked}
            onClose={() => setClipEditorOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
});
