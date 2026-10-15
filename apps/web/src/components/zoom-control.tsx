import { LocateFixed, Map, Minus, Plus } from "lucide-react";
import { useReactFlow, useStore } from "@xyflow/react";
import { memo, type CSSProperties } from "react";

import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from "../lib/canvas-viewport";
import type { WeftcanvasEdge, WeftcanvasNode } from "../types";

export const ZoomControl = memo(function ZoomControl({
  miniMapOpen,
  onToggleMiniMap,
}: {
  miniMapOpen: boolean;
  onToggleMiniMap: () => void;
}) {
  const { fitView, getViewport, setViewport, zoomIn, zoomOut } = useReactFlow<
    WeftcanvasNode,
    WeftcanvasEdge
  >();
  const zoom = useStore((state) => state.transform[2]);
  const zoomProgress = ((zoom - MIN_CANVAS_ZOOM) / (MAX_CANVAS_ZOOM - MIN_CANVAS_ZOOM)) * 100;

  return (
    <div className="wc-zoom-control" aria-label="缩放控制" data-wc-tour="zoom">
      <button
        type="button"
        className={miniMapOpen ? "is-active" : ""}
        aria-label={miniMapOpen ? "隐藏小地图" : "显示小地图"}
        title={miniMapOpen ? "隐藏小地图" : "显示小地图"}
        aria-pressed={miniMapOpen}
        onClick={onToggleMiniMap}
      >
        <Map aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="定位全部内容"
        title="定位全部内容"
        onClick={() => void fitView({ duration: 260, padding: 0.18 })}
      >
        <LocateFixed aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="缩小"
        title="缩小"
        onClick={() => void zoomOut({ duration: 150 })}
      >
        <Minus aria-hidden="true" />
      </button>
      <input
        type="range"
        min={String(MIN_CANVAS_ZOOM * 100)}
        max={String(MAX_CANVAS_ZOOM * 100)}
        step="5"
        value={Math.round(zoom * 100)}
        aria-label="画布缩放"
        aria-valuetext={`${Math.round(zoom * 100)}%`}
        style={
          { "--wc-zoom-progress": `${Math.max(0, Math.min(100, zoomProgress))}%` } as CSSProperties
        }
        onChange={(event) => {
          const viewport = getViewport();
          void setViewport(
            { ...viewport, zoom: Number(event.target.value) / 100 },
            { duration: 0 },
          );
        }}
      />
      <span>{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        aria-label="放大"
        title="放大"
        onClick={() => void zoomIn({ duration: 150 })}
      >
        <Plus aria-hidden="true" />
      </button>
    </div>
  );
});
