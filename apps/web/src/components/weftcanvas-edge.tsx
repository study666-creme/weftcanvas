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
import { getAppearanceOption } from "../lib/appearance-registry";
import "../lib/builtin-appearance";
import type { WeftcanvasEdge } from "../types";
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

export const WeftcanvasEdgeComponent = memo(function WeftcanvasEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  interactionWidth,
}: EdgeProps<WeftcanvasEdge>) {
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
  const { path, focusX, focusY } = getWeftcanvasEdgePath(pathInput, edgePathStyle);
  const reversePath =
    energyVisible && edgeFlowStyle === "stardust"
      ? getWeftcanvasEdgePath(reversePathInput(pathInput), edgePathStyle).path
      : path;

  return (
    <g
      className={`wc-edge-renderer ${edgeGeometryFor(edgePathStyle) === "gravity" ? "is-soft-curve" : "is-taut"}`}
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
        <g
          className={`wc-edge-effect wc-edge-effect--stream ${energyActive ? "is-active" : "is-ambient"}`}
        >
          <path className="wc-edge-aura" d={path} />
          <path className="wc-edge-energy" d={path} pathLength={156} />
        </g>
      ) : null}
      {energyVisible && edgeFlowStyle === "stardust" ? (
        <StardustConvergence
          path={path}
          reversePath={reversePath}
          focusX={focusX}
          focusY={focusY}
          active={energyActive}
        />
      ) : null}
    </g>
  );
});

export const WeftcanvasConnectionLine = memo(function WeftcanvasConnectionLine({
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
  const { path, focusX, focusY } = getWeftcanvasEdgePath(pathInput, edgePathStyle);
  const statusClass = connectionStatus ? `is-${connectionStatus}` : "";
  const reversePath =
    edgeFlowStyle === "stardust"
      ? getWeftcanvasEdgePath(reversePathInput(pathInput), edgePathStyle).path
      : path;
  return (
    <g
      className={`wc-connection-preview ${edgeGeometryFor(edgePathStyle) === "gravity" ? "is-soft-curve" : "is-taut"} ${statusClass}`}
      data-edge-path-style={edgePathStyle}
      data-edge-flow-style={edgeFlowStyle}
    >
      <path className="wc-connection-preview-base" d={path} />
      {edgeFlowStyle === "stream" ? (
        <g className="wc-edge-effect wc-edge-effect--stream">
          <path className="wc-edge-aura wc-edge-aura--preview" d={path} />
          <path className="wc-edge-energy wc-edge-energy--preview" d={path} pathLength={156} />
        </g>
      ) : (
        <StardustConvergence
          path={path}
          reversePath={reversePath}
          focusX={focusX}
          focusY={focusY}
          preview
        />
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
    <g
      className={`wc-edge-effect wc-edge-effect--stardust ${preview ? "is-preview" : ""} ${active ? "is-active" : "is-ambient"}`}
    >
      <path className="wc-edge-star-field" d={path} pathLength={100} />
      <path
        className="wc-edge-star-inbound wc-edge-star-inbound--source"
        d={path}
        pathLength={100}
      />
      <path
        className="wc-edge-star-inbound wc-edge-star-inbound--target"
        d={reversePath}
        pathLength={100}
      />
      <circle className="wc-edge-star-focus-ring" cx={focusX} cy={focusY} r={6.2} />
      <circle className="wc-edge-star-focus-core" cx={focusX} cy={focusY} r={1.65} />
    </g>
  );
}

/**
 * 线形档的几何解析：注册档可声明复用哪种内置几何（琥珀包 = 张力），
 * 未注册/历史值回落张力。曲率取注册声明的 pathCurvature。
 */
function edgeGeometryFor(style: string): "taut" | "gravity" {
  return getAppearanceOption("edgePathStyle", style)?.geometry ?? "taut";
}

export function getWeftcanvasEdgePath(input: EdgePathInput, style: string): EdgePathGeometry {
  const curvature = getAppearanceOption("edgePathStyle", style)?.pathCurvature ?? 0.42;
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
