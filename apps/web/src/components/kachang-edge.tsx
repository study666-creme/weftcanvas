import {
  BaseEdge,
  getBezierPath,
  type ConnectionLineComponentProps,
  type EdgeProps,
  type Position,
} from "@xyflow/react";
import { memo, useContext } from "react";

import { useCanvasStore } from "../state/canvas-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import type { KachangEdge } from "../types";
import { CanvasEdgeRuntimeContext } from "./canvas-node-runtime-context";

type EdgePathInput = {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
};

type EdgePathGeometry = {
  path: string;
  focusX: number;
  focusY: number;
};

export const KachangEdgeComponent = memo(function KachangEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  interactionWidth,
}: EdgeProps<KachangEdge>) {
  const edgePathStyle = useUiPreferencesStore((state) => state.edgePathStyle);
  const edgeFlowStyle = useUiPreferencesStore((state) => state.edgeFlowStyle);
  const { ambientEnergyEdgeIds, endpointEnergyEdgeIds } = useContext(CanvasEdgeRuntimeContext);
  const endpointSelected = endpointEnergyEdgeIds.has(id);
  const energyActive = Boolean(selected || endpointSelected);
  const energyAmbient = !energyActive && ambientEnergyEdgeIds.has(id);
  const energyVisible = energyActive || energyAmbient;
  const pathInput = {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  };
  const { path, focusX, focusY } = getKachangEdgePath(pathInput, edgePathStyle);
  const reversePath = energyVisible && edgeFlowStyle === "stardust"
    ? getKachangEdgePath(reversePathInput(pathInput), edgePathStyle).path
    : path;

  return (
    <g
      className={`kc-edge-renderer ${edgePathStyle === "gravity" ? "is-soft-curve" : "is-taut"}`}
      data-edge-path-style={edgePathStyle}
      data-edge-flow-style={edgeFlowStyle}
      data-edge-energy-active={energyActive ? "true" : "false"}
      data-edge-energy-ambient={energyAmbient ? "true" : "false"}
      onPointerDown={(event) => {
        event.stopPropagation();
        useCanvasStore.getState().selectEdge(id);
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <BaseEdge id={id} path={path} interactionWidth={interactionWidth ?? 28} />
      {energyVisible && edgeFlowStyle === "stream" ? (
        <g className={`kc-edge-effect kc-edge-effect--stream ${energyActive ? "is-active" : "is-ambient"}`}>
          <path className="kc-edge-aura" d={path} />
          <path className="kc-edge-energy" d={path} pathLength={156} />
        </g>
      ) : null}
      {energyVisible && edgeFlowStyle === "stardust" ? (
        <StardustConvergence path={path} reversePath={reversePath} focusX={focusX} focusY={focusY} active={energyActive} />
      ) : null}
    </g>
  );
});

export const KachangConnectionLine = memo(function KachangConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionStatus,
}: ConnectionLineComponentProps) {
  const edgePathStyle = useUiPreferencesStore((state) => state.edgePathStyle);
  const edgeFlowStyle = useUiPreferencesStore((state) => state.edgeFlowStyle);
  const pathInput = {
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  };
  const { path, focusX, focusY } = getKachangEdgePath(pathInput, edgePathStyle);
  const statusClass = connectionStatus ? `is-${connectionStatus}` : "";
  const reversePath = edgeFlowStyle === "stardust"
    ? getKachangEdgePath(reversePathInput(pathInput), edgePathStyle).path
    : path;
  return (
    <g className={`kc-connection-preview ${edgePathStyle === "gravity" ? "is-soft-curve" : "is-taut"} ${statusClass}`} data-edge-path-style={edgePathStyle} data-edge-flow-style={edgeFlowStyle}>
      <path className="kc-connection-preview-base" d={path} />
      {edgeFlowStyle === "stream" ? (
        <g className="kc-edge-effect kc-edge-effect--stream">
          <path className="kc-edge-aura kc-edge-aura--preview" d={path} />
          <path className="kc-edge-energy kc-edge-energy--preview" d={path} pathLength={156} />
        </g>
      ) : (
        <StardustConvergence path={path} reversePath={reversePath} focusX={focusX} focusY={focusY} preview />
      )}
    </g>
  );
});

function StardustConvergence({
  path,
  reversePath,
  focusX,
  focusY,
  preview = false,
  active = true,
}: {
  path: string;
  reversePath: string;
  focusX: number;
  focusY: number;
  preview?: boolean;
  active?: boolean;
}) {
  return (
    <g className={`kc-edge-effect kc-edge-effect--stardust ${preview ? "is-preview" : ""} ${active ? "is-active" : "is-ambient"}`}>
      <path className="kc-edge-star-field" d={path} pathLength={100} />
      <path className="kc-edge-star-inbound kc-edge-star-inbound--source" d={path} pathLength={100} />
      <path className="kc-edge-star-inbound kc-edge-star-inbound--target" d={reversePath} pathLength={100} />
      <circle className="kc-edge-star-focus-ring" cx={focusX} cy={focusY} r={6.2} />
      <circle className="kc-edge-star-focus-core" cx={focusX} cy={focusY} r={1.65} />
    </g>
  );
}

export function getKachangEdgePath(input: EdgePathInput, style: "taut" | "gravity" | "emerald"): EdgePathGeometry {
  const curvature = style === "taut" ? 0.42 : style === "gravity" ? 0.25 : 0.32;
  const [path, focusX, focusY] = getBezierPath({ ...input, curvature });
  return { path, focusX, focusY };
}

function reversePathInput(input: EdgePathInput): EdgePathInput {
  return {
    sourceX: input.targetX,
    sourceY: input.targetY,
    targetX: input.sourceX,
    targetY: input.sourceY,
    sourcePosition: input.targetPosition,
    targetPosition: input.sourcePosition,
  };
}
