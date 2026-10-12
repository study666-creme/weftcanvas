import type { CanvasMedia } from "@weftcanvas/contracts";
import {
  AlertCircle,
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useMediaUrl } from "../hooks/use-media-url";
import { downloadUrl } from "../lib/download";

export type ResultLightboxItem = {
  key: string;
  kind: "image" | "video";
  media: CanvasMedia;
  name: string;
  prompt: string;
  modelLabel: string;
};

/**
 * 结果放大查看层。图片与视频共用：卡片网格里只放得下缩略图，原图/完整视频
 * 在这里看。键盘左右切换、Esc 关闭，打开期间锁住页面滚动。
 */
export function ResultLightbox({
  items,
  index,
  onClose,
  onNavigate,
  onRemove,
  onReusePrompt,
}: {
  items: ResultLightboxItem[];
  index: number;
  onClose: () => void;
  onNavigate: (next: number) => void;
  onRemove: (item: ResultLightboxItem) => void;
  onReusePrompt: (item: ResultLightboxItem) => void;
}) {
  const item = items[index] ?? null;

  const go = useCallback(
    (delta: number) => {
      if (!items.length) return;
      onNavigate((index + delta + items.length) % items.length);
    },
    [index, items.length, onNavigate],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!items.length) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        go(1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [go, items.length, onClose]);

  // 打开期间禁止背景滚动，避免滚轮同时滚动后面的画廊。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!item) return null;

  return (
    <div
      className="wc-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="结果预览"
      onClick={onClose}
    >
      <div className="wc-lightbox-surface" onClick={(event) => event.stopPropagation()}>
        <header className="wc-lightbox-bar">
          <span className="wc-lightbox-model">{item.modelLabel}</span>
          {items.length > 1 ? (
            <span className="wc-lightbox-count">
              {index + 1} / {items.length}
            </span>
          ) : null}
          <button
            type="button"
            className="wc-lightbox-close"
            onClick={onClose}
            aria-label="关闭预览"
            title="关闭 (Esc)"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <LightboxContent
          key={item.key}
          item={item}
          onRemove={onRemove}
          onReusePrompt={onReusePrompt}
        />

        {items.length > 1 ? (
          <>
            <button
              type="button"
              className="wc-lightbox-nav is-prev"
              onClick={() => go(-1)}
              aria-label="上一个结果"
              title="上一个 (←)"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <button
              type="button"
              className="wc-lightbox-nav is-next"
              onClick={() => go(1)}
              aria-label="下一个结果"
              title="下一个 (→)"
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 单独挂在 key 上：切换结果时重新取 url 并重置播放/下载状态，
 * 视频也不会沿用上一个结果的解码上下文。
 */
function LightboxContent({
  item,
  onRemove,
  onReusePrompt,
}: {
  item: ResultLightboxItem;
  onRemove: (item: ResultLightboxItem) => void;
  onReusePrompt: (item: ResultLightboxItem) => void;
}) {
  const { url } = useMediaUrl(item.media);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!url || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadUrl(url, item.name);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "下载失败，请稍后重试");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <div className="wc-lightbox-stage">
        {!url ? (
          <div className="wc-lightbox-empty" role="status">
            <LoaderCircle className="is-spinning" aria-hidden="true" />
            <span>正在读取结果</span>
          </div>
        ) : item.kind === "video" ? (
          <video src={url} controls autoPlay playsInline />
        ) : (
          <img src={url} alt={item.prompt || item.name} />
        )}
      </div>

      {item.prompt ? <p className="wc-lightbox-prompt">{item.prompt}</p> : null}

      <footer className="wc-lightbox-actions">
        <button type="button" onClick={() => onReusePrompt(item)} disabled={!item.prompt}>
          <RotateCcw aria-hidden="true" />
          复用提示词
        </button>
        <button type="button" onClick={() => void handleDownload()} disabled={!url || downloading}>
          <ArrowDownToLine aria-hidden="true" />
          {downloading ? "正在下载" : "下载"}
        </button>
        <button type="button" className="is-danger" onClick={() => onRemove(item)}>
          <Trash2 aria-hidden="true" />
          删除
        </button>
      </footer>

      {downloadError ? (
        <p className="wc-lightbox-error" role="alert">
          <AlertCircle aria-hidden="true" />
          {downloadError}
        </p>
      ) : null}
    </>
  );
}
