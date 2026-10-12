import type { CanvasNodeData } from "@weftcanvas/contracts";
import { nodeLabel } from "../lib/node-registry";
import { Minimize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { createPortal } from "react-dom";

export type NodeOverlayMode = "info" | "edit" | "preview";

type NodeOverlayProps = {
  mode: NodeOverlayMode | null;
  data: CanvasNodeData;
  width?: number;
  height?: number;
  mediaUrl: string | null;
  onClose: () => void;
  onBodyChange: (body: string) => void;
  onEditFocus: () => void;
  onEditBlur: () => void;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function blockFilePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
  if (Array.from(event.clipboardData.items).some((item) => item.kind === "file"))
    event.preventDefault();
}

export function NodeOverlay({
  mode,
  data,
  width,
  height,
  mediaUrl,
  onClose,
  onBodyChange,
  onEditFocus,
  onEditBlur,
}: NodeOverlayProps) {
  const editing = mode === "edit";
  const [bodyDraft, setBodyDraft] = useState(data.body);
  const bodyDraftRef = useRef(data.body);
  const committedBodyRef = useRef(data.body);

  const flushBodyDraft = useCallback(() => {
    if (!editing || bodyDraftRef.current === committedBodyRef.current) return;
    committedBodyRef.current = bodyDraftRef.current;
    onBodyChange(bodyDraftRef.current);
  }, [editing, onBodyChange]);

  const close = useCallback(() => {
    flushBodyDraft();
    onClose();
  }, [flushBodyDraft, onClose]);

  useEffect(() => {
    if (!editing || data.body === committedBodyRef.current) return;
    committedBodyRef.current = data.body;
    bodyDraftRef.current = data.body;
    setBodyDraft(data.body);
  }, [data.body, editing]);

  useEffect(() => {
    if (!editing || bodyDraft === committedBodyRef.current) return;
    const timer = window.setTimeout(flushBodyDraft, 240);
    return () => window.clearTimeout(timer);
  }, [bodyDraft, editing, flushBodyDraft]);

  useEffect(() => {
    if (!mode) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [close, mode]);

  if (!mode) return null;

  const title =
    mode === "info"
      ? "节点信息"
      : mode === "edit"
        ? `编辑${nodeLabel(data.kind)}`
        : data.media?.name || (data.kind === "image" ? "图片预览" : "视频预览");

  return createPortal(
    <div
      className={`wc-node-overlay wc-node-overlay--${mode}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className={`wc-node-overlay-panel wc-node-overlay-panel--${mode}`}
        data-overlay-mode={mode}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="wc-node-overlay-header">
          <span>{title}</span>
          <button
            type="button"
            className="wc-node-overlay-close"
            aria-label="收起"
            title="收起"
            onClick={close}
          >
            <Minimize2 aria-hidden="true" />
          </button>
        </header>

        {mode === "edit" ? (
          <textarea
            autoFocus
            className="wc-node-overlay-editor"
            value={bodyDraft}
            aria-label="节点内容"
            placeholder="输入创作内容"
            onFocus={onEditFocus}
            onBlur={() => {
              flushBodyDraft();
              onEditBlur();
            }}
            onPaste={blockFilePaste}
            onChange={(event) => {
              bodyDraftRef.current = event.target.value;
              setBodyDraft(event.target.value);
            }}
          />
        ) : null}

        {mode === "preview" ? (
          <div className="wc-node-overlay-media">
            {data.kind === "image" && mediaUrl ? (
              <img src={mediaUrl} alt={data.media?.name || "节点图片"} draggable={false} />
            ) : null}
            {data.kind === "video" && mediaUrl ? (
              <video src={mediaUrl} controls playsInline autoPlay preload="metadata" />
            ) : null}
          </div>
        ) : null}

        {mode === "info" ? (
          <dl className="wc-node-info-list">
            <div>
              <dt>类型</dt>
              <dd>{nodeLabel(data.kind)}</dd>
            </div>
            <div>
              <dt>尺寸</dt>
              <dd>
                {typeof width === "number" && typeof height === "number"
                  ? `${Math.round(width)} x ${Math.round(height)}`
                  : "测量中"}
              </dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                {data.status === "running"
                  ? "处理中"
                  : data.status === "success"
                    ? "已完成"
                    : data.status === "error"
                      ? "失败"
                      : "就绪"}
              </dd>
            </div>
            {data.media ? (
              <div>
                <dt>文件</dt>
                <dd title={data.media.name}>{data.media.name}</dd>
              </div>
            ) : null}
            {data.media ? (
              <div>
                <dt>大小</dt>
                <dd>{formatBytes(data.media.size)}</dd>
              </div>
            ) : null}
            <div>
              <dt>更新时间</dt>
              <dd>
                {new Intl.DateTimeFormat("zh-CN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(data.updatedAt)}
              </dd>
            </div>
          </dl>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
