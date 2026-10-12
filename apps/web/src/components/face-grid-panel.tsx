import {
  AlertCircle,
  Check,
  Grid3X3,
  LoaderCircle,
  MousePointer2,
  RefreshCw,
  ScanFace,
  Shuffle,
  X,
} from "lucide-react";
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";

import type { FaceGridManualSelection } from "../lib/face-grid";
import "./face-grid-panel.css";

export type FaceGridMode = "grid" | "recompose";

export type FaceGridDetectionStatus = "idle" | "detecting" | "ready" | "error";

export type FaceGridSettings = {
  mode: FaceGridMode;
  color: string;
  lineWidth: number;
  opacity: number;
};

export type FaceGridPanelProps = {
  open: boolean;
  sourceUrl: string | null;
  sourceName?: string;
  value: FaceGridSettings;
  status: FaceGridDetectionStatus;
  error?: string | null;
  faceCount?: number | null;
  previewUrl?: string | null;
  previewAlt?: string;
  manualSelection?: FaceGridManualSelection | null;
  applying?: boolean;
  disabled?: boolean;
  onChange: (value: FaceGridSettings) => void;
  onDetect: () => void | Promise<void>;
  onManualSelectionChange: (selection: FaceGridManualSelection | null) => void | Promise<void>;
  onApply: (value: FaceGridSettings) => void | Promise<void>;
  onClose: () => void;
};

export const defaultFaceGridSettings: FaceGridSettings = {
  mode: "grid",
  color: "#ffffff",
  lineWidth: 1.5,
  opacity: 0.78,
};

const LINE_WIDTH_MIN = 0.5;
const LINE_WIDTH_MAX = 6;
const LINE_WIDTH_STEP = 0.5;
const OPACITY_MIN = 0.1;
const OPACITY_MAX = 1;
const OPACITY_STEP = 0.05;
const HEX_COLOR = /^#[\da-f]{6}$/i;
const COLOR_PRESETS = ["#ffffff", "#171a18", "#36b7a4", "#d86351", "#d6a438"] as const;
const MIN_MANUAL_BOX_SIZE = 0.018;

type Point = {
  x: number;
  y: number;
};

type ManualDrag = {
  pointerId: number;
  start: Point;
};

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeSettings(value: FaceGridSettings): FaceGridSettings {
  return {
    mode: value.mode === "recompose" ? "recompose" : "grid",
    color: HEX_COLOR.test(value.color) ? value.color : defaultFaceGridSettings.color,
    lineWidth: clamp(value.lineWidth, LINE_WIDTH_MIN, LINE_WIDTH_MAX),
    opacity: clamp(value.opacity, OPACITY_MIN, OPACITY_MAX),
  };
}

function statusText(
  status: FaceGridDetectionStatus,
  faceCount: number | null,
  manualSelection: FaceGridManualSelection | null,
) {
  if (manualSelection) return "已手动选择人脸";
  if (status === "detecting") return "正在检测人脸";
  if (status === "error") return "检测失败";
  if (status === "ready") {
    if (faceCount === null) return "检测完成";
    return faceCount > 0 ? `检测到 ${faceCount} 张人脸` : "未检测到人脸";
  }
  return "等待检测";
}

function selectionFromPoints(start: Point, end: Point): FaceGridManualSelection {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.max(start.x, end.x) - left),
    height: Math.max(0, Math.max(start.y, end.y) - top),
  };
}

function pointFromPointer(event: PointerEvent<HTMLElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
  };
}

function selectionStyle(selection: FaceGridManualSelection) {
  return {
    left: `${selection.x * 100}%`,
    top: `${selection.y * 100}%`,
    width: `${selection.width * 100}%`,
    height: `${selection.height * 100}%`,
  };
}

