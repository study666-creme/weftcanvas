import type { CanvasMedia } from "@kachang/contracts";

import { mediaContentPath } from "./api-client";

const PROBE_TIMEOUT_MS = 15_000;

/**
 * 画布上新生成的视频工件在完成时不带时长：服务端只在内容被播放/下载（归档
 * 路径）时才探测并回写到任务工件上，而那次回写不会回流到本地节点，节点快照里
 * 的 durationMs 一直是 null。后果是参考视频时长参数发不出去、15 秒上限校验
 * 失效、按秒计费的预估缺一块。
 *
 * 这里按需探测一次内容路径（与节点预览同一个地址，只读元数据），把时长补回
 * 节点素材。探测本身也是一次内容读取，会顺带触发服务端归档回写，让后续的
 * 服务端推导也有据可查。
 */
export function probeServerMediaDurationMs(media: CanvasMedia): Promise<number | null> {
  const remoteId = media.serverId ?? (media.source === "server" ? media.id : null);
  if (typeof document === "undefined" || !remoteId) return Promise.resolve(null);
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
    };
    const finish = (durationMs: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(durationMs);
    };
    const timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const durationMs = Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration * 1000)
        : null;
      finish(durationMs);
    };
    video.onerror = () => finish(null);
    // 与节点预览一致：生成结果（phm_*）不带 projectId。
    video.src = mediaContentPath(remoteId);
  });
}
