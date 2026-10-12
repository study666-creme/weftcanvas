import { MiniMap } from "@xyflow/react";

import type { ThemeMode } from "../App";
import type { WeftcanvasNode } from "../types";

export function CanvasMiniMap({ open, theme }: { open: boolean; theme: ThemeMode }) {
  if (!open) return null;

  const light = theme === "light";
  return (
    <MiniMap<WeftcanvasNode>
      className="wc-mini-map"
      ariaLabel="画布小地图"
      pannable
      zoomable
      zoomStep={8}
      offsetScale={8}
      nodeBorderRadius={4}
      nodeStrokeWidth={2}
      nodeColor={(node) =>
        node.selected ? (light ? "#3f6258" : "#b9d9cf") : light ? "#8d9792" : "#737a77"
      }
      nodeStrokeColor={light ? "#f3f5f2" : "#171818"}
      bgColor={light ? "#f9faf8" : "#292c2a"}
      maskColor={light ? "rgb(237 240 237 / 68%)" : "rgb(22 24 23 / 68%)"}
      maskStrokeColor={light ? "#66716c" : "#a9afac"}
      maskStrokeWidth={1.2}
    />
  );
}
