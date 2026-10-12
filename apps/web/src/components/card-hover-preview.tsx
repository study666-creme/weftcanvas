import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { computeHoverPreviewPlacement } from "../lib/hover-preview-placement";

export {
  computeHoverPreviewPlacement,
  type HoverPreviewPlacement,
} from "../lib/hover-preview-placement";

/**
 * 卡片悬浮大图快览（卡片库 + 社区弹层共用）。
 *
 * 悬停在卡片上时，在鼠标旁边浮出一张完整清晰的大图；移开即消失。点击仍然
 * 打开完整的 CardPreviewLightbox（多图、提示词、操作按钮都在那边）——
 * 悬浮层只是"快速看清楚这张卡"的通道：pointer-events:none 永不拦截交互，
 * 不带任何操作按钮。
 *
 * 位置规则：贴着鼠标右侧出现，右侧放不下就翻到左侧，整体始终被约束在视口内；
 * 高图按可用高度等比缩小，因此不会有一半掉到浏览器外面。
 *
 * 图片策略：缩略图已在网格里加载过，先立即显示（零等待），原图 URL 由
 * 调用方经 resolveImages 异步解析（media-sign 带短缓存），就绪后原位换上；
 * 解析失败或加载失败继续停留在缩略图上。多图卡片只展示封面，翻页属于
 * 点击预览层的能力。
 */

export type CardHoverPreviewSource = {
  key: string;
  title: string;
  thumbnailUrl: string;
  resolveImages: () => Promise<string[]>;
  /** 展示媒体类型，默认 image；视频资产用 <video> 渲染才能出画面。 */
  mediaKind?: "image" | "video";
};

const RESOLVED_CACHE_LIMIT = 64;

/** 首次出现的延迟：扫过一排卡片时不会逐张闪现；开着的层换卡零延迟切换。 */
export const HOVER_PREVIEW_APPEAR_DELAY_MS = 120;

/** 已解析原图的会话内缓存：同一张卡反复悬停不再触发签名请求。 */
const resolvedCache = new Map<string, string>();

export function readHoverPreviewCache(key: string): string {
  return resolvedCache.get(key) ?? "";
}

export function rememberHoverPreviewImage(key: string, url: string): void {
  resolvedCache.set(key, url);
  while (resolvedCache.size > RESOLVED_CACHE_LIMIT) {
    const oldest = resolvedCache.keys().next().value;
    if (oldest === undefined) break;
    resolvedCache.delete(oldest);
  }
}

/** 展示图选择：原图可用且未加载失败时用原图，否则回退缩略图。 */
export function pickHoverPreviewImage(
  largeUrl: string,
  largeBroken: boolean,
  thumbnailUrl: string,
): string {
  return largeUrl && !largeBroken ? largeUrl : thumbnailUrl;
}

export function CardHoverPreview({ source }: { source: CardHoverPreviewSource | null }) {
  // 触屏/无悬停设备上整个能力静默关闭（tap 走点击预览层）。
  const [canHover] = useState(() => window.matchMedia?.("(hover: hover)").matches ?? false);
  const [display, setDisplay] = useState<CardHoverPreviewSource | null>(null);
  const [largeUrl, setLargeUrl] = useState("");
  const [largeBroken, setLargeBroken] = useState(false);
  const [aspect, setAspect] = useState(1);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState(() => readViewportSize());
  const appearTimer = useRef(0);
  const displayRef = useRef<CardHoverPreviewSource | null>(null);
  const latestPointer = useRef<{ x: number; y: number } | null>(null);
  const moveFrame = useRef(0);

  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  // 持续记录鼠标位置：浮层出现时才能立刻贴上去，不用等下一次移动。
  useEffect(() => {
    if (!canHover) return;
    const track = (event: PointerEvent) => {
      latestPointer.current = { x: event.clientX, y: event.clientY };
      if (!displayRef.current || moveFrame.current) return;
      moveFrame.current = window.requestAnimationFrame(() => {
        moveFrame.current = 0;
        if (latestPointer.current) setAnchor(latestPointer.current);
      });
    };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerdown", track, { passive: true });
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", track);
      if (moveFrame.current) window.cancelAnimationFrame(moveFrame.current);
    };
  }, [canHover]);

  useEffect(() => {
    if (!canHover || !source) {
      window.clearTimeout(appearTimer.current);
      setDisplay(null);
      return;
    }
    setLargeBroken(false);
    // 缓存命中直接以原图开场；未命中先落缩略图，解析就绪后原位升级。
    setLargeUrl(readHoverPreviewCache(source.key));
    if (display) {
      setDisplay(source);
      return;
    }
    window.clearTimeout(appearTimer.current);
    appearTimer.current = window.setTimeout(
      () => setDisplay(source),
      HOVER_PREVIEW_APPEAR_DELAY_MS,
    );
    return () => window.clearTimeout(appearTimer.current);
    // display 是"是否已有层在展示"的读数，刻意不进依赖：换卡时以当次渲染
    // 的快照判断即可，语义等价且避免每次换卡重排 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canHover, source]);

  // 浮层出现时贴到当前鼠标位置；视口尺寸变化时重新收进屏幕内。
  useEffect(() => {
    if (!display) {
      setAnchor(null);
      return;
    }
    setAnchor(latestPointer.current);
    setViewport(readViewportSize());
    const onResize = () =>
      setViewport((current) => {
        const next = readViewportSize();
        return current.width === next.width && current.height === next.height ? current : next;
      });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [display]);

  useEffect(() => {
    if (!display) return;
    const cached = readHoverPreviewCache(display.key);
    if (cached) {
      setLargeUrl(cached);
      return;
    }
    setLargeUrl("");
    let stale = false;
    void display
      .resolveImages()
      .then((urls) => {
        if (stale) return;
        const first = urls.find((url) => url);
        if (!first) return;
        rememberHoverPreviewImage(display.key, first);
        setLargeUrl(first);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [display]);

  const placement = useMemo(
    () =>
      computeHoverPreviewPlacement({
        anchor: anchor ?? { x: viewport.width / 2, y: viewport.height / 2 },
        viewport,
        aspect,
        hasCaption: Boolean(display?.title),
      }),
    [anchor, viewport, aspect, display?.title],
  );

  if (!canHover || !display) return null;
  const shown = pickHoverPreviewImage(largeUrl, largeBroken, display.thumbnailUrl);
  const isVideo = display.mediaKind === "video";
  return createPortal(
    <figure
      className="wc-card-hover-preview"
      aria-hidden="true"
      style={{
        left: placement.left,
        top: placement.top,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
    >
      {shown ? (
        isVideo ? (
          <video
            key={shown}
            src={shown}
            muted
            autoPlay
            loop
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              const node = event.currentTarget;
              if (node.videoWidth > 0 && node.videoHeight > 0) {
                setAspect(node.videoWidth / node.videoHeight);
              }
            }}
            onError={() => {
              if (shown === largeUrl) setLargeBroken(true);
            }}
          />
        ) : (
          <img
            key={shown}
            src={shown}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={(event) => {
              const node = event.currentTarget;
              if (node.naturalWidth > 0 && node.naturalHeight > 0) {
                setAspect(node.naturalWidth / node.naturalHeight);
              }
            }}
            onError={() => {
              if (shown === largeUrl) setLargeBroken(true);
            }}
          />
        )
      ) : null}
      {display.title ? <figcaption>{display.title}</figcaption> : null}
    </figure>,
    document.body,
  );
}

function readViewportSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}