export function FaceGridPanel({
  open,
  sourceUrl,
  sourceName = "源图像",
  value,
  status,
  error = null,
  faceCount = null,
  previewUrl = null,
  previewAlt = "人脸网格预览",
  manualSelection = null,
  applying = false,
  disabled = false,
  onChange,
  onDetect,
  onManualSelectionChange,
  onApply,
  onClose,
}: FaceGridPanelProps) {
  const [manualMode, setManualMode] = useState(false);
  const [manualDraft, setManualDraft] = useState<FaceGridManualSelection | null>(null);
  const manualDrag = useRef<ManualDrag | null>(null);

  if (!open || typeof document === "undefined") return null;

  const settings = normalizeSettings(value);
  const detectedFaces =
    typeof faceCount === "number" && Number.isFinite(faceCount)
      ? Math.max(0, Math.floor(faceCount))
      : null;
  const detecting = status === "detecting";
  const busy = detecting || applying;
  const canDetect = Boolean(sourceUrl) && !disabled && !busy;
  const canManualSelect = Boolean(sourceUrl) && !disabled && !busy;
  const readyToApply =
    status === "ready" && detectedFaces !== null && detectedFaces > 0 && Boolean(previewUrl);
  const statusLabel = statusText(status, detectedFaces, manualSelection);
  const activeSelection = manualDraft || manualSelection;

  const updateSetting = <Key extends keyof FaceGridSettings>(
    key: Key,
    next: FaceGridSettings[Key],
  ) => {
    onChange({ ...settings, [key]: next });
  };

  const isolateWheel = (event: WheelEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    event.stopPropagation();
    if (manualMode) {
      setManualMode(false);
      setManualDraft(null);
      manualDrag.current = null;
      return;
    }
    onClose();
  };

  const beginManualDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!manualMode || !canManualSelect) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointFromPointer(event);
    manualDrag.current = { pointerId: event.pointerId, start: point };
    setManualDraft({ ...point, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveManualDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = manualDrag.current;
    if (!manualMode || !drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setManualDraft(selectionFromPoints(drag.start, pointFromPointer(event)));
  };

  const finishManualDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = manualDrag.current;
    if (!manualMode || !drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    manualDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const selection = selectionFromPoints(drag.start, pointFromPointer(event));
    setManualDraft(null);
    if (selection.width < MIN_MANUAL_BOX_SIZE || selection.height < MIN_MANUAL_BOX_SIZE) return;
    setManualMode(false);
    void onManualSelectionChange(selection);
  };

  const cancelManualDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!manualDrag.current || manualDrag.current.pointerId !== event.pointerId) return;
    manualDrag.current = null;
    setManualDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const previewSource = manualMode ? sourceUrl : previewUrl || sourceUrl;
  const panel = (
    <section
      className="wc-face-grid-panel nodrag nowheel"
      data-face-grid-panel
      role="dialog"
      aria-label="人脸网格设置"
      aria-modal="false"
      data-detection-status={status}
      data-manual-mode={manualMode || undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={isolateWheel}
      onKeyDown={handleKeyDown}
    >
      <header className="wc-face-grid-header">
        <span className="wc-face-grid-title-mark" aria-hidden="true">
          <ScanFace />
        </span>
        <span className="wc-face-grid-title">
          <strong>人脸网格</strong>
          <small title={sourceName}>图像分析 · {sourceName}</small>
        </span>
        <span className={`wc-face-grid-status is-${status}`} role="status" aria-live="polite">
          {detecting ? (
            <LoaderCircle className="is-spinning" aria-hidden="true" />
          ) : status === "error" ? (
            <AlertCircle aria-hidden="true" />
          ) : status === "ready" ? (
            <Check aria-hidden="true" />
          ) : (
            <span aria-hidden="true" />
          )}
          {statusLabel}
        </span>
      </header>

      <div className={`wc-face-grid-preview is-${status} ${manualMode ? "is-manual" : ""}`}>
        {previewSource ? (
          <div
            className="wc-face-grid-preview-media"
            onPointerDown={beginManualDrag}
            onPointerMove={moveManualDrag}
            onPointerUp={finishManualDrag}
            onPointerCancel={cancelManualDrag}
          >
            <img src={previewSource} alt={previewAlt || sourceName} draggable={false} />
            {activeSelection ? (
              <span
                className="wc-face-grid-manual-box"
                style={selectionStyle(activeSelection)}
                aria-hidden="true"
              />
            ) : null}
          </div>
        ) : null}
        {!previewSource ? (
          <div className="wc-face-grid-preview-empty">
            {detecting ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : status === "error" ? (
              <AlertCircle aria-hidden="true" />
            ) : (
              <ScanFace aria-hidden="true" />
            )}
            <span>
              {detecting
                ? "正在分析图像"
                : status === "error"
                  ? "没有可用预览"
                  : status === "ready"
                    ? "正在等待预览"
                    : "尚未检测"}
            </span>
          </div>
        ) : null}
        {previewSource && detecting ? (
          <div className="wc-face-grid-preview-progress" role="status">
            <LoaderCircle className="is-spinning" aria-hidden="true" />
            <span>正在重新检测</span>
          </div>
        ) : null}
        {manualMode ? <span className="wc-face-grid-manual-hint">拖拽框住人脸区域</span> : null}
        {status === "ready" && detectedFaces !== null ? (
          <span className={`wc-face-grid-count ${detectedFaces === 0 ? "is-empty" : ""}`}>
            <ScanFace aria-hidden="true" />
            {manualSelection
              ? "手动人脸"
              : detectedFaces > 0
                ? `${detectedFaces} 张人脸`
                : "未发现人脸"}
          </span>
        ) : null}
      </div>

      {status === "error" ? (
        <div className="wc-face-grid-error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{error?.trim() || "人脸检测没有完成，请检查图片后重试，也可以手动框选人脸"}</span>
        </div>
      ) : null}

      <div className="wc-face-grid-detect-row">
        <button
          className="wc-face-grid-detect"
          type="button"
          disabled={!canDetect}
          title={!sourceUrl && !busy ? "提供图片后才能开始检测" : undefined}
          onClick={() => {
            setManualMode(false);
            setManualDraft(null);
            void onDetect();
          }}
        >
          {detecting ? (
            <LoaderCircle className="is-spinning" aria-hidden="true" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          <span>{detecting ? "正在检测" : status === "idle" ? "检测人脸" : "重新检测"}</span>
        </button>
        <button
          className={`wc-face-grid-manual ${manualMode ? "is-active" : ""}`}
          type="button"
          disabled={!canManualSelect}
          title={!sourceUrl && !busy ? "提供图片后才能手动选择" : undefined}
          onClick={() => {
            setManualDraft(null);
            setManualMode((value) => !value);
          }}
        >
          <MousePointer2 aria-hidden="true" />
          <span>{manualMode ? "取消框选" : manualSelection ? "重选人脸" : "手动选择"}</span>
        </button>
      </div>

      <fieldset className="wc-face-grid-fieldset" disabled={disabled || busy}>
        <legend>处理模式</legend>
        <div className="wc-face-grid-segmented">
          <button
            type="button"
            className={settings.mode === "grid" ? "is-active" : ""}
            aria-pressed={settings.mode === "grid"}
            onClick={() => updateSetting("mode", "grid")}
          >
            <Grid3X3 aria-hidden="true" />
            <span>
              <strong>网格</strong>
              <small>保留原图结构</small>
            </span>
          </button>
          <button
            type="button"
            className={settings.mode === "recompose" ? "is-active" : ""}
            aria-pressed={settings.mode === "recompose"}
            onClick={() => updateSetting("mode", "recompose")}
          >
            <Shuffle aria-hidden="true" />
            <span>
              <strong>人脸重组</strong>
              <small>按人脸重新排列</small>
            </span>
          </button>
        </div>
      </fieldset>

      <fieldset
        className="wc-face-grid-fieldset wc-face-grid-appearance"
        disabled={disabled || busy}
      >
        <legend>网格样式</legend>
        <div className="wc-face-grid-color-row">
          <span>颜色</span>
          <div className="wc-face-grid-swatches" role="group" aria-label="网格颜色">
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                className={settings.color.toLowerCase() === color ? "is-active" : ""}
                aria-label={`选择颜色 ${color}`}
                aria-pressed={settings.color.toLowerCase() === color}
                style={{ backgroundColor: color }}
                onClick={() => updateSetting("color", color)}
              />
            ))}
            <label className="wc-face-grid-color-custom" title="自定义颜色">
              <span aria-hidden="true" />
              <input
                type="color"
                value={settings.color}
                aria-label="自定义网格颜色"
                onChange={(event) => updateSetting("color", event.target.value)}
              />
            </label>
          </div>
        </div>

        <label className="wc-face-grid-range">
          <span>
            <span>线宽</span>
            <output>{settings.lineWidth.toFixed(1)} 像素</output>
          </span>
          <input
            type="range"
            min={LINE_WIDTH_MIN}
            max={LINE_WIDTH_MAX}
            step={LINE_WIDTH_STEP}
            value={settings.lineWidth}
            style={rangeProgressStyle(settings.lineWidth, LINE_WIDTH_MIN, LINE_WIDTH_MAX)}
            onChange={(event) => updateSetting("lineWidth", Number(event.target.value))}
          />
        </label>

        <label className="wc-face-grid-range">
          <span>
            <span>透明度</span>
            <output>{Math.round(settings.opacity * 100)}%</output>
          </span>
          <input
            type="range"
            min={OPACITY_MIN}
            max={OPACITY_MAX}
            step={OPACITY_STEP}
            value={settings.opacity}
            style={rangeProgressStyle(settings.opacity, OPACITY_MIN, OPACITY_MAX)}
            onChange={(event) => updateSetting("opacity", Number(event.target.value))}
          />
        </label>
      </fieldset>

      <footer className="wc-face-grid-footer">
        <button type="button" disabled={busy} onClick={onClose}>
          <X aria-hidden="true" />
          <span>取消</span>
        </button>
        <button
          className="is-primary"
          type="button"
          disabled={disabled || busy || !readyToApply}
          title={!readyToApply && !busy ? "检测完成并取得预览后才能应用" : undefined}
          onClick={() => void onApply(settings)}
        >
          {applying ? (
            <LoaderCircle className="is-spinning" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          <span>{applying ? "正在应用" : "应用到画布"}</span>
        </button>
      </footer>
    </section>
  );

  return createPortal(panel, document.body);
}

function rangeProgressStyle(value: number, min: number, max: number) {
  const progress = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return { "--wc-range-progress": `${progress}%` } as CSSProperties;
}
