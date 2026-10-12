import { createId } from "@weftcanvas/canvas-core";
import {
  CANVAS_SCHEMA_VERSION,
  type AgentAction,
  type CanvasDirectorCapture,
  type CanvasGroup,
  type CanvasMedia,
  type CanvasNodeData,
  type CanvasNodeKind,
  type CanvasProject,
  type CanvasViewport,
  type GenerationArtifact,
  type PublicGenerationJob,
} from "@weftcanvas/contracts";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import { create } from "zustand";

import {
  createCanvasEdge,
  createCanvasNode,
  mediaNodeDimensions,
  nodeDefaultDimensions,
} from "../lib/node-factory";
import {
  arrangeGroupNodes,
  nextGroupName,
  normalizeGroups,
  pickGroupColor,
} from "../lib/node-groups";
import {
  findConfigurationSource,
  resizeMediaNodeToAspectRatio,
  syncAllConfigurationTargets,
  syncConfigurationTargets,
} from "../lib/node-configuration";
import { findConnectedNodeColumnPositions, findConnectedNodePosition } from "../lib/node-placement";
import { generationParametersAspectRatio } from "../lib/node-size";
import { pruneDisconnectedPromptReferences } from "../lib/prompt-references";
import { LEGACY_PROJECT_STORAGE_KEY, loadProjectLibrary } from "../lib/project-library";
import {
  cancelServerMediaDeletion,
  scheduleServerMediaDeletion,
} from "../lib/server-media-deletion";
import type { GraphSnapshot, WeftcanvasEdge, WeftcanvasNode } from "../types";
import { useMembershipTaskStore } from "./membership-task-store";
import { useUiPreferencesStore } from "./ui-preferences-store";

export const PROJECT_STORAGE_KEY = LEGACY_PROJECT_STORAGE_KEY;
const HISTORY_LIMIT = 80;

type SaveState = "saved" | "saving" | "error";

type CapturedImageInput = {
  position: XYPosition;
  media: CanvasMedia;
  body: string;
  directorCapture: CanvasDirectorCapture;
};

type CanvasInsertInput = {
  kind: CanvasNodeKind;
  position: XYPosition;
  data?: Partial<CanvasNodeData>;
};

type GenerationUpdateOptions = {
  result?: "text" | "media";
  anchorId?: string;
  expectedJobId?: string;
};

type GenerationUpdate =
  Partial<CanvasNodeData> | ((node: WeftcanvasNode) => Partial<CanvasNodeData>);

type MediaDimensionUpdate = {
  id: string;
  mediaId: string;
  width: number;
  height: number;
};

export type AgentCanvasActionResult = {
  applied: number;
  skipped: number;
  skippedActions: Array<{ index: number; reason: string }>;
  createdNodeIds: Record<string, string>;
};

type CanvasState = {
  projectId: string;
  projectName: string;
  createdAt: number;
  nodes: WeftcanvasNode[];
  edges: WeftcanvasEdge[];
  groups: CanvasGroup[];
  viewport: CanvasViewport;
  past: GraphSnapshot[];
  future: GraphSnapshot[];
  transactionBase: GraphSnapshot | null;
  clipboard: GraphSnapshot | null;
  saveState: SaveState;
  lastSavedAt: number | null;
  activeToolbarNodeId: string | null;
  onNodesChange: (changes: NodeChange<WeftcanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WeftcanvasEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  connectSelectionToNode: (targetNodeId: string, direction: "outgoing" | "incoming") => number;
  setViewport: (viewport: CanvasViewport) => void;
  setProjectName: (name: string) => void;
  applyAgentActions: (actions: AgentAction[]) => AgentCanvasActionResult;
  addNode: (kind: CanvasNodeKind, position: XYPosition) => string;
  addImportedNodes: (items: CanvasInsertInput[]) => string[];
  addCapturedImages: (items: CapturedImageInput[], sourceNodeId?: string | null) => string[];
  addConnectedNode: (
    anchorId: string,
    side: "left" | "right",
    kind: CanvasNodeKind,
    position?: XYPosition,
  ) => string | null;
  addGeneratedConnectedNode: (
    anchorId: string,
    kind: CanvasNodeKind,
    patch: Partial<CanvasNodeData>,
  ) => string | null;
  /**
   * 客户端批量出图：一次请求发多张时，先把占位的兄弟节点按一列排好再逐个提交，
   * 结果落回各自节点 —— 与单次多图（Midjourney）的成品外观一致。
   */
  addGenerationBatchNodes: (
    anchorId: string,
    kind: CanvasNodeKind,
    count: number,
    patch: Partial<CanvasNodeData>,
  ) => string[];
  resizeNodeByFactor: (id: string, requestedFactor: number, record?: boolean) => void;
  resizeMediaNodeForGenerationParameters: (
    id: string,
    parameters: Record<string, unknown>,
    options?: { record?: boolean; preferredParameter?: string; force?: boolean },
  ) => void;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>, record?: boolean) => void;
  setNodeMedia: (id: string, media: CanvasMedia, record?: boolean) => void;
  setNodeMediaDimensions: (updates: MediaDimensionUpdate[]) => void;
  applyGenerationUpdate: (
    id: string,
    patch: GenerationUpdate,
    options?: GenerationUpdateOptions,
  ) => void;
  applyGenerationJob: (job: PublicGenerationJob) => void;
  deleteNode: (id: string) => void;
  disconnectNodes: (sourceId: string, targetId: string) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  copySelection: () => void;
  pasteSelection: (position?: XYPosition, snapshot?: GraphSnapshot) => void;
  selectAll: () => void;
  selectEdge: (id: string) => void;
  clearSelection: () => void;
  groupSelection: () => string | null;
  ungroupSelection: () => void;
  selectGroup: (id: string) => void;
  moveGroupBy: (id: string, delta: XYPosition) => void;
  setNodeGroupMembership: (nodeId: string, groupId: string | null) => void;
  scaleGroupBy: (id: string, factor: number, anchor: XYPosition) => void;
  arrangeGroup: (id: string) => void;
  renameGroup: (id: string, name: string) => void;
  setGroupColor: (id: string, color: string) => void;
  ungroup: (id: string) => void;
  clearCanvas: () => void;
  beginTransaction: () => void;
  commitTransaction: () => void;
  undo: () => void;
  redo: () => void;
  replaceProject: (project: CanvasProject) => void;
  resetProject: (name?: string) => void;
  setSaveState: (saveState: SaveState, lastSavedAt?: number | null) => void;
  setActiveToolbarNodeId: (id: string | null) => void;
};

function cloneGraph(
  nodes: WeftcanvasNode[],
  edges: WeftcanvasEdge[],
  groups: CanvasGroup[],
): GraphSnapshot {
  return structuredClone({ nodes, edges, groups });
}

/** 节点删除后，为其不再被引用的服务端素材安排延时释放（45 秒撤销窗口）。 */
function releaseUnreferencedServerMedia(
  removed: WeftcanvasNode | undefined,
  remaining: WeftcanvasNode[],
) {
  const media = removed?.data.media;
  if (!media) return;
  if (remaining.some((node) => node.data.media?.id === media.id)) return;
  scheduleServerMediaDeletion(media);
}

function releaseUnreferencedServerMediaMany(
  removed: WeftcanvasNode[],
  remaining: WeftcanvasNode[],
) {
  for (const node of removed) releaseUnreferencedServerMedia(node, remaining);
}

function cancelPendingDeletionsForNodes(nodes: WeftcanvasNode[]) {
  for (const node of nodes) {
    if (node.data.media) cancelServerMediaDeletion(node.data.media.id);
  }
}

/**
 * Create a reusable copy of a node without carrying over generation runtime
 * state. Jobs belong to the original node; a duplicate starts idle and can be
 * submitted as a new request. Persisted prompt/model settings and media stay
 * intact so copying a completed node remains useful.
 */
function cloneNodeForReuse(
  node: WeftcanvasNode,
  mapReferenceId: (id: string) => string | undefined = (id) => id,
): WeftcanvasNode {
  const copy = structuredClone(node);
  const generation = copy.data.generation;
  const active =
    copy.data.status === "running" ||
    ["reserved", "submitting", "queued", "running", "validating"].includes(
      generation.jobStatus ?? "",
    );
  const media = active ? null : copy.data.media;
  return {
    ...copy,
    data: {
      ...copy.data,
      status: media ? "success" : "idle",
      progress: null,
      media,
      directorCapture: active ? null : copy.data.directorCapture,
      generation: {
        modelId: generation.modelId,
        parameters: structuredClone(generation.parameters),
        referenceImagePurposes: structuredClone(generation.referenceImagePurposes),
        maxOutputTokens: generation.maxOutputTokens,
        referenceMode: generation.referenceMode,
        referenceNodeIds: generation.referenceNodeIds.flatMap((id) => {
          const mapped = mapReferenceId(id);
          return mapped ? [mapped] : [];
        }),
        jobId: null,
        jobVersion: null,
        jobCreatedAt: null,
        jobStatus: null,
        error: null,
      },
    },
  };
}

const transientNodeFields = new Set(["selected", "dragging", "measured"]);
const transientEdgeFields = new Set(["selected"]);

function sameGraphValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameGraphValue(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key) || !sameGraphValue(leftRecord[key], rightRecord[key]))
      return false;
  }
  return true;
}

function sameGraphRecordExcept(left: object, right: object, transientFields: ReadonlySet<string>) {
  if (left === right) return true;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => !transientFields.has(key));
  const rightKeys = Object.keys(rightRecord).filter((key) => !transientFields.has(key));
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key) || !sameGraphValue(leftRecord[key], rightRecord[key]))
      return false;
  }
  return true;
}

