import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  ImageOff,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react";

import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  type HomeWork,
} from "../../lib/home-data";
import { useToastStore } from "../../state/toast-store";
import { useHomeMediaSource } from "./home-media-thumb";

const KIND_LABEL = { image: "图片", video: "视频", audio: "音频" } as const;

const ORIGIN_LABEL = {
  project: "画布项目",
  workbench: "生成工作台",
  library: "资产库",
} as const;

/**
 * 作品预览：大图 / 视频 / 音频 + 提示词与元信息。左右方向键在当前列表里切换，
 * Esc 关闭。所有动作都基于真实数据：没有提示词就不提供「复用提示词」。
 */
export function HomeWorkPreview({
  works,
  index,
  onIndexChange,
  onClose,
  onReusePrompt,
  onOpenProject,
}: {
  works: readonly HomeWork[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onReusePrompt: (work: HomeWork) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const work = works[index] ?? null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { url, state, markMissing } = useHomeMediaSource(work?.media ?? null, work?.kind ?? null, {
    thumb: false,
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => setCopied(false), [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowRight" && index < works.length - 1) {
        event.preventDefault();
        onIndexChange(index + 1);
      } else if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        onIndexChange(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onClose, onIndexChange, works.length]);

  if (!work) return null;

  const duration = formatDuration(work.media.durationMs);
  const dimensions =
    work.media.width && work.media.height ? `${work.media.width} × ${work.media.height}` : null;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(work.prompt);
      setCopied(true);
      useToastStore.getState().show("提示词已复制", "success");
    } catch {
      useToastStore.getState().show("无法访问剪贴板，请手动选择复制", "error");
    }
  };

  const download = () => {
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = work.media.name || `纬线作品-${work.key}`;
    anchor.rel = "noopener";
    anchor.click();
  };

  return (
    <div
      className="wc-home-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="wc-home-preview"
        role="dialog"
        aria-modal="true"
        aria-label={`作品预览：${work.prompt || work.media.name}`}
      >
        <div className="wc-home-preview-stage" data-kind={work.kind}>
          {state === "loading" || state === "idle" ? (
            <span className="wc-home-preview-placeholder" role="status" aria-label="正在载入">
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            </span>
          ) : state === "missing" || !url ? (
            <span className="wc-home-preview-placeholder">
              <ImageOff aria-hidden="true" />
              <small>这份素材不在当前浏览器里，也无法从云端读取</small>
            </span>
          ) : work.kind === "image" ? (
            <img src={url} alt={work.prompt || work.media.name} onError={markMissing} />
          ) : work.kind === "video" ? (
            <video src={url} controls autoPlay muted playsInline onError={markMissing} />
          ) : (
            <div className="wc-home-preview-audio">
              <AudioLines aria-hidden="true" />
              <audio src={url} controls onError={markMissing} />
            </div>
          )}
          {index > 0 ? (
            <button
              type="button"
              className="wc-home-preview-nav is-prev"
              aria-label="上一件作品"
              onClick={() => onIndexChange(index - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          ) : null}
          {index < works.length - 1 ? (
            <button
              type="button"
              className="wc-home-preview-nav is-next"
              aria-label="下一件作品"
              onClick={() => onIndexChange(index + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <aside className="wc-home-preview-info">
          <header>
            <span className="wc-home-pill">{KIND_LABEL[work.kind]}</span>
            <span className="wc-home-preview-position">
              {index + 1} / {works.length}
            </span>
            <button
              ref={closeRef}
              type="button"
              className="wc-home-icon-button"
              aria-label="关闭预览"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </button>
          </header>

          <section className="wc-home-preview-prompt" aria-label="提示词">
            <h3>提示词</h3>
            {work.prompt ? (
              <p>{work.prompt}</p>
            ) : (
              <p className="is-empty">这件作品没有记录提示词。</p>
            )}
          </section>

          <dl className="wc-home-preview-meta">
            {work.model ? (
              <>
                <dt>模型</dt>
                <dd>{work.model}</dd>
              </>
            ) : null}
            {dimensions ? (
              <>
                <dt>尺寸</dt>
                <dd className="is-numeric">{dimensions}</dd>
              </>
            ) : null}
            {duration ? (
              <>
                <dt>时长</dt>
                <dd className="is-numeric">{duration}</dd>
              </>
            ) : null}
            {work.media.size ? (
              <>
                <dt>大小</dt>
                <dd className="is-numeric">{formatBytes(work.media.size)}</dd>
              </>
            ) : null}
            <dt>来源</dt>
            <dd>
              {work.origin.type === "project"
                ? `${ORIGIN_LABEL.project} · ${work.origin.projectName}`
                : ORIGIN_LABEL[work.origin.type]}
            </dd>
            <dt>时间</dt>
            <dd>{formatRelativeTime(work.createdAt)}</dd>
          </dl>

          <div className="wc-home-preview-actions">
            {work.prompt ? (
              <button
                type="button"
                className="wc-home-button is-primary"
                onClick={() => onReusePrompt(work)}
              >
                <Sparkles aria-hidden="true" />
                <span>用这段提示词再创作</span>
              </button>
            ) : null}
            <div className="wc-home-preview-secondary">
              {work.prompt ? (
                <button type="button" className="wc-home-button" onClick={() => void copyPrompt()}>
                  <Copy aria-hidden="true" />
                  <span>{copied ? "已复制" : "复制提示词"}</span>
                </button>
              ) : null}
              {work.origin.type === "project" ? (
                <button
                  type="button"
                  className="wc-home-button"
                  onClick={() =>
                    work.origin.type === "project" && onOpenProject(work.origin.projectId)
                  }
                >
                  <FolderOpen aria-hidden="true" />
                  <span>打开所在项目</span>
                </button>
              ) : null}
              <button
                type="button"
                className="wc-home-button"
                disabled={!url || state !== "ready"}
                onClick={download}
              >
                <Download aria-hidden="true" />
                <span>下载</span>
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
