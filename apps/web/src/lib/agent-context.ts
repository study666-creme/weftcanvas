import {
  AGENT_CANVAS_CONTEXT_SCHEMA_VERSION,
  DEFAULT_AGENT_CREATIVE_GUIDANCE,
  agentCanvasContextSchema,
  type AgentCanvasContext,
  type AgentCreativeGuidance,
  type AgentDirectorStageSummary,
  type CanvasGroup,
  type CanvasViewport,
  normalizeDirectorStagePacket,
} from "@weftcanvas/contracts";

import type { WeftcanvasEdge, WeftcanvasNode } from "../types";
import { normalizeAgentCreativeGuidance } from "./agent-creative-guidance";

const MAX_NODES = 120;
const MAX_EDGES = 240;
const MAX_GROUPS = 60;
const MAX_NODE_TEXT = 4_000;

type CanvasContextSource = {
  projectId: string;
  projectName: string;
  nodes: WeftcanvasNode[];
  edges: WeftcanvasEdge[];
  groups: CanvasGroup[];
  viewport?: CanvasViewport;
  directorStage?: AgentDirectorStageSummary;
  creativeGuidance?: AgentCreativeGuidance;
};

export function createAgentCanvasContext(source: CanvasContextSource): AgentCanvasContext {
  const orderedNodes = [...source.nodes].sort(
    (left, right) => Number(Boolean(right.selected)) - Number(Boolean(left.selected)),
  );
  const includedNodes = orderedNodes.slice(0, MAX_NODES);
  const includedIds = new Set(includedNodes.map((node) => node.id));
  const eligibleEdges = source.edges.filter(
    (edge) => includedIds.has(edge.source) && includedIds.has(edge.target),
  );
  const includedEdges = eligibleEdges.slice(0, MAX_EDGES);
  const groups = source.groups.slice(0, MAX_GROUPS).flatMap((group) => {
    const nodeIds = group.nodeIds.filter((id) => includedIds.has(id)).slice(0, MAX_NODES);
    return nodeIds.length >= 2 ? [{ name: group.name, nodeIds }] : [];
  });

  const contextRevision = createAgentContextRevision(source);
  return agentCanvasContextSchema.parse({
    schemaVersion: AGENT_CANVAS_CONTEXT_SCHEMA_VERSION,
    contextRevision,
    projectId: source.projectId,
    projectName: source.projectName.trim().slice(0, 128) || "未命名画布",
    nodeCount: source.nodes.length,
    edgeCount: source.edges.length,
    groupCount: source.groups.length,
    omittedNodeCount: Math.max(0, source.nodes.length - includedNodes.length),
    omittedEdgeCount: Math.max(0, source.edges.length - includedEdges.length),
    nodes: includedNodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      text: node.data.body.slice(0, MAX_NODE_TEXT),
      selected: Boolean(node.selected),
      media:
        node.data.media && ["image", "video", "audio"].includes(node.data.kind)
          ? {
              kind: node.data.kind as "image" | "video" | "audio",
              mimeType: node.data.media.mimeType,
              width: node.data.media.width,
              height: node.data.media.height,
              durationMs: node.data.media.durationMs,
            }
          : null,
    })),
    edges: includedEdges.map((edge) => ({ source: edge.source, target: edge.target })),
    groups,
    directorStage: source.directorStage ?? null,
    creativeGuidance: normalizeAgentCreativeGuidance(
      source.creativeGuidance ?? defaultCreativeGuidance(),
    ),
  });
}

export function createAgentContextRevision(source: CanvasContextSource) {
  const canonical = {
    projectId: source.projectId,
    projectName: source.projectName,
    viewport: source.viewport ?? null,
    nodes: [...source.nodes]
      .sort((left, right) => compareText(left.id, right.id))
      .map((node) => ({
        id: node.id,
        position: node.position,
        width: node.width ?? null,
        height: node.height ?? null,
        selected: Boolean(node.selected),
        data: {
          kind: node.data.kind,
          body: node.data.body,
          accent: node.data.accent,
          status: node.data.status,
          progress: node.data.progress,
          media: node.data.media,
          directorCapture: node.data.directorCapture,
          config: node.data.config,
          generation: node.data.generation,
        },
      })),
    edges: [...source.edges]
      .sort((left, right) => compareText(left.id, right.id))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        selected: Boolean(edge.selected),
      })),
    groups: [...source.groups]
      .sort((left, right) => compareText(left.id, right.id))
      .map((group) => ({
        id: group.id,
        name: group.name,
        color: group.color,
        nodeIds: [...group.nodeIds].sort(compareText),
      })),
    directorStage: source.directorStage ?? null,
    creativeGuidance: normalizeAgentCreativeGuidance(
      source.creativeGuidance ?? defaultCreativeGuidance(),
    ),
  };
  const serialized = stableStringify(canonical);
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    primary = Math.imul(primary ^ code, 0x01000193) >>> 0;
    secondary = Math.imul(secondary ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `ctx-v1-${primary.toString(16).padStart(8, "0")}${secondary.toString(16).padStart(8, "0")}`;
}

export function readAgentDirectorStageContext(
  projectId: string,
  open: boolean,
): AgentDirectorStageSummary {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`weftcanvas:director-stage:v1:${projectId}`);
    if (!raw) return null;
    const packet = normalizeDirectorStagePacket((JSON.parse(raw) as { packet?: unknown }).packet);
    return {
      open,
      shots: packet.slots.slice(0, 24).map((slot) => ({
        shotId: slot.shot_id,
        title: slot.dramatic_function,
        entities: [
          ...slot.subjects.map((entity) => ({
            id: entity.id,
            kind: "actor" as const,
            label: entity.label,
            x: entity.x,
            y: entity.y,
            z: entity.z,
            rotationY: entity.rotation_y,
            scale: entity.scale,
          })),
          ...slot.props.map((entity) => ({
            id: entity.id,
            kind: "prop" as const,
            label: entity.label,
            x: entity.x,
            y: entity.y,
            z: entity.z,
            rotationY: entity.rotation_y,
            scale: entity.scale,
          })),
        ].slice(0, 32),
      })),
    };
  } catch {
    return null;
  }
}

function defaultCreativeGuidance(): AgentCreativeGuidance {
  return {
    mode: DEFAULT_AGENT_CREATIVE_GUIDANCE.mode,
    baseline: { ...DEFAULT_AGENT_CREATIVE_GUIDANCE.baseline },
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function compareText(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}