function sameGraphContent(left: GraphSnapshot, right: GraphSnapshot) {
  if (left.nodes.length !== right.nodes.length || left.edges.length !== right.edges.length)
    return false;
  for (let index = 0; index < left.nodes.length; index += 1) {
    if (!sameGraphRecordExcept(left.nodes[index]!, right.nodes[index]!, transientNodeFields))
      return false;
  }
  for (let index = 0; index < left.edges.length; index += 1) {
    if (!sameGraphRecordExcept(left.edges[index]!, right.edges[index]!, transientEdgeFields))
      return false;
  }
  return sameGraphValue(left.groups, right.groups);
}

function loadInitialState() {
  const now = Date.now();
  try {
    const project = loadProjectLibrary().activeProject;
    if (project) {
      const nodes = (project.nodes as WeftcanvasNode[]).map(restoreNodeDimensions);
      const edges = project.edges as WeftcanvasEdge[];
      return {
        projectId: project.id,
        projectName: project.name,
        createdAt: project.createdAt,
        nodes: syncAllConfigurationTargets(nodes, edges),
        edges,
        groups: project.groups,
        viewport: project.viewport,
      };
    }
  } catch {
    // Fall back to an in-memory empty project without deleting recoverable data.
  }
  return {
    projectId: createId("project"),
    projectName: "纬线 1",
    createdAt: now,
    nodes: [],
    edges: [],
    groups: [],
    viewport: createEmptyProjectViewport(),
  };
}

function createEmptyProjectViewport(): CanvasViewport {
  const width = typeof window === "undefined" ? 1440 : window.innerWidth;
  const height = typeof window === "undefined" ? 900 : window.innerHeight;
  const zoom = 0.7;
  return { x: Math.round(width / 2), y: Math.round(height / 2), zoom };
}

function agentNodePosition(viewport: CanvasViewport, index: number): XYPosition {
  const width = typeof window === "undefined" ? 1440 : window.innerWidth;
  const height = typeof window === "undefined" ? 900 : window.innerHeight;
  const column = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: (width * 0.5 - viewport.x) / viewport.zoom - 154 + column * 348,
    y: (height * 0.48 - viewport.y) / viewport.zoom - 88 + row * 216,
  };
}

const initial = loadInitialState();

export type CanvasNodePositionChange = Extract<NodeChange<WeftcanvasNode>, { type: "position" }>;
type NodePositionChangeProducer = () => CanvasNodePositionChange[];

const pendingNodePositionChanges = new Map<string, CanvasNodePositionChange>();
const pendingNodePositionChangeProducers = new Map<string, NodePositionChangeProducer>();
let pendingNodePositionFrame: number | null = null;

/**
 * 将连续鼠标移动压缩为每帧一次受控节点更新，拖动结束和撤销前会同步冲刷最后一个位置。
 */
function flushPendingNodePositionChanges() {
  if (pendingNodePositionFrame !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(pendingNodePositionFrame);
  }
  pendingNodePositionFrame = null;
  for (const producer of pendingNodePositionChangeProducers.values()) {
    for (const change of producer()) pendingNodePositionChanges.set(change.id, change);
  }
  pendingNodePositionChangeProducers.clear();
  if (!pendingNodePositionChanges.size) return;
  const changes = [...pendingNodePositionChanges.values()];
  pendingNodePositionChanges.clear();
  useCanvasStore.setState((state) => ({ nodes: applyNodeChanges(changes, state.nodes) }));
}

/**
 * 项目替换不能提交上一项目尚未渲染的位置帧，避免相同节点 ID 被旧拖动结果污染。
 */
function discardPendingNodePositionChanges() {
  if (pendingNodePositionFrame !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(pendingNodePositionFrame);
  }
  pendingNodePositionFrame = null;
  pendingNodePositionChanges.clear();
  pendingNodePositionChangeProducers.clear();
}

function schedulePendingNodePositionFrame() {
  if (pendingNodePositionFrame !== null) return;
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    flushPendingNodePositionChanges();
    return;
  }
  pendingNodePositionFrame = window.requestAnimationFrame(() => flushPendingNodePositionChanges());
}

/**
 * 仅位置变化允许延迟到下一帧；选中、删除和尺寸事件仍必须立即交给画布状态机处理。
 */
function queueNodePositionChanges(changes: CanvasNodePositionChange[]) {
  for (const change of changes) pendingNodePositionChanges.set(change.id, change);
  schedulePendingNodePositionFrame();
}

export function queueCanvasNodePositionChanges(key: string, producer: NodePositionChangeProducer) {
  pendingNodePositionChangeProducers.set(key, producer);
  schedulePendingNodePositionFrame();
}

function pushPast(state: CanvasState, before: GraphSnapshot) {
  return [...state.past, before].slice(-HISTORY_LIMIT);
}

type GenerationNodeProjection = {
  node: WeftcanvasNode;
  result: "none" | "text" | "media";
  createdByJob: boolean;
};

type GenerationNodeOrigins = {
  visibleOrigin: WeftcanvasNode | null;
  pastOrigin: WeftcanvasNode | null;
  futureOrigin: WeftcanvasNode | null;
  pastSnapshot: GraphSnapshot | null;
  futureSnapshot: GraphSnapshot | null;
};

const GENERATION_RUNTIME_KEYS = [
  "modelId",
  "jobId",
  "jobVersion",
  "jobCreatedAt",
  "jobStatus",
  "artifactId",
  "submissionKey",
  "error",
] as const;

function mergeGenerationNode(
  node: WeftcanvasNode,
  projection: GenerationNodeProjection,
): WeftcanvasNode {
  const source = projection.node;
  const generation = { ...node.data.generation } as Record<string, unknown>;
  const sourceGeneration = source.data.generation as Record<string, unknown>;
  for (const key of GENERATION_RUNTIME_KEYS) {
    if (key in sourceGeneration || key in generation)
      generation[key] = structuredClone(sourceGeneration[key]);
  }

  const data: CanvasNodeData = {
    ...node.data,
    status: source.data.status,
    progress: source.data.progress,
    generation: generation as CanvasNodeData["generation"],
    updatedAt: source.data.updatedAt,
  };
  if (projection.result === "text") {
    data.body = source.data.body;
    data.media = null;
  } else if (projection.result === "media") {
    data.media = source.data.media ? structuredClone(source.data.media) : null;
  }

  return {
    ...node,
    ...(projection.result === "media" && source.width !== undefined ? { width: source.width } : {}),
    ...(projection.result === "media" && source.height !== undefined
      ? { height: source.height }
      : {}),
    data,
  };
}

function projectGenerationSnapshot(
  snapshot: GraphSnapshot,
  projections: readonly GenerationNodeProjection[],
  projectionById: ReadonlyMap<string, GenerationNodeProjection>,
  createdEdges: WeftcanvasEdge[],
  insertMissing: ReadonlySet<string>,
): GraphSnapshot {
  const hasProjectedNode = snapshot.nodes.some((node) => projectionById.has(node.id));
  if (!hasProjectedNode && insertMissing.size === 0) return snapshot;

  let changed = false;
  const nodes = hasProjectedNode
    ? snapshot.nodes.map((node) => {
        const projection = projectionById.get(node.id);
        if (!projection) return node;
        changed = true;
        return mergeGenerationNode(node, projection);
      })
    : [...snapshot.nodes];
  let nodeIds: Set<string> | null = null;
  if (insertMissing.size > 0) {
    nodeIds = new Set(nodes.map((node) => node.id));
    for (const projection of projections) {
      if (nodeIds.has(projection.node.id) || !insertMissing.has(projection.node.id)) continue;
      nodes.push(structuredClone(projection.node));
      nodeIds.add(projection.node.id);
      changed = true;
    }
  }

  let edges = snapshot.edges;
  if (createdEdges.length > 0) {
    nodeIds ??= new Set(nodes.map((node) => node.id));
    const edgeIds = new Set(snapshot.edges.map((edge) => edge.id));
    edges = [...snapshot.edges];
    for (const edge of createdEdges) {
      if (edgeIds.has(edge.id) || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      edges.push(structuredClone(edge));
      edgeIds.add(edge.id);
      changed = true;
    }
  }
  return changed ? { nodes, edges, groups: snapshot.groups } : snapshot;
}

function projectGenerationHistory(
  state: CanvasState,
  anchorId: string,
  projections: GenerationNodeProjection[],
  createdEdges: WeftcanvasEdge[],
  origins: Pick<GenerationNodeOrigins, "pastOrigin" | "futureOrigin">,
  projectTransactionBase: boolean,
) {
  const projectionById = new Map(projections.map((projection) => [projection.node.id, projection]));
  const generatedNodeIds = new Set(
    projections
      .filter((projection) => projection.createdByJob)
      .map((projection) => projection.node.id),
  );
  const anchorProjection = projections.find(
    (projection) => projection.node.id === anchorId && !projection.createdByJob,
  );
  let anchorSeenInPast = false;
  const past = state.past.map((snapshot) => {
    const insertMissing = new Set<string>();
    const anchorExists = snapshot.nodes.some((node) => node.id === anchorId);
    if (anchorExists) {
      anchorSeenInPast = true;
    } else if (anchorProjection && !anchorSeenInPast) {
      // Once a paid task is accepted, undoing the node-creation snapshot must
      // not make that running task or its eventual result disappear.
      insertMissing.add(anchorId);
    }
    const anchorWillExist = anchorExists || insertMissing.has(anchorId);
    if (anchorWillExist) generatedNodeIds.forEach((id) => insertMissing.add(id));
    return projectGenerationSnapshot(
      snapshot,
      projections,
      projectionById,
      createdEdges,
      insertMissing,
    );
  });
  const future = state.future.map((snapshot) => {
    const anchorExists = snapshot.nodes.some((node) => node.id === anchorId);
    return projectGenerationSnapshot(
      snapshot,
      projections,
      projectionById,
      createdEdges,
      anchorExists ? generatedNodeIds : new Set<string>(),
    );
  });
  // 隐藏任务的终态只能写入历史快照，不能把已删除节点回填进另一个手势的撤销基线。
  const transactionBase =
    state.transactionBase && projectTransactionBase
      ? (() => {
          const anchorExists = state.transactionBase.nodes.some((node) => node.id === anchorId);
          const anchorWasUndone =
            !anchorExists && origins.pastOrigin === null && origins.futureOrigin !== null;
          const insertMissing = anchorExists
            ? generatedNodeIds
            : anchorWasUndone
              ? new Set(projections.map((projection) => projection.node.id))
              : new Set<string>();
          return projectGenerationSnapshot(
            state.transactionBase,
            projections,
            projectionById,
            createdEdges,
            insertMissing,
          );
        })()
      : state.transactionBase;
  return { past, future, transactionBase };
}

type HistoryNodeMatch = {
  node: WeftcanvasNode;
  snapshot: GraphSnapshot;
};

function findHistoryNodeMatch(
  snapshots: GraphSnapshot[],
  id: string,
  newestFirst: boolean,
): HistoryNodeMatch | null {
  if (newestFirst) {
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index];
      const node = snapshot?.nodes.find((item) => item.id === id);
      if (node && snapshot) return { node, snapshot };
    }
    return null;
  }
  for (const snapshot of snapshots) {
    const node = snapshot.nodes.find((item) => item.id === id);
    if (node) return { node, snapshot };
  }
  return null;
}

