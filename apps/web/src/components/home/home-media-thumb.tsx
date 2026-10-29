import { memo, useEffect, useRef, useState } from "react";
import type { CanvasMedia } from "@weftcanvas/contracts";
import { AudioLines, ImageOff, Play } from "lucide-react";

import { mediaContentPath } from "../../lib/api-client";
import { formatDuration, type HomeWorkKind } from "../../lib/home-data";
import { ensureLocalThumbBlob } from "../../lib/local-media-thumb";
import { MEDIA_STORE_NAME, openMediaDatabase } from "../../lib/media-database";
import { acquireMediaObjectUrl, releaseMediaObjectUrl } from "../../lib/media-object-url-cache";

type StoredMediaRecord = CanvasMedia & { blob?: Blob };

/** 直接读媒体库（不经 media-store，避免把项目库/资产库/上传链路拉进主页分包）。 */
async function readStoredMedia(id: string) {
  if (typeof indexedDB === "undefined") return null;
  const database = await openMediaDatabase();
  return new Promise<StoredMediaRecord | null>((resolve, reject) => {
    const request = database
      .transaction(MEDIA_STORE_NAME, "readonly")
      .objectStore(MEDIA_STORE_NAME)
      .get(id);
    request.onsuccess = () => resolve((request.result as StoredMediaRecord | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("媒体读取失败"));
  });
}

function remoteMediaId(media: CanvasMedia) {
  const durable = media.serverId && !media.serverId.startsWith("phm_") ? media.serverId : null;
  return durable ?? (media.source === "server" ? media.id : null);
}

export type HomeMediaState = "idle" | "loading" | "ready" | "missing";

/**
 * 主页媒体地址：本地 IndexedDB 优先（objectURL 引用计数与画布共享），未命中再回落
 * 同源受保护的服务端地址。`thumb` 时图片走画布同款 L1 缩略缓存（`<mediaId>@1`），
 * 缩略字节落盘复用；预览大图时取原始字节。音频不读字节（用播放器时才需要地址）。
 */
export function useHomeMediaSource(
  media: CanvasMedia | null,
  kind: HomeWorkKind | null,
  { thumb, enabled = true }: { thumb: boolean; enabled?: boolean },
) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<HomeMediaState>("idle");
  const wantsBytes = Boolean(media && kind && enabled && !(thumb && kind === "audio"));

  useEffect(() => {
    if (!wantsBytes || !media || !kind) {
      setUrl(null);
      setState("idle");
      return;
    }
    let active = true;
    const thumbImage = thumb && kind === "image";
    const cacheKey = thumbImage ? `${media.id}@1` : media.id;
    const remoteId = remoteMediaId(media);
    const serverUrl = remoteId
      ? mediaContentPath(remoteId, undefined, thumbImage ? { variant: "thumb" } : undefined)
      : null;
    setState("loading");
    setUrl(null);
    void acquireMediaObjectUrl(cacheKey, async () => {
      const stored = await readStoredMedia(media.id);
      const blob = stored?.blob ?? null;
      if (!blob) return null;
      if (thumbImage) {
        const small = await ensureLocalThumbBlob(stored ?? media, blob, 1);
        if (small) return small;
      }
      return blob;
    })
      .then((objectUrl) => {
        if (!active) return;
        const next = objectUrl ?? serverUrl;
        setUrl(next);
        setState(next ? "ready" : "missing");
      })
      .catch(() => {
        if (!active) return;
        setUrl(serverUrl);
        setState(serverUrl ? "ready" : "missing");
      });
    return () => {
      active = false;
      releaseMediaObjectUrl(cacheKey);
    };
    // media 对象每次渲染可能是新引用，按身份字段订阅即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsBytes, kind, thumb, media?.id, media?.serverId, media?.source]);

  return { url, state, markMissing: () => setState("missing") };
}

/**
 * 主页缩略图：进入视口才读取；视频悬停才播放，音频只画波形图标——
 * 主页不解码任何不可见的媒体。
 */
export const HomeMediaThumb = memo(function HomeMediaThumb({
  media,
  kind,
  alt = "",
  eager = false,
  hoverPlay = true,
  showBadge = true,
}: {
  media: CanvasMedia;
  kind: HomeWorkKind;
  alt?: string;
  eager?: boolean;
  hoverPlay?: boolean;
  showBadge?: boolean;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(eager);
  const { url, state, markMissing } = useHomeMediaSource(media, kind, {
    thumb: true,
    enabled: visible,
  });

  useEffect(() => {
    if (visible) return;
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [visible]);

  const duration = formatDuration(media.durationMs);

  const startPreview = () => {
    const video = videoRef.current;
    if (!hoverPlay || !video) return;
    void video.play().catch(() => undefined);
  };
  const stopPreview = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    try {
      video.currentTime = 0;
    } catch {
      // 元数据未就绪时重置时间会抛错，忽略即可。
    }
  };

  return (
    <span
      ref={hostRef}
      className={`wc-home-thumb is-${kind} is-${kind === "audio" ? "ready" : state}`}
      onPointerEnter={kind === "video" ? startPreview : undefined}
      onPointerLeave={kind === "video" ? stopPreview : undefined}
    >
      {kind === "audio" ? (
        <span className="wc-home-thumb-audio" aria-hidden="true">
          <AudioLines />
        </span>
      ) : state === "missing" ? (
        <span className="wc-home-thumb-missing" title="素材在当前浏览器里不可用">
          <ImageOff aria-hidden="true" />
        </span>
      ) : url && kind === "image" ? (
        <img
          src={url}
          alt={alt}
          decoding="async"
          loading="lazy"
          draggable={false}
          onError={markMissing}
        />
      ) : url && kind === "video" ? (
        <video
          ref={videoRef}
          src={url}
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={alt || undefined}
          onError={markMissing}
        />
      ) : null}
      {showBadge && kind !== "image" ? (
        <span className="wc-home-thumb-badge" aria-hidden="true">
          {kind === "video" ? <Play /> : <AudioLines />}
          {duration ? <span>{duration}</span> : null}
        </span>
      ) : null}
    </span>
  );
});
