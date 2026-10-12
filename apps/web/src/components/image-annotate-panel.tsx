import { Circle, Eraser, Minus, Pencil, Redo2, Square, Undo2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";

import "./image-annotate-panel.css";

export type AnnotateTool = "pen" | "line" | "circle" | "rect";

export type ImageAnnotateSettings = {
  tool: AnnotateTool;
  color: string;
  lineWidth: number;
};

export const defaultImageAnnotateSettings: ImageAnnotateSettings = {
  tool: "pen",
  color: "#d86351",
  lineWidth: 4,
};

const LINE_WIDTH_MIN = 1;
const LINE_WIDTH_MAX = 16;
const LINE_WIDTH_STEP = 1;
const HEX_COLOR = /^#[\da-f]{6}$/i;
const COLOR_PRESETS = ["#d86351", "#36b7a4", "#d6a438", "#4f7cd6", "#ffffff", "#171a18"] as const;

const TOOLS: Array<{ id: AnnotateTool; label: string; icon: typeof Pencil }> = [
  { id: "pen", label: "画笔", icon: Pencil },
  { id: "line", label: "直线", icon: Minus },
  { id: "circle", label: "圆圈", icon: Circle },
  { id: "rect", label: "方框", icon: Square },
];

type Point = { x: number; y: number };

type ShapeDraft = {
  tool: Exclude<AnnotateTool, "pen">;
  color: string;
  lineWidth: number;
  start: Point;
  end: Point;
};

type Stroke = {
  tool: AnnotateTool;
  color: string;
  lineWidth: number;
  points: Point[];
};

export type ImageAnnotatePanelProps = {
  open: boolean;
  /** 已解码的源图（自然尺寸），编辑在图像坐标系完成，导出即源图尺寸。 */
  image: HTMLImageElement | null;
  sourceName?: string;
  applying?: boolean;
  disabled?: boolean;
  onApply: (blob: Blob) => void | Promise<void>;
  onClose: () => void;
};

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeSettings(value: ImageAnnotateSettings): ImageAnnotateSettings {
  return {
    tool: TOOLS.some((tool) => tool.id === value.tool)
      ? value.tool
      : defaultImageAnnotateSettings.tool,
    color: HEX_COLOR.test(value.color) ? value.color : defaultImageAnnotateSettings.color,
    lineWidth: clamp(Math.round(value.lineWidth), LINE_WIDTH_MIN, LINE_WIDTH_MAX),
  };
}

function strokePath(context: CanvasRenderingContext2D, stroke: Stroke, scale: number) {
  if (stroke.points.length === 0) return;
  context.save();
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.lineWidth * scale;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  const first = stroke.points[0];
  if (!first) {
    context.restore();
    return;
  }
  context.moveTo(first.x, first.y);
  for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
  if (stroke.points.length === 1) context.lineTo(first.x + 0.01, first.y + 0.01);
  context.stroke();
  context.restore();
}

function shapePath(context: CanvasRenderingContext2D, draft: ShapeDraft, scale: number) {
  context.save();
  context.strokeStyle = draft.color;
  context.lineWidth = draft.lineWidth * scale;
  context.lineCap = "round";
  const width = draft.end.x - draft.start.x;
  const height = draft.end.y - draft.start.y;
  context.beginPath();
  if (draft.tool === "line") {
    context.moveTo(draft.start.x, draft.start.y);
    context.lineTo(draft.end.x, draft.end.y);
  } else if (draft.tool === "circle") {
    context.ellipse(
      draft.start.x + width / 2,
      draft.start.y + height / 2,
      Math.abs(width) / 2,
      Math.abs(height) / 2,
      0,
      0,
      2 * Math.PI,
    );
  } else {
    context.rect(
      Math.min(draft.start.x, draft.end.x),
      Math.min(draft.start.y, draft.end.y),
      Math.abs(width),
      Math.abs(height),
    );
  }
  context.stroke();
  context.restore();
}

function renderComposite(
  image: HTMLImageElement,
  strokes: Stroke[],
  scale: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.drawImage(image, 0, 0);
  for (const stroke of strokes) {
    if (stroke.tool === "pen") {
      strokePath(context, stroke, scale);
    } else {
      shapePath(
        context,
        {
          tool: stroke.tool,
          color: stroke.color,
          lineWidth: stroke.lineWidth,
          start: stroke.points[0]!,
          end: stroke.points.at(-1)!,
        },
        scale,
      );
    }
  }
  return canvas;
}

export function ImageAnnotatePanel({
  open,
  image,
  sourceName = "源图像",
  applying = false,
  disabled = false,
  onApply,
  onClose,
}: ImageAnnotatePanelProps) {
  const [settings, setSettings] = useState<ImageAnnotateSettings>(defaultImageAnnotateSettings);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const [draft, setDraft] = useState<ShapeDraft | null>(null);
  const activeStroke = useRef<{ pointerId: number; stroke: Stroke } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const normalized = normalizeSettings(settings);

  const close = useCallback(() => {
    if (applying) return;
    setStrokes([]);
    setRedoStack([]);
    setDraft(null);
    activeStroke.current = null;
    onClose();
  }, [applying, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || applying) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [applying, close, open]);

  // 始终以源图像坐标为基准：编辑视图用变换矩阵缩放到显示尺寸，线宽按同一
  // 比例缩放，导出时回到自然尺寸，标注粗细在任意显示比例下视觉一致。
  const displayScale = image
    ? stageRef.current?.clientWidth
      ? stageRef.current.clientWidth / image.naturalWidth
      : 1
    : 1;

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const stage = stageRef.current;
    const width = stage?.clientWidth ?? image.naturalWidth;
    const height = stage?.clientHeight ?? image.naturalHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const scale = width / image.naturalWidth;
    context.drawImage(image, 0, 0, width, height);
    for (const stroke of strokes) {
      if (stroke.tool === "pen") {
        strokePath(context, stroke, scale);
      } else {
        shapePath(
          context,
          {
            tool: stroke.tool,
            color: stroke.color,
            lineWidth: stroke.lineWidth,
            start: stroke.points[0]!,
            end: stroke.points.at(-1)!,
          },
          scale,
        );
      }
    }
    if (draft) shapePath(context, draft, scale);
  }, [draft, image, strokes]);

  useEffect(() => {
    redrawCanvas();
  });

  useEffect(() => {
    if (!open) return;
    const onResize = () => redrawCanvas();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, redrawCanvas]);

  const pointFromPointer = (event: PointerEvent<HTMLDivElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = image.naturalWidth / Math.max(1, rect.width);
    const scaleY = image.naturalHeight / Math.max(1, rect.height);
    return {
      x: clamp((event.clientX - rect.left) * scaleX, 0, image.naturalWidth),
      y: clamp((event.clientY - rect.top) * scaleY, 0, image.naturalHeight),
    };
  };

  const beginDraw = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || applying || !image) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointFromPointer(event);
    if (!point) return;
    setRedoStack([]);
    if (normalized.tool === "pen") {
      const stroke: Stroke = {
        tool: "pen",
        color: normalized.color,
        lineWidth: normalized.lineWidth,
        points: [point],
      };
      activeStroke.current = { pointerId: event.pointerId, stroke };
      setStrokes((current) => [...current, stroke]);
    } else {
      setDraft({
        tool: normalized.tool,
        color: normalized.color,
        lineWidth: normalized.lineWidth,
        start: point,
        end: point,
      });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDraw = (event: PointerEvent<HTMLDivElement>) => {
    const active = activeStroke.current;
    if (active && active.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      const point = pointFromPointer(event);
      if (!point) return;
      const stroke: Stroke = { ...active.stroke, points: [...active.stroke.points, point] };
      active.stroke = stroke;
      // 用累积长度定位活动笔画：尾部引用比对在闭包外的并发更新下会失效。
      setStrokes((current) => {
        const next = [...current];
        next[next.length - 1] = stroke;
        return next;
      });
      return;
    }
    if (draft) {
      event.preventDefault();
      event.stopPropagation();
      const point = pointFromPointer(event);
      if (!point) return;
      setDraft((current) => (current ? { ...current, end: point } : current));
    }
  };

  const endDraw = (event: PointerEvent<HTMLDivElement>) => {
    const active = activeStroke.current;
    if (active && active.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      activeStroke.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (draft) {
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const finished = draft;
      setDraft(null);
      const distance = Math.hypot(
        finished.end.x - finished.start.x,
        finished.end.y - finished.start.y,
      );
      if (distance >= finished.lineWidth * 1.5) {
        setStrokes((current) => [
          ...current,
          {
            tool: finished.tool,
            color: finished.color,
            lineWidth: finished.lineWidth,
            points: [finished.start, finished.end],
          },
        ]);
      }
    }
  };

  const undo = () => {
    setStrokes((current) => {
      if (!current.length) return current;
      setRedoStack((redo) => [...redo, current[current.length - 1]!]);
      return current.slice(0, -1);
    });
  };

  const redo = () => {
    setRedoStack((current) => {
      if (!current.length) return current;
      const stroke = current[current.length - 1]!;
      setStrokes((strokesNow) => [...strokesNow, stroke]);
      return current.slice(0, -1);
    });
  };

  const clearAll = () => {
    setRedoStack([...strokes].reverse());
    setStrokes([]);
  };

  const apply = async () => {
    if (!image || applying || disabled) return;
    const composite = renderComposite(image, strokes, 1 / Math.max(0.0001, displayScale));
    const blob = await new Promise<Blob | null>((resolve) =>
      composite.toBlob(resolve, "image/png"),
    );
    if (!blob) return;
    await onApply(blob);
    setStrokes([]);
    setRedoStack([]);
    setDraft(null);
  };

  if (!open || typeof document === "undefined" || !image) return null;

  const busy = applying || disabled;
  const canApply = strokes.length > 0 && !busy;
  const stageAspect = image.naturalWidth / image.naturalHeight;

  const isolateWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return createPortal(
    <div
      className="wc-image-annotate-backdrop"
      data-wc-block-canvas-shortcuts
      onWheel={isolateWheel}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) close();
      }}
    >
      <div className="wc-image-annotate-panel" role="dialog" aria-label="图片标注">
        <header className="wc-image-annotate-header">
          <strong>标注图片</strong>
          <span className="wc-image-annotate-sub">{sourceName}</span>
          <button
            type="button"
            className="wc-image-annotate-close"
            aria-label="关闭图片标注"
            title="关闭"
            onClick={close}
            disabled={busy}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="wc-image-annotate-stage-row">
          <div
            ref={stageRef}
            className="wc-image-annotate-stage"
            style={
              {
                aspectRatio: `${stageAspect}`,
                "--stage-aspect": stageAspect,
              } as React.CSSProperties
            }
            onPointerDown={beginDraw}
            onPointerMove={moveDraw}
            onPointerUp={endDraw}
            onPointerCancel={endDraw}
          >
            <canvas ref={canvasRef} className="wc-image-annotate-canvas" aria-label="标注画布" />
          </div>
        </div>

        <div className="wc-image-annotate-tools" role="toolbar" aria-label="标注工具">
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.id}
                type="button"
                className={normalized.tool === tool.id ? "is-active" : undefined}
                aria-pressed={normalized.tool === tool.id}
                aria-label={tool.label}
                title={tool.label}
                disabled={busy}
                onClick={() => setSettings({ ...normalized, tool: tool.id })}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
          <span className="wc-image-annotate-divider" aria-hidden="true" />
          {COLOR_PRESETS.map((color) => (
            <button
              key={color}
              type="button"
              className={`wc-image-annotate-color ${normalized.color === color ? "is-active" : ""}`}
              style={{ background: color }}
              aria-label={`画笔颜色 ${color}`}
              aria-pressed={normalized.color === color}
              title={color}
              disabled={busy}
              onClick={() => setSettings({ ...normalized, color })}
            />
          ))}
          <span className="wc-image-annotate-divider" aria-hidden="true" />
          <label className="wc-image-annotate-width" title="线条粗细">
            <span aria-hidden="true">粗细</span>
            <input
              type="range"
              min={LINE_WIDTH_MIN}
              max={LINE_WIDTH_MAX}
              step={LINE_WIDTH_STEP}
              value={normalized.lineWidth}
              disabled={busy}
              onChange={(event) =>
                setSettings({ ...normalized, lineWidth: Number(event.target.value) })
              }
            />
            <output>{normalized.lineWidth}</output>
          </label>
          <span className="wc-image-annotate-divider" aria-hidden="true" />
          <button
            type="button"
            aria-label="撤销上一笔"
            title="撤销"
            disabled={busy || !strokes.length}
            onClick={undo}
          >
            <Undo2 aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="重做"
            title="重做"
            disabled={busy || !redoStack.length}
            onClick={redo}
          >
            <Redo2 aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="清空全部标注"
            title="清空"
            disabled={busy || !strokes.length}
            onClick={clearAll}
          >
            <Eraser aria-hidden="true" />
          </button>
        </div>

        <footer className="wc-image-annotate-footer">
          <span className="wc-image-annotate-hint">
            编辑完成后将生成一张新图片节点，并连接到当前节点
          </span>
          <button
            type="button"
            className="wc-image-annotate-apply"
            disabled={!canApply}
            onClick={() => void apply()}
          >
            {applying ? "正在生成…" : "生成新节点"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