/**
 * 一次定位同时保留节点和来源快照；可见节点的进度事件会在这里直接返回，避免扫描撤销/重做栈。
 */
function findGenerationNodeOrigins(
  state: Pick<CanvasState, "nodes" | "past" | "future">,
  id: string,
): GenerationNodeOrigins {
  const visibleOrigin = state.nodes.find((node) => node.id === id) ?? null;
  if (visibleOrigin) {
    return {
      visibleOrigin,
      pastOrigin: null,
      futureOrigin: null,
      pastSnapshot: null,
      futureSnapshot: null,
    };
  }

  const pastMatch = findHistoryNodeMatch(state.past, id, true);
  if (pastMatch) {
    return {
      visibleOrigin: null,
      pastOrigin: pastMatch.node,
      futureOrigin: null,
      pastSnapshot: pastMatch.snapshot,
      futureSnapshot: null,
    };
  }

  const futureMatch = findHistoryNodeMatch(state.future, id, false);
  return {
    visibleOrigin: null,
    pastOrigin: null,
    futureOrigin: futureMatch?.node ?? null,
    pastSnapshot: null,
    futureSnapshot: futureMatch?.snapshot ?? null,
  };
}

export function findCanvasGenerationNode(
  state: Pick<CanvasState, "nodes" | "past" | "future">,
  id: string,
) {
  const origins = findGenerationNodeOrigins(state, id);
  return origins.visibleOrigin ?? origins.pastOrigin ?? origins.futureOrigin;
}

export function listCanvasGenerationNodes(state: Pick<CanvasState, "nodes" | "past" | "future">) {
  const nodesById = new Map<string, WeftcanvasNode>();
  for (const node of state.nodes) nodesById.set(node.id, node);
  for (let index = state.past.length - 1; index >= 0; index -= 1) {
    for (const node of state.past[index]!.nodes) {
      if (!nodesById.has(node.id)) nodesById.set(node.id, node);
    }
  }
  for (const snapshot of state.future) {
    for (const node of snapshot.nodes) {
      if (!nodesById.has(node.id)) nodesById.set(node.id, node);
    }
  }
  return [...nodesById.values()];
}

function projectMediaSnapshot(
  snapshot: GraphSnapshot,
  id: string,
  source: WeftcanvasNode,
): GraphSnapshot {
  const sourceMedia = source.data.media;
  if (!sourceMedia) return snapshot;
  let changed = false;
  const nodes = snapshot.nodes.map((node) => {
    if (node.id !== id || node.data.media?.id !== sourceMedia.id) return node;
    const media = {
      ...node.data.media,
      width: sourceMedia.width,
      height: sourceMedia.height,
    };
    const dimensions = mediaNodeDimensions(node.data.kind, media, inferNodeScale(node));
    changed = true;
    return {
      ...node,
      width: dimensions.width,
      height: dimensions.height,
      data: {
        ...node.data,
        media,
        updatedAt: source.data.updatedAt,
      },
    };
  });
  return changed ? { ...snapshot, nodes } : snapshot;
}

function projectMediaHistory(state: CanvasState, id: string, source: WeftcanvasNode) {
  return {
    past: state.past.map((snapshot) => projectMediaSnapshot(snapshot, id, source)),
    future: state.future.map((snapshot) => projectMediaSnapshot(snapshot, id, source)),
    transactionBase: state.transactionBase
      ? projectMediaSnapshot(state.transactionBase, id, source)
      : null,
  };
}

/**
 * 将同一帧内多个媒体的尺寸回填合并到一次历史投影，避免旧项目加载时按媒体数量重复遍历撤销栈。
 */
function projectMediaSnapshotBatch(
  snapshot: GraphSnapshot,
  sourcesById: ReadonlyMap<string, WeftcanvasNode>,
): GraphSnapshot {
  let changed = false;
  const nodes = snapshot.nodes.map((node) => {
    const source = sourcesById.get(node.id);
    const sourceMedia = source?.data.media;
    if (!sourceMedia || node.data.media?.id !== sourceMedia.id) return node;
    if (
      node.data.media.width === sourceMedia.width &&
      node.data.media.height === sourceMedia.height
    )
      return node;
    const media = { ...node.data.media, width: sourceMedia.width, height: sourceMedia.height };
    changed = true;
    return resizeNodeForMedia(
      {
        ...node,
        data: { ...node.data, media, updatedAt: source.data.updatedAt },
      },
      media,
      inferNodeScale(node),
    );
  });
  return changed ? { ...snapshot, nodes } : snapshot;
}

/**
 * 批量尺寸更新也要同步历史快照，确保撤销和重做后媒体比例不会回退。
 */
function projectMediaHistoryBatch(
  state: CanvasState,
  sourcesById: ReadonlyMap<string, WeftcanvasNode>,
) {
  return {
    past: state.past.map((snapshot) => projectMediaSnapshotBatch(snapshot, sourcesById)),
    future: state.future.map((snapshot) => projectMediaSnapshotBatch(snapshot, sourcesById)),
    transactionBase: state.transactionBase
      ? projectMediaSnapshotBatch(state.transactionBase, sourcesById)
      : null,
  };
}

function isDuplicateConnection(edges: WeftcanvasEdge[], source: string, target: string) {
  return edges.some((edge) => edge.source === source && edge.target === target);
}

function pasteOffsetForPosition(
  nodes: WeftcanvasNode[],
  position: XYPosition,
  viewport: CanvasViewport,
): XYPosition {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const dimensions = nodeDefaultSize(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + dimensions.width);
    maxY = Math.max(maxY, node.position.y + dimensions.height);
  }
  const target = clampPastePosition(
    position,
    { width: maxX - minX, height: maxY - minY },
    viewport,
  );
  return { x: target.x - (minX + maxX) / 2, y: target.y - (minY + maxY) / 2 };
}

function clampPastePosition(
  position: XYPosition,
  size: { width: number; height: number },
  viewport: CanvasViewport,
): XYPosition {
  if (typeof window === "undefined") return position;
  const margin = 24 / viewport.zoom;
  const left = -viewport.x / viewport.zoom + margin;
  const top = -viewport.y / viewport.zoom + margin;
  const right = (window.innerWidth - viewport.x) / viewport.zoom - margin;
  const bottom = (window.innerHeight - viewport.y) / viewport.zoom - margin;
  const minX = left + size.width / 2;
  const maxX = right - size.width / 2;
  const minY = top + size.height / 2;
  const maxY = bottom - size.height / 2;
  return {
    x: minX <= maxX ? Math.min(Math.max(position.x, minX), maxX) : (left + right) / 2,
    y: minY <= maxY ? Math.min(Math.max(position.y, minY), maxY) : (top + bottom) / 2,
  };
}

