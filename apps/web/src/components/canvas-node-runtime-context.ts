import { createContext } from "react";

export type CanvasNodeRuntimeContextValue = {
  overviewZoom: boolean;
  marqueeActive: boolean;
  multipleSelectionActive: boolean;
  projectId: string;
  cloudLinked: boolean;
  /** 画布当前 zoom（保留 2 位小数）：节点按档位取多级缩略图，见 local-media-thumb。 */
  canvasZoom: number;
};

export type CanvasEdgeRuntimeContextValue = {
  endpointEnergyEdgeIds: ReadonlySet<string>;
  ambientEnergyEdgeIds: ReadonlySet<string>;
};

export const CanvasNodeRuntimeContext = createContext<CanvasNodeRuntimeContextValue>({
  overviewZoom: false,
  marqueeActive: false,
  multipleSelectionActive: false,
  projectId: "",
  cloudLinked: false,
  canvasZoom: 1,
});

export const CanvasEdgeRuntimeContext = createContext<CanvasEdgeRuntimeContextValue>({
  endpointEnergyEdgeIds: new Set(),
  ambientEnergyEdgeIds: new Set(),
});
