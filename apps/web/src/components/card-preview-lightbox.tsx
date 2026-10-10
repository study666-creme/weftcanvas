import { AlertCircle, ChevronLeft, ChevronRight, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 卡片大图预览层：社区卡片弹层与卡片库共用。
 *
 * 点击列表里的卡片只放大查看（原图 URL 由调用方经 resolveImages 解析，
 * <img> 原生加载，绕开远端媒体域的 CORS）；「加入画布」等写操作一律
 * 走右侧信息栏的 actions 按钮。
 *
 * item 必须在预览开着期间保持引用稳定（放在父组件 state 里，例如点击时
 * 组装一次），否则换 item 会重新解析图片；actions 每次渲染重建没问题，
 * busy 状态会实时反映到按钮上。
 */

export type CardPreviewMeta = {
  icon?: ReactNode;
  text: string;
  title?: string;
};

export type CardPreviewAction = {
  label: string;
  icon: ReactNode;
  /** 主操作（加入画布）/次操作（收藏资产）：只影响样式。 */
  variant: "primary" | "secondary";
  busy?: boolean;
  /** busy 期间按钮文案，缺省沿用 label。 */
  busyLabel?: string;
  /** 完成/不可用态（如“已在资产库”）：禁用但保留文案。 */
  disabled?: boolean;
  onAction: () => void;
};

export type CardPreviewItem = {
  key: string;
  title: string;
  prompt: string;
  meta: CardPreviewMeta[];
  /** 信息栏底部的来源说明（如“来自 prompt-hubs 社区”）。 */
  footerNote?: string;
  /** 原图加载失败或解析不可得时的缩略图兜底，可为空。 */
  thumbnailUrl: string;
  /** 解析大图展示 URL（多图卡片按封面顺序）。失败/为空时回退 thumbnailUrl。 */
  resolveImages: () => Promise<string[]>;
};

export function CardPreviewLightbox({
  item,
  actions,
  onClose,
}: {
  item: CardPreviewItem;
  actions: CardPreviewAction[];
  onClose: () => void;
}) {
  const [urls, setUrls] = useState<string[]>([]);
  const [resolving, setResolving] = useState(true);
  const [brokenUrls, setBrokenUrls] = useState<ReadonlySet<string>>(new Set());
  const [index, setIndex] = useState(0);
  const resolveVersion = useRef(0);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const resolve = useCallback((target: CardPreviewItem) => {
    const version = ++resolveVersion.current;
    setUrls([]);
    setIndex(0);
    setBrokenUrls(new Set());
    setResolving(true);
    void target.resolveImages()
      .then((resolved) => {
        if (resolveVersion.current !== version) return;
        setUrls(resolved);
        setResolving(false);
      })
      .catch(() => {
        if (resolveVersion.current !== version) return;
        setUrls([]);
        setResolving(false);
      });
  }, []);

  useEffect(() => {
    resolve(item);
  }, [item, resolve]);

  // 打开期间锁背景滚动（对齐结果预览层），并接管焦点：进入时聚焦面板、
  // 关闭后归还给触发卡片，键盘用户不会“丢焦点”。
  useEffect(() => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surfaceRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocus?.focus({ preventScroll: true });
    };
  }, []);

  const navigate = useCallback((delta: number) => {
    if (urls.length < 2) return;
    setIndex((current) => (current + delta + urls.length) % urls.length);
  }, [urls.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigate(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigate(1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate, onClose]);

  const markBroken = useCallback((url: string) => {
    setBrokenUrls((current) => {
      if (current.has(url)) return current;
      const next = new Set(current);
      next.add(url);
      return next;
    });
  }, []);

  const currentLarge = urls[index] ?? "";
  const currentUrl = currentLarge && !brokenUrls.has(currentLarge)
    ? currentLarge
    : item.thumbnailUrl && !brokenUrls.has(item.thumbnailUrl) ? item.thumbnailUrl : "";
  const anyBusy = actions.some((action) => action.busy);

  return createPortal(
    // data-kc-preserve-drawers：从卡片库打开时，预览层内的点击不算“点外”，
    // 不会把资源库抽屉关掉；aria-modal 让画布快捷键整体静默。
    <div
      className="kc-card-preview"
      role="dialog"
      aria-modal="true"
      aria-label={`卡片预览：${item.title || "未命名卡片"}`}
      data-kc-preserve-drawers
      data-kc-block-canvas-shortcuts
      onClick={onClose}
    >
      <div
        ref={surfaceRef}
        className="kc-card-preview-surface"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="kc-card-preview-header">
          <strong className="kc-card-preview-title">{item.title || "未命名卡片"}</strong>
          {urls.length > 1 ? <span className="kc-card-preview-count">{index + 1} / {urls.length}</span> : null}
          <button
            type="button"
            className="kc-card-preview-close"
            aria-label="关闭预览"
            title="关闭 (Esc)"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="kc-card-preview-stage">
          <div className="kc-card-preview-canvas">
            {resolving ? (
              <div className="kc-card-preview-state" role="status">
                <LoaderCircle className="is-spinning" aria-hidden="true" />
                <span>正在读取原图</span>
              </div>
            ) : currentUrl ? (
              <img
                key={currentUrl}
                src={currentUrl}
                alt={item.title || "卡片原图"}
                draggable={false}
                decoding="async"
                onError={() => markBroken(currentUrl)}
              />
            ) : (
              <div className="kc-card-preview-state" role="status">
                <AlertCircle aria-hidden="true" />
                <span>原图暂时无法加载</span>
                <button
                  type="button"
                  className="kc-card-preview-retry"
                  onClick={() => resolve(item)}
                >
                  <RotateCcw aria-hidden="true" />重试
                </button>
              </div>
            )}
            {urls.length > 1 ? (
              <>
                <button
                  type="button"
                  className="kc-card-preview-nav is-prev"
                  aria-label="上一张图"
                  title="上一张 (←)"
                  onClick={() => navigate(-1)}
                >
                  <ChevronLeft aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="kc-card-preview-nav is-next"
                  aria-label="下一张图"
                  title="下一张 (→)"
                  onClick={() => navigate(1)}
                >
                  <ChevronRight aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
          {urls.length > 1 ? (
            <div className="kc-card-preview-thumbstrip" role="group" aria-label="卡片图片">
              {urls.map((url, position) => {
                const thumbSrc = brokenUrls.has(url) ? item.thumbnailUrl : url;
                return (
                  <button
                    key={url}
                    type="button"
                    className={position === index ? "is-active" : ""}
                    aria-label={`查看第 ${position + 1} 张图`}
                    aria-current={position === index}
                    onClick={() => setIndex(position)}
                  >
                    {thumbSrc ? <img src={thumbSrc} alt="" draggable={false} loading="lazy" onError={() => markBroken(url)} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <aside className="kc-card-preview-info">
          {item.meta.length ? (
            <div className="kc-card-preview-meta">
              {item.meta.map((entry) => (
                <span key={entry.text} title={entry.title}>
                  {entry.icon}
                  {entry.text}
                </span>
              ))}
            </div>
          ) : null}
          <div className="kc-card-preview-prompt-block">
            <span className="kc-card-preview-prompt-label">提示词</span>
            <p className="kc-card-preview-prompt">{item.prompt || "无文字内容"}</p>
          </div>
          <div className="kc-card-preview-actions">
            {actions.map((action) => {
              const busy = Boolean(action.busy);
              const disabled = busy || Boolean(action.disabled) || anyBusy;
              return (
                <button
                  key={action.label}
                  type="button"
                  className={`kc-card-preview-action is-${action.variant}${busy ? " is-busy" : ""}`}
                  disabled={disabled}
                  onClick={action.onAction}
                >
                  {busy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : action.icon}
                  <span>{busy ? action.busyLabel || action.label : action.label}</span>
                </button>
              );
            })}
          </div>
          {item.footerNote ? <span className="kc-card-preview-footnote">{item.footerNote}</span> : null}
        </aside>
      </div>
    </div>,
    document.body,
  );
}