function nodeDefaultSize(node: WeftcanvasNode) {
  return {
    width: node.measured?.width ?? node.width ?? nodeDefaultDimensions(node.data.kind).width,
    height: node.measured?.height ?? node.height ?? nodeDefaultDimensions(node.data.kind).height,
  };
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  ...initial,
  past: [],
  future: [],
  transactionBase: null,
  clipboard: null,
  saveState: "saved",
  lastSavedAt: null,
  activeToolbarNodeId: null,

  onNodesChange: (changes) => {
    if (changes.length > 0 && changes.every((change) => change.type === "position")) {
      const positionChanges = changes as CanvasNodePositionChange[];
      // React Flow owns the live drag position. Publishing every pointer frame to
      // the app store wakes persistence and every full-graph subscriber; the
      // final `dragging: false` change commits the same positions on pointer-up.
      if (positionChanges.every((change) => change.dragging === true)) {
        // Keep only the newest coordinates so pointercancel/blur can still commit
        // the gesture without scheduling any React or persistence work.
        for (const change of positionChanges) pendingNodePositionChanges.set(change.id, change);
        return;
      }
      queueNodePositionChanges(positionChanges);
      return;
    }
    flushPendingNodePositionChanges();
    set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) }));
  },
  onEdgesChange: (changes) =>
    set((state) => {
      const edges = applyEdgeChanges(changes, state.edges);
      // Selection changes arrive frequently while the graph is being explored.
      // They do not alter configuration bindings or prompt references.
      if (changes.every((change) => change.type === "select")) return { edges };
      const nodes = syncAllConfigurationTargets(state.nodes, edges);
      return { nodes: pruneDisconnectedPromptReferences(nodes, edges, state.nodes), edges };
    }),
  onConnect: (connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const state = get();
    if (isDuplicateConnection(state.edges, connection.source, connection.target)) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const next = createCanvasEdge(connection.source, connection.target);
    const edges = addEdge(
      { ...next, sourceHandle: connection.sourceHandle, targetHandle: connection.targetHandle },
      state.edges,
    );
    set({
      nodes: syncConfigurationTargets(state.nodes, edges, connection.source),
      edges,
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  connectSelectionToNode: (targetNodeId, direction) => {
    const state = get();
    const selectedIds = state.nodes.filter((node) => node.selected).map((node) => node.id);
    if (
      selectedIds.length < 2 ||
      selectedIds.includes(targetNodeId) ||
      !state.nodes.some((node) => node.id === targetNodeId)
    )
      return 0;
    const additions = selectedIds.flatMap((selectedId) => {
      const source = direction === "outgoing" ? selectedId : targetNodeId;
      const target = direction === "outgoing" ? targetNodeId : selectedId;
      return source !== target && !isDuplicateConnection(state.edges, source, target)
        ? [createCanvasEdge(source, target)]
        : [];
    });
    if (!additions.length) return 0;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const edges = [...state.edges, ...additions];
    const configurationSources = new Set(additions.map((edge) => edge.source));
    let nodes = state.nodes;
    for (const sourceId of configurationSources)
      nodes = syncConfigurationTargets(nodes, edges, sourceId);
    set({
      nodes,
      edges,
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
    return additions.length;
  },
  setViewport: (viewport) => set({ viewport, saveState: "saving" }),
  setProjectName: (projectName) =>
    set({ projectName: projectName || "纬线 1", saveState: "saving" }),
  applyAgentActions: (actions) => {
    const state = get();
    const defaultNodeAspectRatio = currentDefaultNodeAspectRatio();
    let nodes = structuredClone(state.nodes);
    let edges = structuredClone(state.edges);
    let groups = structuredClone(state.groups);
    let viewport = state.viewport;
    let applied = 0;
    let skipped = 0;
    const skippedActions: Array<{ index: number; reason: string }> = [];
    let graphChanged = false;
    let viewportChanged = false;
    const aliases = new Map<string, string>();
    const createdNodeIds: Record<string, string> = {};
    const resolveNodeId = (value: string) => aliases.get(value) ?? value;

    actions.forEach((action, index) => {
      if (action.type === "canvas_add_node") {
        if (aliases.has(action.clientId)) {
          skipped += 1;
          skippedActions.push({ index, reason: `节点别名 ${action.clientId} 重复` });
          return;
        }
        const node = createCanvasNode(
          action.kind,
          action.position ?? agentNodePosition(viewport, index),
          action.body ? { body: action.body } : {},
          defaultNodeAspectRatio,
        );
        aliases.set(action.clientId, node.id);
        createdNodeIds[action.clientId] = node.id;
        nodes = [...nodes.map((item) => ({ ...item, selected: false })), node];
        graphChanged = true;
        applied += 1;
        return;
      }

      if (action.type === "canvas_update_node") {
        const nodeId = resolveNodeId(action.nodeId);
        const exists = nodes.some((node) => node.id === nodeId);
        if (!exists) {
          skipped += 1;
          skippedActions.push({ index, reason: `没有找到节点 ${action.nodeId}` });
          return;
        }
        nodes = nodes.map((node) =>
          node.id !== nodeId
            ? node
            : {
                ...node,
                ...(action.position ? { position: action.position } : {}),
                ...(action.body !== undefined
                  ? { data: { ...node.data, body: action.body, updatedAt: Date.now() } }
                  : {}),
              },
        );
        graphChanged = true;
        applied += 1;
        return;
      }

      if (action.type === "canvas_connect_nodes") {
        const source = resolveNodeId(action.sourceNodeId);
        const target = resolveNodeId(action.targetNodeId);
        const valid =
          source !== target &&
          nodes.some((node) => node.id === source) &&
          nodes.some((node) => node.id === target) &&
          !isDuplicateConnection(edges, source, target);
        if (!valid) {
          skipped += 1;
          skippedActions.push({ index, reason: "连线节点无效、方向重复或指向自身" });
          return;
        }
        edges.push(createCanvasEdge(source, target));
        graphChanged = true;
        applied += 1;
        return;
      }

      if (action.type === "canvas_select_nodes") {
        const ids = new Set(
          action.nodeIds.map(resolveNodeId).filter((id) => nodes.some((node) => node.id === id)),
        );
        nodes = nodes.map((node) => ({ ...node, selected: ids.has(node.id) }));
        edges = edges.map((edge) => ({ ...edge, selected: false }));
        applied += 1;
        return;
      }

      if (action.type === "canvas_group_nodes") {
        const ids = [...new Set(action.nodeIds.map(resolveNodeId))].filter((id) =>
          nodes.some((node) => node.id === id),
        );
        const occupied = new Set(groups.flatMap((group) => group.nodeIds));
        if (ids.length < 2 || ids.some((id) => occupied.has(id))) {
          skipped += 1;
          skippedActions.push({ index, reason: "组合至少需要两个未加入其他组合的有效节点" });
          return;
        }
        const now = Date.now();
        groups.push({
          id: createId("group"),
          name: action.name || nextGroupName(groups),
          color: pickGroupColor(groups),
          nodeIds: ids,
          frame: null,
          createdAt: now,
          updatedAt: now,
        });
        nodes = nodes.map((node) => ({ ...node, selected: ids.includes(node.id) }));
        graphChanged = true;
        applied += 1;
        return;
      }

      if (action.type === "canvas_set_viewport") {
        viewport = action.viewport;
        viewportChanged = true;
        applied += 1;
      }
    });

    if (graphChanged || viewportChanged || applied) {
      if (graphChanged) nodes = syncAllConfigurationTargets(nodes, edges);
      set({
        nodes,
        edges,
        groups,
        viewport,
        activeToolbarNodeId: null,
        ...(graphChanged
          ? {
              past: pushPast(state, cloneGraph(state.nodes, state.edges, state.groups)),
              future: [],
            }
          : {}),
        ...(graphChanged || viewportChanged ? { saveState: "saving" as const } : {}),
      });
    }
    if (Object.keys(createdNodeIds).length > 0) {
      void useMembershipTaskStore.getState().recordNodeCreated();
    }
    return { applied, skipped, skippedActions, createdNodeIds };
  },
  addNode: (kind, position) => {
    const state = get();
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const node = createCanvasNode(kind, position, {}, currentDefaultNodeAspectRatio());
    set({
      nodes: [...state.nodes.map((item) => ({ ...item, selected: false })), node],
      edges: state.edges.map((edge) => ({ ...edge, selected: false })),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
    void useMembershipTaskStore.getState().recordNodeCreated();
    return node.id;
  },
  addImportedNodes: (items) => {
    if (!items.length) return [];
    const state = get();
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const defaultNodeAspectRatio = currentDefaultNodeAspectRatio();
    const inserted = items.map((item) => {
      const node = createCanvasNode(item.kind, item.position, item.data, defaultNodeAspectRatio);
      return node.data.media ? resizeNodeForMedia(node, node.data.media) : node;
    });
    set({
      nodes: [...state.nodes.map((node) => ({ ...node, selected: false })), ...inserted],
      edges: state.edges.map((edge) => ({ ...edge, selected: false })),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
    void useMembershipTaskStore.getState().recordNodeCreated();
    return inserted.map((node) => node.id);
  },
  addCapturedImages: (items, sourceNodeId = null) => {
    if (!items.length) return [];
    const state = get();
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const defaultNodeAspectRatio = currentDefaultNodeAspectRatio();
    const captures = items.map((item) => {
      const node = createCanvasNode(
        "image",
        item.position,
        {
          body: item.body,
          media: item.media,
          status: "success",
          directorCapture: item.directorCapture,
        },
        defaultNodeAspectRatio,
      );
      return resizeNodeForMedia(node, item.media);
    });
    const sourceExists = sourceNodeId
      ? state.nodes.some((node) => node.id === sourceNodeId)
      : false;
    const captureEdges = sourceExists
      ? captures.map((node) => createCanvasEdge(sourceNodeId!, node.id))
      : [];
    set({
      nodes: [...state.nodes.map((node) => ({ ...node, selected: false })), ...captures],
      edges: [...state.edges.map((edge) => ({ ...edge, selected: false })), ...captureEdges],
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
    void useMembershipTaskStore.getState().recordNodeCreated();
    return captures.map((node) => node.id);
  },
  addConnectedNode: (anchorId, side, kind, position) => {
    const state = get();
    const anchor = state.nodes.find((node) => node.id === anchorId);
    if (!anchor) return null;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const node = createCanvasNode(kind, anchor.position, {}, currentDefaultNodeAspectRatio());
    node.position = position ?? findConnectedNodePosition(anchor, node, side, state.nodes);
    const edge =
      side === "right"
        ? createCanvasEdge(anchor.id, node.id)
        : createCanvasEdge(node.id, anchor.id);
    const nodes = [...state.nodes.map((item) => ({ ...item, selected: false })), node];
    const edges = [...state.edges.map((item) => ({ ...item, selected: false })), edge];
    set({
      nodes: syncConfigurationTargets(nodes, edges, edge.source),
      edges,
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
    void useMembershipTaskStore.getState().recordNodeCreated();
    return node.id;
  },
  addGenerationBatchNodes: (anchorId, kind, count, patch) => {
    const state = get();
    const anchor = state.nodes.find((node) => node.id === anchorId);
    if (!anchor || count < 1) return [];
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const defaultNodeAspectRatio = currentDefaultNodeAspectRatio();
    const scale = inferNodeScale(anchor);
    const created = Array.from({ length: count }, () => {
      const node = createCanvasNode(kind, { x: 0, y: 0 }, patch, defaultNodeAspectRatio, scale);
      node.selected = false;
      return node;
    });
    const nodes = [...state.nodes, ...created];
    const positions = findConnectedNodeColumnPositions(anchor, created, nodes);
    created.forEach((node, index) => {
      node.position = positions[index] ?? findConnectedNodePosition(anchor, node, "right", nodes);
    });
    const edges = [...state.edges, ...created.map((node) => createCanvasEdge(anchorId, node.id))];
    set({
      nodes,
      edges,
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
    void useMembershipTaskStore.getState().recordNodeCreated();
    return created.map((node) => node.id);
  },
  addGeneratedConnectedNode: (anchorId, kind, patch) => {
    const state = get();
    const origins = findGenerationNodeOrigins(state, anchorId);
    const anchor = origins.visibleOrigin ?? origins.pastOrigin ?? origins.futureOrigin;
    if (!anchor) return null;
    const visibleAnchor = origins.visibleOrigin !== null;
    const hiddenSnapshot = visibleAnchor ? null : (origins.pastSnapshot ?? origins.futureSnapshot);
    const layoutNodes = visibleAnchor ? state.nodes : (hiddenSnapshot?.nodes ?? [anchor]);
    const defaultNodeAspectRatio = currentDefaultNodeAspectRatio();
    let node = createCanvasNode(kind, anchor.position, patch, defaultNodeAspectRatio);
    if (node.data.media) node = resizeNodeForMedia(node, node.data.media);
    node.position = findConnectedNodePosition(anchor, node, "right", layoutNodes);
    node.selected = false;
    const edge = createCanvasEdge(anchorId, node.id);
    const history = projectGenerationHistory(
      state,
      anchorId,
      [
        {
          node,
          result: node.data.media ? "media" : node.data.body ? "text" : "none",
          createdByJob: true,
        },
      ],
      [edge],
      origins,
      visibleAnchor,
    );
    set({
      nodes: visibleAnchor ? [...state.nodes, node] : state.nodes,
      edges: visibleAnchor ? [...state.edges, edge] : state.edges,
      ...history,
      saveState: "saving",
    });
    return node.id;
  },
  resizeNodeByFactor: (id, requestedFactor, record = true) => {
    if (!Number.isFinite(requestedFactor) || requestedFactor <= 0) return;
    const state = get();
    const node = state.nodes.find((item) => item.id === id);
    if (!node) return;

    // 框选多个节点时统一缩放：整组共用同一系数，锚点取选区包围盒中心，
    // 组内相对布局不散；单选时锚点即节点自身中心，行为与单独缩放一致。
    const targets = node.selected ? state.nodes.filter((item) => item.selected) : [node];
    const sizes = new Map(targets.map((item) => [item.id, nodeDefaultSize(item)]));
    let minFactor = Number.NEGATIVE_INFINITY;
    let maxFactor = Number.POSITIVE_INFINITY;
    for (const size of sizes.values()) {
      minFactor = Math.max(minFactor, 160 / size.width, 90 / size.height);
      maxFactor = Math.min(maxFactor, 4096 / size.width, 4096 / size.height);
    }
    const factor = Math.min(maxFactor, Math.max(minFactor, requestedFactor));
    if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.0001) return;

    const bounds = targets.reduce(
      (acc, item) => {
        const size = sizes.get(item.id)!;
        return {
          minX: Math.min(acc.minX, item.position.x),
          minY: Math.min(acc.minY, item.position.y),
          maxX: Math.max(acc.maxX, item.position.x + size.width),
          maxY: Math.max(acc.maxY, item.position.y + size.height),
        };
      },
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      },
    );
    const anchor = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };

    const targetIds = new Set(sizes.keys());
    const before =
      record && !state.transactionBase ? cloneGraph(state.nodes, state.edges, state.groups) : null;
    const nodes = state.nodes.map((item) => {
      if (!targetIds.has(item.id)) return item;
      const size = sizes.get(item.id)!;
      const width = size.width * factor;
      const height = size.height * factor;
      const centerX = item.position.x + size.width / 2;
      const centerY = item.position.y + size.height / 2;
      return {
        ...item,
        width,
        height,
        position: {
          x: anchor.x + (centerX - anchor.x) * factor - width / 2,
          y: anchor.y + (centerY - anchor.y) * factor - height / 2,
        },
      };
    });

    set({
      nodes,
      ...(before ? { past: pushPast(state, before), future: [] } : {}),
      saveState: "saving",
    });
  },
  resizeMediaNodeForGenerationParameters: (id, parameters, options) => {
    const state = get();
    const requested = state.nodes.find((node) => node.id === id);
    if (!requested) return;
    const preferredParameter = options?.preferredParameter;
    const aspectRatio = generationParametersAspectRatio(parameters, preferredParameter);
    const previousAspectRatio = generationParametersAspectRatio(
      requested.data.generation.parameters,
      preferredParameter,
    );
    if (aspectRatio === null || aspectRatiosEqual(aspectRatio, previousAspectRatio)) return;

    const targetIds = new Set<string>();
    if (requested.data.kind === "image" || requested.data.kind === "video") {
      targetIds.add(requested.id);
    } else if (requested.data.kind === "config") {
      const modality = requested.data.config?.modality ?? "image";
      if (modality === "image" || modality === "video") {
        const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
        for (const edge of state.edges) {
          if (edge.source !== requested.id) continue;
          const target = nodesById.get(edge.target);
          if (target?.data.kind !== modality) continue;
          if (findConfigurationSource(target.id, state.nodes, state.edges)?.id === requested.id) {
            targetIds.add(target.id);
          }
        }
      }
    }
    if (!targetIds.size) return;

    let changed = false;
    const nodes = state.nodes.map((node) => {
      if (!targetIds.has(node.id)) return node;
      // 自动写入的模型默认参数（自动选模型、能力 reconcile）不得改写创建者的
      // 默认画幅：空节点只在用户显式配置过画幅或媒体落地后才跟随参数比例。
      if (!node.data.media && !node.data.generation.aspectExplicit && !options?.force) return node;
      const next = resizeMediaNodeToAspectRatio(node, aspectRatio);
      if (next !== node) changed = true;
      return next;
    });
    if (!changed) return;

    const before =
      (options?.record ?? true) && !state.transactionBase
        ? cloneGraph(state.nodes, state.edges, state.groups)
        : null;
    set({
      nodes,
      ...(before ? { past: pushPast(state, before), future: [] } : {}),
      saveState: "saving",
    });
  },
  updateNodeData: (id, patch, record = true) => {
    const state = get();
    const before =
      record && !state.transactionBase ? cloneGraph(state.nodes, state.edges, state.groups) : null;
    let nodes = state.nodes.map((node) =>
      node.id === id ? { ...node, data: { ...node.data, ...patch, updatedAt: Date.now() } } : node,
    );
    if (nodes.find((node) => node.id === id)?.data.kind === "config") {
      nodes = syncConfigurationTargets(nodes, state.edges, id);
    }
    set({
      nodes,
      ...(before ? { past: pushPast(state, before), future: [] } : {}),
      saveState: "saving",
    });
  },
  setNodeMedia: (id, media, record = true) => {
    cancelServerMediaDeletion(media.id);
    const state = get();
    const current = state.nodes.find((node) => node.id === id);
    if (!current) return;
    const nodeScale = inferNodeScale(current);
    const dimensions = mediaNodeDimensions(current.data.kind, media, nodeScale);
    if (
      mediaMetadataEqual(current.data.media, media) &&
      current.width === dimensions.width &&
      current.height === dimensions.height
    )
      return;
    const before =
      record && !state.transactionBase ? cloneGraph(state.nodes, state.edges, state.groups) : null;
    let updatedNode: WeftcanvasNode | null = null;
    const nodes = state.nodes.map((node) => {
      if (node.id !== id) return node;
      updatedNode = resizeNodeForMedia(
        {
          ...node,
          data: { ...node.data, media, updatedAt: Date.now() },
        },
        media,
        nodeScale,
      );
      return updatedNode;
    });
    const history = !record && updatedNode ? projectMediaHistory(state, id, updatedNode) : null;
    set({
      nodes,
      ...(before ? { past: pushPast(state, before), future: [] } : {}),
      ...(history ?? {}),
      saveState: "saving",
    });
  },
  setNodeMediaDimensions: (updates) => {
    if (!updates.length) return;
    const state = get();
    const updatesById = new Map<string, MediaDimensionUpdate>();
    for (const update of updates) {
      if (!Number.isFinite(update.width) || !Number.isFinite(update.height)) continue;
      if (update.width <= 0 || update.height <= 0) continue;
      updatesById.set(update.id, update);
    }
    if (!updatesById.size) return;

    const updatedAt = Date.now();
    const sourcesById = new Map<string, WeftcanvasNode>();
    const nodes = state.nodes.map((node) => {
      const update = updatesById.get(node.id);
      const currentMedia = node.data.media;
      if (!update || !currentMedia || currentMedia.id !== update.mediaId) return node;
      if (currentMedia.width === update.width && currentMedia.height === update.height) return node;
      const media = { ...currentMedia, width: update.width, height: update.height };
      const next = resizeNodeForMedia(
        {
          ...node,
          data: { ...node.data, media, updatedAt },
        },
        media,
        inferNodeScale(node),
      );
      sourcesById.set(node.id, next);
      return next;
    });
    if (!sourcesById.size) return;

    const history = projectMediaHistoryBatch(state, sourcesById);
    set({ nodes, ...history, saveState: "saving" });
  },
  applyGenerationUpdate: (id, patch, options = {}) => {
    const state = get();
    const origins = findGenerationNodeOrigins(state, id);
    const { visibleOrigin, pastOrigin, futureOrigin } = origins;
    const origin = visibleOrigin ?? pastOrigin ?? futureOrigin;
    if (!origin) return;
    if (
      options.expectedJobId !== undefined &&
      origin.data.generation.jobId !== options.expectedJobId
    )
      return;
    const includeInCurrent =
      visibleOrigin !== null || (pastOrigin === null && futureOrigin !== null);
    const resolvedPatch = typeof patch === "function" ? patch(origin) : patch;
    const data = { ...origin.data, ...resolvedPatch, updatedAt: Date.now() };
    let nextOrigin = { ...origin, data };
    if (options.result === "media" && data.media) {
      nextOrigin = resizeNodeForMedia(nextOrigin, data.media, inferNodeScale(origin));
    }
    const anchorId = options.anchorId ?? id;
    const createdByJob = anchorId !== id;
    const createdEdges = createdByJob
      ? state.edges.filter(
          (edge) =>
            (edge.source === anchorId && edge.target === id) ||
            (edge.source === id && edge.target === anchorId),
        )
      : [];
    const volatileProgress =
      !options.result &&
      origin.data.status === "running" &&
      data.status === "running" &&
      origin.data.generation.jobId === data.generation.jobId &&
      origin.data.generation.jobStatus === data.generation.jobStatus;
    if (volatileProgress && !includeInCurrent) return;
    const history = volatileProgress
      ? null
      : projectGenerationHistory(
          state,
          anchorId,
          [{ node: nextOrigin, result: options.result ?? "none", createdByJob }],
          createdEdges,
          origins,
          includeInCurrent,
        );
    set({
      nodes: visibleOrigin
        ? state.nodes.map((node) => (node.id === id ? nextOrigin : node))
        : includeInCurrent
          ? [...state.nodes, nextOrigin]
          : state.nodes,
      ...(history ?? {}),
      saveState: "saving",
    });
  },
  applyGenerationJob: (job) => {
    const state = get();
    const origins = findGenerationNodeOrigins(state, job.nodeId);
    const { visibleOrigin, pastOrigin, futureOrigin } = origins;
    const origin = visibleOrigin ?? pastOrigin ?? futureOrigin;
    if (!origin) return;
    // Undo can race the first accepted server snapshot. Restore that paid node
    // from future history, while keeping an explicitly deleted node hidden.
    const includeInCurrent =
      visibleOrigin !== null || (pastOrigin === null && futureOrigin !== null);
    const previous = origin.data.generation;
    const sameJob = previous.jobId === job.id;
    const staleJob =
      !sameJob &&
      previous.jobCreatedAt !== null &&
      compareGenerationOrder(previous.jobCreatedAt, previous.jobId ?? "", job.createdAt, job.id) >
        0;
    const incomingError = job.error?.message ?? null;
    // A locally optimistic snapshot can carry the same version as the first
    // server snapshot. Do not discard a newly resolved status/error in that
    // case; repeated identical deliveries remain idempotent.
    if (
      sameJob &&
      previous.jobVersion !== null &&
      previous.jobVersion >= job.version &&
      previous.jobStatus === job.status &&
      previous.error === incomingError
    )
      return;
    // A late update from an older request must not replace the newer task's
    // primary result. Completed artifacts are handled below and appended.
    if (staleJob && job.status !== "completed") return;

    const terminal = job.status === "completed" || job.status === "failed";
    const awaitingSubmissionConfirmation = job.status === "submission_unknown";
    const generation = {
      ...previous,
      modelId: job.modelId,
      jobId: job.id,
      jobVersion: job.version,
      jobCreatedAt: job.createdAt,
      jobStatus: job.status,
      error: incomingError ?? (awaitingSubmissionConfirmation ? "任务提交结果待确认" : null),
    };
    // Keep read-only recovery active, but do not present an unconfirmed POST
    // as work that is still executing upstream.
    const status =
      job.status === "completed"
        ? ("success" as const)
        : job.status === "failed" || awaitingSubmissionConfirmation
          ? ("error" as const)
          : ("running" as const);
    const baseData: CanvasNodeData = {
      ...origin.data,
      status,
      progress: terminal || awaitingSubmissionConfirmation ? null : job.progress,
      generation,
      updatedAt: Date.now(),
    };

    if (job.status !== "completed") {
      const nextOrigin = { ...origin, data: baseData };
      const volatileProgress = sameJob && !awaitingSubmissionConfirmation;
      if (volatileProgress && !includeInCurrent) return;
      const history = volatileProgress
        ? null
        : projectGenerationHistory(
            state,
            job.nodeId,
            [{ node: nextOrigin, result: "none", createdByJob: false }],
            [],
            origins,
            includeInCurrent,
          );
      set({
        nodes: visibleOrigin
          ? state.nodes.map((node) => (node.id === job.nodeId ? nextOrigin : node))
          : includeInCurrent
            ? [...state.nodes, nextOrigin]
            : state.nodes,
        ...(history ?? {}),
        saveState: "saving",
      });
      return;
    }

    const originNodeScale = inferNodeScale(origin);
    const [primary, ...additional] = job.artifacts;
    const currentResult = !staleJob;
    const hiddenSnapshot = visibleOrigin ? null : (origins.pastSnapshot ?? origins.futureSnapshot);
    let nodes = visibleOrigin
      ? [...state.nodes]
      : includeInCurrent
        ? [...state.nodes, structuredClone(origin)]
        : structuredClone(hiddenSnapshot?.nodes ?? [origin]);
    let edges =
      visibleOrigin || includeInCurrent
        ? [...state.edges]
        : structuredClone(hiddenSnapshot?.edges ?? state.edges);
    let currentOrigin = nodes.find((node) => node.id === job.nodeId) ?? origin;
    const createdNodes: WeftcanvasNode[] = [];
    const projections: GenerationNodeProjection[] = [];

    if (currentResult && primary && !artifactAlreadyPresent(nodes, job, primary)) {
      const completedData = applyArtifact(
        {
          ...baseData,
          generation: generationWithArtifact(generation, primary.id),
        },
        primary,
      );
      currentOrigin = completedData.media
        ? resizeNodeForMedia(
            { ...currentOrigin, data: completedData },
            completedData.media,
            originNodeScale,
          )
        : { ...currentOrigin, data: completedData };
      nodes = nodes.map((node) => (node.id === job.nodeId ? currentOrigin : node));
    } else if (currentResult) {
      // The artifact was already applied by an earlier event. Still advance
      // the originating node's job/status metadata without duplicating media.
      const completedData = { ...baseData, status: "success" as const, progress: null };
      currentOrigin = { ...currentOrigin, data: completedData };
      nodes = nodes.map((node) => (node.id === job.nodeId ? currentOrigin : node));
    }
    if (currentResult) {
      projections.push({
        node: currentOrigin,
        result: projectionResult(primary),
        createdByJob: false,
      });
    }

    const artifactsToAppend = currentResult ? additional : job.artifacts;
    const defaultNodeAspectRatio = currentDefaultNodeAspectRatio();
    for (const artifact of artifactsToAppend) {
      if (artifactAlreadyPresent(nodes, job, artifact)) continue;
      const kind = artifactKind(artifact);
      const node = createCanvasNode(
        kind,
        { x: 0, y: 0 },
        {},
        defaultNodeAspectRatio,
        originNodeScale,
      );
      node.data = applyArtifact(
        {
          ...node.data,
          body: artifact.kind === "text" ? "" : origin.data.body,
          status: "success",
          generation: generationWithArtifact(generation, artifact.id),
        },
        artifact,
      );
      if (node.data.media) resizeNodeForMedia(node, node.data.media, originNodeScale);
      node.selected = false;
      createdNodes.push(node);
      nodes.push(node);
      projections.push({ node, result: projectionResult(artifact), createdByJob: true });
    }
    const columnPositions = findConnectedNodeColumnPositions(currentOrigin, createdNodes, nodes);
    createdNodes.forEach((node, index) => {
      node.position =
        columnPositions[index] ?? findConnectedNodePosition(currentOrigin, node, "right", nodes);
    });
    if (!currentResult && !createdNodes.length) return;
    const createdEdges = createdNodes.map((node) => createCanvasEdge(origin.id, node.id));
    edges = [...edges, ...createdEdges];
    const history = projectGenerationHistory(
      state,
      job.nodeId,
      projections,
      createdEdges,
      origins,
      includeInCurrent,
    );
    set({
      nodes: includeInCurrent ? nodes : state.nodes,
      edges: includeInCurrent ? edges : state.edges,
      ...history,
      saveState: "saving",
    });
  },
  deleteNode: (id) => {
    const state = get();
    const removed = state.nodes.find((node) => node.id === id);
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const retainedNodes = state.nodes.filter((node) => node.id !== id);
    const edges = state.edges.filter((edge) => edge.source !== id && edge.target !== id);
    const nodes = pruneDisconnectedPromptReferences(
      syncAllConfigurationTargets(retainedNodes, edges),
      edges,
      state.nodes,
    );
    releaseUnreferencedServerMedia(removed, nodes);
    set({
      nodes,
      edges,
      groups: normalizeGroups(state.groups, nodes),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  disconnectNodes: (sourceId, targetId) => {
    const state = get();
    const edges = state.edges.filter(
      (edge) => edge.source !== sourceId || edge.target !== targetId,
    );
    if (edges.length === state.edges.length) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const nodes = pruneDisconnectedPromptReferences(
      syncAllConfigurationTargets(state.nodes, edges),
      edges,
      state.nodes,
    );
    set({
      nodes,
      edges,
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  deleteSelection: () => {
    const state = get();
    const hasSelectedEdges = state.edges.some((edge) => edge.selected);
    const selectedIds = new Set(
      hasSelectedEdges ? [] : state.nodes.filter((node) => node.selected).map((node) => node.id),
    );
    if (!selectedIds.size && !hasSelectedEdges) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const retainedNodes = state.nodes.filter((node) => !selectedIds.has(node.id));
    const edges = state.edges.filter(
      (edge) => !edge.selected && !selectedIds.has(edge.source) && !selectedIds.has(edge.target),
    );
    const nodes = pruneDisconnectedPromptReferences(
      syncAllConfigurationTargets(retainedNodes, edges),
      edges,
      state.nodes,
    );
    releaseUnreferencedServerMediaMany(
      state.nodes.filter((node) => selectedIds.has(node.id)),
      nodes,
    );
    set({
      nodes,
      edges,
      groups: normalizeGroups(state.groups, nodes),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  duplicateSelection: () => {
    const state = get();
    const selected = state.nodes.filter((node) => node.selected);
    if (!selected.length) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const ids = new Set(selected.map((node) => node.id));
    const mapping = new Map(selected.map((node) => [node.id, createId("node")]));
    const copies = selected.map((node) => {
      const copy = cloneNodeForReuse(node, (id) => mapping.get(id) ?? id);
      return {
        ...copy,
        id: mapping.get(node.id)!,
        position: { x: node.position.x + 36, y: node.position.y + 36 },
        selected: true,
      };
    });
    const edgeCopies = state.edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({
        ...structuredClone(edge),
        id: createId("edge"),
        source: mapping.get(edge.source)!,
        target: mapping.get(edge.target)!,
        selected: false,
      }));
    const now = Date.now();
    const groupCopies: CanvasGroup[] = [];
    state.groups
      .filter((group) => group.nodeIds.every((id) => ids.has(id)))
      .forEach((group) => {
        groupCopies.push({
          ...structuredClone(group),
          id: createId("group"),
          name: nextGroupName([...state.groups, ...groupCopies]),
          nodeIds: group.nodeIds.map((id) => mapping.get(id)!),
          createdAt: now,
          updatedAt: now,
        });
      });
    set({
      nodes: [...state.nodes.map((node) => ({ ...node, selected: false })), ...copies],
      edges: [...state.edges.map((edge) => ({ ...edge, selected: false })), ...edgeCopies],
      groups: [...state.groups, ...groupCopies],
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  copySelection: () => {
    const state = get();
    const nodes = state.nodes.filter((node) => node.selected);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = state.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    const groups = state.groups.filter((group) => group.nodeIds.every((id) => ids.has(id)));
    if (nodes.length) {
      const copies = nodes.map((node) => cloneNodeForReuse(node));
      set({ clipboard: cloneGraph(copies, edges, groups) });
    }
  },
  pasteSelection: (position, snapshot) => {
    const state = get();
    const source = snapshot ?? state.clipboard;
    if (!source?.nodes.length) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const mapping = new Map(source.nodes.map((node) => [node.id, createId("node")]));
    const existingIds = new Set(state.nodes.map((node) => node.id));
    const offset = position
      ? pasteOffsetForPosition(source.nodes, position, state.viewport)
      : { x: 44, y: 44 };
    const nodes = source.nodes.map((node) => {
      const copy = cloneNodeForReuse(node, (id) => {
        const mapped = mapping.get(id);
        if (mapped) return mapped;
        return existingIds.has(id) ? id : undefined;
      });
      return {
        ...copy,
        id: mapping.get(node.id)!,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
        selected: true,
        dragging: false,
      };
    });
    const edges = source.edges.flatMap((edge) => {
      const sourceId = mapping.get(edge.source);
      const targetId = mapping.get(edge.target);
      if (!sourceId || !targetId) return [];
      return [
        {
          ...structuredClone(edge),
          id: createId("edge"),
          source: sourceId,
          target: targetId,
          selected: false,
        },
      ];
    });
    const now = Date.now();
    const groups: CanvasGroup[] = [];
    source.groups.forEach((group) => {
      const nodeIds = group.nodeIds.flatMap((id) => mapping.get(id) ?? []);
      if (nodeIds.length < 2) return;
      groups.push({
        ...structuredClone(group),
        id: createId("group"),
        name: nextGroupName([...state.groups, ...groups]),
        nodeIds,
        createdAt: now,
        updatedAt: now,
      });
    });
    set({
      nodes: [...state.nodes.map((node) => ({ ...node, selected: false })), ...nodes],
      edges: [...state.edges.map((edge) => ({ ...edge, selected: false })), ...edges],
      groups: [...state.groups, ...groups],
      clipboard: cloneGraph(nodes, edges, groups),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  selectAll: () =>
    set((state) => ({
      nodes: state.nodes.map((node) => ({ ...node, selected: true })),
      edges: state.edges.map((edge) => ({ ...edge, selected: false })),
      activeToolbarNodeId: null,
    })),
  selectEdge: (id) =>
    set((state) => ({
      nodes: state.nodes.map((node) => ({ ...node, selected: false })),
      edges: state.edges.map((edge) => ({ ...edge, selected: edge.id === id })),
      activeToolbarNodeId: null,
    })),
  clearSelection: () =>
    set((state) => ({
      nodes: state.nodes.map((node) => ({ ...node, selected: false })),
      edges: state.edges.map((edge) => ({ ...edge, selected: false })),
    })),
  groupSelection: () => {
    const state = get();
    const occupied = new Set(state.groups.flatMap((group) => group.nodeIds));
    const selected = state.nodes.filter((node) => node.selected);
    if (selected.length < 2 || selected.some((node) => occupied.has(node.id))) return null;
    const nodeIds = selected.map((node) => node.id);
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    const now = Date.now();
    const group: CanvasGroup = {
      id: createId("group"),
      name: nextGroupName(state.groups),
      color: pickGroupColor(state.groups),
      nodeIds,
      frame: null,
      createdAt: now,
      updatedAt: now,
    };
    set({
      groups: [...state.groups, group],
      activeToolbarNodeId: null,
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
    return group.id;
  },
  ungroupSelection: () => {
    const state = get();
    const selectedIds = new Set(state.nodes.filter((node) => node.selected).map((node) => node.id));
    const groupIds = new Set(
      state.groups
        .filter((group) => group.nodeIds.some((id) => selectedIds.has(id)))
        .map((group) => group.id),
    );
    if (!groupIds.size) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    set({
      groups: state.groups.filter((group) => !groupIds.has(group.id)),
      activeToolbarNodeId: null,
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  selectGroup: (id) =>
    set((state) => {
      const group = state.groups.find((item) => item.id === id);
      if (!group) return state;
      const ids = new Set(group.nodeIds);
      return {
        nodes: state.nodes.map((node) => ({ ...node, selected: ids.has(node.id) })),
        edges: state.edges.map((edge) => ({ ...edge, selected: false })),
        activeToolbarNodeId: null,
      };
    }),
  moveGroupBy: (id, delta) =>
    set((state) => {
      if (!delta.x && !delta.y) return state;
      const group = state.groups.find((item) => item.id === id);
      if (!group) return state;
      const ids = new Set(group.nodeIds);
      return {
        nodes: state.nodes.map((node) =>
          ids.has(node.id)
            ? { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } }
            : node,
        ),
        saveState: "saving",
      };
    }),
  setNodeGroupMembership: (nodeId, groupId) =>
    set((state) => {
      const currentGroupId =
        state.groups.find((group) => group.nodeIds.includes(nodeId))?.id ?? null;
      const targetExists = groupId === null || state.groups.some((group) => group.id === groupId);
      if (!targetExists || currentGroupId === groupId) return state;

      const now = Date.now();
      const groups = state.groups.flatMap((group) => {
        const withoutNode = group.nodeIds.filter((id) => id !== nodeId);
        const nodeIds = group.id === groupId ? [...withoutNode, nodeId] : withoutNode;
        if (nodeIds.length < 2) return [];
        if (
          nodeIds.length === group.nodeIds.length &&
          nodeIds.every((id, index) => id === group.nodeIds[index])
        )
          return [group];
        return [{ ...group, nodeIds, updatedAt: now }];
      });

      return { groups, activeToolbarNodeId: null, saveState: "saving" };
    }),
  scaleGroupBy: (id, factor, anchor) =>
    set((state) => {
      if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 0.0001) return state;
      const group = state.groups.find((item) => item.id === id);
      if (!group) return state;
      const ids = new Set(group.nodeIds);
      return {
        nodes: state.nodes.map((node) => {
          if (!ids.has(node.id)) return node;
          const dimensions = {
            width:
              node.width ?? node.measured?.width ?? nodeDefaultDimensions(node.data.kind).width,
            height:
              node.height ?? node.measured?.height ?? nodeDefaultDimensions(node.data.kind).height,
          };
          return {
            ...node,
            width: dimensions.width * factor,
            height: dimensions.height * factor,
            position: {
              x: anchor.x + (node.position.x - anchor.x) * factor,
              y: anchor.y + (node.position.y - anchor.y) * factor,
            },
          };
        }),
        saveState: "saving",
      };
    }),
  arrangeGroup: (id) => {
    const state = get();
    const group = state.groups.find((item) => item.id === id);
    if (!group) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    set({
      nodes: arrangeGroupNodes(state.nodes, group),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  renameGroup: (id, name) => {
    const trimmed = name.trim().slice(0, 32);
    if (!trimmed) return;
    const state = get();
    const group = state.groups.find((item) => item.id === id);
    if (!group || group.name === trimmed) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    set({
      groups: state.groups.map((item) =>
        item.id === id ? { ...item, name: trimmed, updatedAt: Date.now() } : item,
      ),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  setGroupColor: (id, color) => {
    const state = get();
    const group = state.groups.find((item) => item.id === id);
    if (!group || group.color === color) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    set({
      groups: state.groups.map((item) =>
        item.id === id ? { ...item, color, updatedAt: Date.now() } : item,
      ),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  ungroup: (id) => {
    const state = get();
    if (!state.groups.some((group) => group.id === id)) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    set({
      groups: state.groups.filter((group) => group.id !== id),
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  clearCanvas: () => {
    const state = get();
    if (!state.nodes.length && !state.edges.length && !state.groups.length) return;
    const before = cloneGraph(state.nodes, state.edges, state.groups);
    set({
      nodes: [],
      edges: [],
      groups: [],
      activeToolbarNodeId: null,
      past: pushPast(state, before),
      future: [],
      saveState: "saving",
    });
  },
  beginTransaction: () => {
    const state = get();
    // Canvas updates are immutable, so keeping the pre-gesture references is
    // enough until a real graph change is committed. Cloning here makes drag
    // start proportional to the whole canvas instead of the user's gesture.
    if (!state.transactionBase)
      set({ transactionBase: { nodes: state.nodes, edges: state.edges, groups: state.groups } });
  },
  commitTransaction: () => {
    flushPendingNodePositionChanges();
    const state = get();
    const base = state.transactionBase;
    if (!base) return;
    // 画布更新是不可变的：引用相同即内容相同。纯平移/缩放或拖拽后位置未变的手势
    // 可以直接判定为无变化，省掉一次全图逐字段深比较（原实现每次提交都要遍历
    // 所有节点与连线，节点变多后每次提交都会掉帧）。
    const unchanged =
      base.nodes === state.nodes && base.edges === state.edges && base.groups === state.groups;
    const changed =
      !unchanged &&
      !sameGraphContent(base, {
        nodes: state.nodes,
        edges: state.edges,
        groups: state.groups,
      });
    set({
      transactionBase: null,
      ...(changed
        ? { past: pushPast(state, cloneGraph(base.nodes, base.edges, base.groups)), future: [] }
        : {}),
    });
  },
  undo: () => {
    flushPendingNodePositionChanges();
    const state = get();
    const previous = state.past.at(-1);
    if (!previous) return;
    cancelPendingDeletionsForNodes(previous.nodes);
    set({
      nodes: structuredClone(previous.nodes),
      edges: structuredClone(previous.edges),
      groups: structuredClone(previous.groups),
      past: state.past.slice(0, -1),
      future: [cloneGraph(state.nodes, state.edges, state.groups), ...state.future],
      transactionBase: null,
      saveState: "saving",
    });
  },
  redo: () => {
    flushPendingNodePositionChanges();
    const state = get();
    const next = state.future[0];
    if (!next) return;
    cancelPendingDeletionsForNodes(next.nodes);
    set({
      nodes: structuredClone(next.nodes),
      edges: structuredClone(next.edges),
      groups: structuredClone(next.groups),
      past: [...state.past, cloneGraph(state.nodes, state.edges, state.groups)].slice(
        -HISTORY_LIMIT,
      ),
      future: state.future.slice(1),
      transactionBase: null,
      saveState: "saving",
    });
  },
  replaceProject: (project) => {
    discardPendingNodePositionChanges();
    const projectNodes = (project.nodes as WeftcanvasNode[]).map(restoreNodeDimensions);
    const edges = project.edges as WeftcanvasEdge[];
    set({
      projectId: project.id,
      projectName: project.name,
      createdAt: project.createdAt,
      nodes: syncAllConfigurationTargets(projectNodes, edges),
      edges,
      groups: project.groups,
      viewport: project.viewport,
      past: [],
      future: [],
      transactionBase: null,
      saveState: "saving",
    });
  },
  resetProject: (name) => {
    discardPendingNodePositionChanges();
    set({
      projectId: createId("project"),
      projectName: name?.trim() || "纬线 1",
      createdAt: Date.now(),
      nodes: [],
      edges: [],
      groups: [],
      viewport: createEmptyProjectViewport(),
      past: [],
      future: [],
      transactionBase: null,
      saveState: "saving",
    });
  },
  setSaveState: (saveState, lastSavedAt) =>
    set((state) => ({
      saveState,
      lastSavedAt: lastSavedAt === undefined ? state.lastSavedAt : lastSavedAt,
    })),
  setActiveToolbarNodeId: (activeToolbarNodeId) => set({ activeToolbarNodeId }),
}));

function compareGenerationOrder(
  leftCreatedAt: string,
  leftId: string,
  rightCreatedAt: string,
  rightId: string,
) {
  const leftTime = Date.parse(leftCreatedAt);
  const rightTime = Date.parse(rightCreatedAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return leftId.localeCompare(rightId);
}

function artifactAlreadyPresent(
  nodes: WeftcanvasNode[],
  job: PublicGenerationJob,
  artifact: GenerationArtifact,
) {
  return nodes.some((node) => {
    const generation = node.data.generation;
    if (generation.artifactId === artifact.id) return true;
    if (artifact.kind !== "text") {
      return (
        node.data.media?.serverId === artifact.mediaId || node.data.media?.id === artifact.mediaId
      );
    }
    return generation.jobId === job.id && node.data.body === artifact.text;
  });
}

function generationWithArtifact(generation: CanvasNodeData["generation"], artifactId: string) {
  return { ...generation, artifactId };
}

function artifactKind(artifact: GenerationArtifact): CanvasNodeKind {
  if (artifact.kind === "text") return "text";
  return artifact.kind;
}

function projectionResult(
  artifact: GenerationArtifact | null | undefined,
): GenerationNodeProjection["result"] {
  if (!artifact) return "none";
  return artifact.kind === "text" ? "text" : "media";
}

function resizeNodeForMedia(node: WeftcanvasNode, media: CanvasMedia, scale = 1): WeftcanvasNode {
  if (
    (node.data.kind === "image" || node.data.kind === "video") &&
    (!media.width || !media.height) &&
    hasUsableDimensions(node)
  )
    return node;
  const dimensions = mediaNodeDimensions(node.data.kind, media, scale);
  node.width = dimensions.width;
  node.height = dimensions.height;
  return node;
}

function aspectRatiosEqual(left: number | null, right: number | null) {
  return left !== null && right !== null && Math.abs(left / right - 1) < 0.0001;
}

function mediaMetadataEqual(left: CanvasMedia | null, right: CanvasMedia) {
  return (
    left?.id === right.id &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.source === right.source &&
    left.serverId === right.serverId &&
    left.width === right.width &&
    left.height === right.height &&
    left.durationMs === right.durationMs
  );
}

function currentDefaultNodeAspectRatio() {
  return useUiPreferencesStore.getState().defaultNodeAspectRatio;
}

function restoreNodeDimensions(node: WeftcanvasNode) {
  const media = node.data.media;
  const configuredAspectRatio = generationParametersAspectRatio(node.data.generation.parameters);
  if (configuredAspectRatio !== null) {
    // 面板自动写入的模型默认画幅参数不代表创建者的选择：空节点保持创建时
    // 由默认画幅决定的几何，只有显式配置过画幅或媒体已落地才跟随参数比例。
    if (!media && !node.data.generation.aspectExplicit) return node;
    const restored =
      media && !hasUsableDimensions(node) ? resizeNodeForMedia({ ...node }, media) : node;
    return resizeMediaNodeToAspectRatio(restored, configuredAspectRatio);
  }
  if (!media) return node;
  if (!hasUsableDimensions(node)) return resizeNodeForMedia({ ...node }, media);
  if (nodeMediaRatioMatches(node, media)) return node;
  return resizeNodeForMedia({ ...node }, media, inferLegacyNodeScale(node));
}

function hasUsableDimensions(node: WeftcanvasNode) {
  return (
    Number.isFinite(node.width) &&
    (node.width ?? 0) > 0 &&
    Number.isFinite(node.height) &&
    (node.height ?? 0) > 0
  );
}

function nodeMediaRatioMatches(node: WeftcanvasNode, media: CanvasMedia) {
  if ((node.data.kind !== "image" && node.data.kind !== "video") || !media.width || !media.height)
    return true;
  const nodeRatio = (node.width ?? 0) / (node.height ?? 0);
  const fitted = mediaNodeDimensions(node.data.kind, media);
  const fittedRatio = fitted.width / fitted.height;
  if (
    !Number.isFinite(nodeRatio) ||
    !Number.isFinite(fittedRatio) ||
    nodeRatio <= 0 ||
    fittedRatio <= 0
  )
    return false;
  return Math.abs(nodeRatio / fittedRatio - 1) <= 0.08;
}

function inferNodeScale(node: WeftcanvasNode) {
  if (!hasUsableDimensions(node)) return 1;
  const media = node.data.media;
  const base = media
    ? mediaNodeDimensions(node.data.kind, media)
    : node.data.kind === "image" || node.data.kind === "video"
      ? { width: 340, height: 340 }
      : nodeDefaultDimensions(node.data.kind);
  const nodeLongEdge = Math.max(node.width ?? base.width, node.height ?? base.height);
  const baseLongEdge = Math.max(base.width, base.height);
  const scale = nodeLongEdge / baseLongEdge;
  return Number.isFinite(scale) ? Math.min(12, Math.max(0.35, scale)) : 1;
}

function inferLegacyNodeScale(node: WeftcanvasNode) {
  if (!hasUsableDimensions(node)) return 1;
  // A legacy horizontal box does not describe the scale of newly discovered
  // portrait media. Compare it with the old kind default instead of the new
  // media fit, otherwise a standard 340px node incorrectly shrinks to 85%.
  const base = mediaNodeDimensions(node.data.kind, null);
  const nodeLongEdge = Math.max(node.width ?? base.width, node.height ?? base.height);
  const baseLongEdge = Math.max(base.width, base.height);
  const scale = nodeLongEdge / baseLongEdge;
  return Number.isFinite(scale) ? Math.min(12, Math.max(0.35, scale)) : 1;
}

function applyArtifact(data: CanvasNodeData, artifact: GenerationArtifact): CanvasNodeData {
  if (artifact.kind === "text")
    return { ...data, body: artifact.text, media: null, status: "success", progress: null };
  const media: CanvasMedia = {
    id: artifact.mediaId,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    source: "server",
    serverId: artifact.mediaId,
    width: artifact.width ?? null,
    height: artifact.height ?? null,
    durationMs: artifact.duration ? Math.max(1, Math.round(artifact.duration * 1_000)) : null,
  };
  return { ...data, media, status: "success", progress: null };
}

export function selectProject(state: CanvasState): CanvasProject {
  const now = Date.now();
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id: state.projectId,
    name: state.projectName,
    nodes: state.nodes.map((node) => ({
      id: node.id,
      type: "weftcanvas",
      position: node.position,
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      data: node.data,
    })),
    edges: state.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    })),
    groups: state.groups,
    viewport: state.viewport,
    createdAt: state.createdAt,
    updatedAt: now,
  };
}
