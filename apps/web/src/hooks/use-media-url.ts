import { useEffect, useState } from "react";
import type { CanvasMedia } from "@kachang/contracts";

import { mediaContentPath } from "../lib/api-client";
import { ensureLocalThumbBlob, thumbLodLevelForZoom, type ThumbLodLevel } from "../lib/local-media-thumb";import { acquireMediaObjectUrl, releaseMediaObjectUrl } from "../lib/media-object-url-cache";
import { readMedia } from "../lib/media-store";
import { useCanvasStore } from "../state/canvas-store";
import { useCloudProjectStore } from "../state/cloud-project-store";

const SERVER_MEDIA_CACHE_GRACE_MS = 250;

export function useMediaUrl(media?: CanvasMedia | null) {
  const projectId = useCanvasStore((state) => state.projectId);
  const cloudLinked = useCloudProjectStore((state) => Boolean(state.links[projectId]));
  return useMediaUrlForProject(media, projectId, cloudLinked);
}

/** 工作台固定项目的缩略变体地址；语义与画布节点的 thumb 展示一致。 */
export function useMediaThumbUrl(media?: CanvasMedia | null) {
  const projectId = useCanvasStore((state) => state.projectId);
  const cloudLinked = useCloudProjectStore((state) => Boolean(state.links[projectId]));
  return useMediaThumbUrlForProject(media, projectId, cloudLinked);
}

/**
 * 画布节点内的图片展示地址：服务器图片且本地 IndexedDB 未命中时，改请求
 * 缩略变体（variant=thumb），节点与小地图显示足够，网络与内存降一个
 * 数量级。本地缓存命中仍用原字节 objectURL（离线零成本）。全屏预览、下载、
 * 落盘等需要原图的调用方不传 variant。
 */
export function useMediaThumbUrlForProject(
  media: CanvasMedia | null | undefined,
  projectId: string,
  cloudLinked: boolean,
) {
  return useMediaUrlForProject(media, projectId, cloudLinked, "thumb");
}

/**
 * 画布节点的多级缩略地址（mipmap 阶梯）：随画布 zoom 取 512/256/128px
 * 档位。缩得越远、同屏节点越多，每张展示位图越小，节点展示的位图内存
 * 随「屏上可见像素」而不是节点数走。zoom 未跨档时 hook 稳定返回同一档，
 * 不产生任何额外请求；跨档时新档位缺失才生成并落盘复用。
 *
 * 服务器远端媒体没有多级变体端点，缩略档位只对本地 IndexedDB 命中的
 * 图片生效；远端仍走 variant=thumb 单级。
 */
export function useMediaLodThumbUrlForProject(
  media: CanvasMedia | null | undefined,
  projectId: string,
  cloudLinked: boolean,
  zoom: number,
) {
  const level = thumbLodLevelForZoom(zoom);
  return useMediaUrlForProject(media, projectId, cloudLinked, level === 1 ? "thumb" : `thumb-${level}`);
}

export function useMediaUrlForProject(
  media: CanvasMedia | null | undefined,
  projectId: string,
  cloudLinked: boolean,
  variant?: "thumb" | `thumb-${ThumbLodLevel}`,
) {  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const remoteMediaId = durableMediaId(media?.serverId)
    ?? (media?.source === "server" ? media.id : null);
  const mediaProjectId = cloudLinked && remoteMediaId && !remoteMediaId.startsWith("phm_")
    ? projectId
    : undefined;

  useEffect(() => {
    let active = true;
    let fallbackTimer: number | null = null;
    // 一旦服务器 fallback 被采用，迟到的 IndexedDB 结果不得再把 URL 改回
    // object URL / 触发二次解码。fallback 只服务于“数据库慢”的瞬时场景。
    let fallbackAdopted = false;
    setUrl(null);
    setMissing(false);
    setLoading(Boolean(media));
    if (!media) return;

    const serverUrl = remoteMediaId
      ? mediaContentPath(remoteMediaId, mediaProjectId, {
        // 远端只有单级缩略端点：多级档位统一请求 thumb。
        variant: variant === "thumb-2" || variant === "thumb-3" ? "thumb" : variant === "thumb-1" ? "thumb" : variant,
      })
      : null;
    const useServerUrl = () => {
      if (!active || !serverUrl) return;
      fallbackAdopted = true;
      setUrl(serverUrl);
      setLoading(false);
    };

    // IndexedDB normally answers in a few milliseconds and gives offline
    // projects their cached result without a network read. A blocked or slow
    // database must not keep a freshly generated server result invisible.
    // 计时从读取真正开始时才启动：媒体可能正排在并发队列里等待，排队时间不该
    // 被误判成「数据库慢」，否则一进画布时队尾的媒体会全部改走网络下载。
    const startGrace = () => {
      if (fallbackTimer !== null || !serverUrl) return;
      fallbackTimer = window.setTimeout(useServerUrl, SERVER_MEDIA_CACHE_GRACE_MS);
    };

    // objectURL 缓存键带上档位：不同档位的 blob 各自独立缓存与引用计数。
    const lodLevel = variant === "thumb-2" ? 2 : variant === "thumb-3" ? 3 : 1;
    const cacheKey = `${media.id}@${lodLevel}`;

    void acquireMediaObjectUrl(
      cacheKey,
      async () => {
        const stored = await readMedia(media.id);
        const blob = stored?.blob ?? null;
        if (!blob) return null;
        // 缩略变体（节点内展示）优先用本地缩略管线：2K 原图直接进 <img> 是
        // 60+ 节点画布位图内存爆炸的主因。缩略缺失时生成一次并落盘复用；
        // 生成失败回退原字节，显示不变。
        if (variant && blob.type.startsWith("image/")) {
          const thumb = await ensureLocalThumbBlob(stored ?? media, blob, lodLevel);
          if (thumb) return thumb;
        }
        return blob;
      },
      startGrace,
    )
      .then((cachedUrl) => {
        if (!active) return;
        if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
        if (fallbackAdopted) return;
        if (!cachedUrl) {
          if (serverUrl) {
            useServerUrl();
            return;
          }
          setMissing(true);
          setLoading(false);
          return;
        }
        setUrl(cachedUrl);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
        if (fallbackAdopted) return;
        if (serverUrl) {
          useServerUrl();
        } else {
          setMissing(true);
          setLoading(false);
        }
      });

    return () => {
      active = false;
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      releaseMediaObjectUrl(cacheKey);
    };
  }, [media?.id, media?.source, mediaProjectId, remoteMediaId, variant]);

  return { url, missing, loading };
}

function durableMediaId(serverId: string | null | undefined) {
  return serverId && !serverId.startsWith("phm_") ? serverId : null;
}
