import {
  AGENT_MESSAGE_ATTACHMENT_LIMITS,
  type AgentMessageAttachmentInput,
  type CanvasMedia,
} from "@weftcanvas/contracts";

import { mediaContentPath } from "./api-client";
import { mediaKind } from "./media-kind";
import { readMedia } from "./media-store";

const MAX_IMAGE_EDGE = 1280;
const PREVIEW_EDGE = 160;
const IMAGE_QUALITY = 0.82;
const PREVIEW_QUALITY = 0.7;

/**
 * Agent 参考素材走 data URL 而不是 URL：运行时没有用户会话，也拿不到浏览器
 * 的 object URL。图片在浏览器里先缩放再编码，既避开 API 的 1MB 请求体上限，
 * 也避免把 25MB 原图塞给模型。视频统一取首帧——主流 OpenAI 兼容对话接口
 * 不收视频字节，首帧是当前唯一可靠、可解释的多模态输入。
 */
export async function createAgentAttachmentFromFile(
  file: File,
): Promise<AgentMessageAttachmentInput> {
  const blob = file instanceof Blob ? file : new Blob([file]);
  if (blob.type.startsWith("image/")) {
    const image = await readImageSource(blob);
    try {
      const dataUrl = await encodeImage(image, MAX_IMAGE_EDGE, IMAGE_QUALITY);
      const previewUrl = await encodeImage(image, PREVIEW_EDGE, PREVIEW_QUALITY);
      return {
        id: `paste-${createAttachmentId()}`,
        kind: "image",
        name: boundedName(file.name, "粘贴的图片"),
        mimeType: "image/jpeg",
        width: image.width,
        height: image.height,
        durationMs: null,
        dataUrl,
        previewUrl,
      };
    } finally {
      image.close?.();
    }
  }
  if (blob.type.startsWith("video/")) {
    const frame = await readVideoFrame(blob);
    const dataUrl = await encodeImage(frame.image, MAX_IMAGE_EDGE, IMAGE_QUALITY);
    const previewUrl = await encodeImage(frame.image, PREVIEW_EDGE, PREVIEW_QUALITY);
    return {
      id: `paste-${createAttachmentId()}`,
      kind: "video",
      name: boundedName(file.name, "粘贴的视频"),
      mimeType: "image/jpeg",
      width: frame.image.width,
      height: frame.image.height,
      durationMs: frame.durationMs,
      dataUrl,
      previewUrl,
    };
  }
  throw new Error("只支持图片和视频参考");
}

/** 画布节点 / 素材库条目 → 本轮 Agent 参考素材。读不到字节时返回 null。 */
export async function createAgentAttachmentFromMedia(
  media: CanvasMedia,
  options: { projectId: string; cloudLinked: boolean; nodeId?: string },
): Promise<AgentMessageAttachmentInput | null> {
  const kind = mediaKind(media.mimeType);
  if (kind !== "image" && kind !== "video") return null;
  const blob = await readMediaBlob(media, options);
  if (!blob) return null;
  const file = new File([blob], media.name, { type: media.mimeType || blob.type });
  const attachment = await createAgentAttachmentFromFile(file);
  return {
    ...attachment,
    id: `media-${media.id}`,
    name: boundedName(media.name, attachment.name),
    width: attachment.width ?? media.width,
    height: attachment.height ?? media.height,
    durationMs: attachment.durationMs ?? media.durationMs,
    ...(options.nodeId ? { nodeId: options.nodeId } : {}),
  };
}

export function totalAttachmentDataUrlChars(
  attachments: ReadonlyArray<Pick<AgentMessageAttachmentInput, "dataUrl">>,
) {
  return attachments.reduce((sum, attachment) => sum + attachment.dataUrl.length, 0);
}

/** 发送前的统一闸门：条数与总字节一起卡，避免超限请求到服务端才报错。 */
export function assertAgentAttachmentsWithinLimits(
  attachments: ReadonlyArray<Pick<AgentMessageAttachmentInput, "dataUrl">>,
) {
  if (attachments.length > AGENT_MESSAGE_ATTACHMENT_LIMITS.maxPerMessage) {
    throw new Error(`最多附加 ${AGENT_MESSAGE_ATTACHMENT_LIMITS.maxPerMessage} 个参考素材`);
  }
  if (
    totalAttachmentDataUrlChars(attachments) > AGENT_MESSAGE_ATTACHMENT_LIMITS.maxTotalDataUrlChars
  ) {
    throw new Error("参考素材总大小过大，请减少数量或换一张更小的图");
  }
}

async function readMediaBlob(
  media: CanvasMedia,
  options: { projectId: string; cloudLinked: boolean },
): Promise<Blob | null> {
  const local = await readMedia(media.id).catch(() => null);
  if (local?.blob) return local.blob;
  const remoteId = media.serverId ?? (media.source === "server" ? media.id : null);
  if (!remoteId) return null;
  const projectId =
    options.cloudLinked && !remoteId.startsWith("phm_") ? options.projectId : undefined;
  const response = await fetch(mediaContentPath(remoteId, projectId), {
    credentials: "same-origin",
  }).catch(() => null);
  if (!response?.ok) return null;
  return response.blob();
}

type ImageSource = { source: CanvasImageSource; width: number; height: number; close?: () => void };

async function readImageSource(blob: Blob): Promise<ImageSource> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }
  const image = await loadImageElement(blob);
  return { source: image, width: image.naturalWidth, height: image.naturalHeight };
}

async function readVideoFrame(
  blob: Blob,
): Promise<{ image: ImageSource; durationMs: number | null }> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("视频解码失败"));
    });
    const durationMs =
      Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration * 1000)
        : null;
    const target = Math.min(0.2, Math.max(0, (video.duration || 1) / 2));
    if (target > 0 && Math.abs(video.currentTime - target) > 0.01) {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("视频解码失败"));
        video.currentTime = target;
      });
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 405;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法读取视频画面");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return {
      image: { source: canvas, width: canvas.width, height: canvas.height },
      durationMs,
    };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
  }
}

async function encodeImage(image: ImageSource, maxEdge: number, quality: number) {
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法编码参考图");
  context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  // 长边并不总能压到请求上限内（噪点/细节多的图），逐档收紧再放弃。
  for (const fallback of [
    { edge: 960, quality: 0.74 },
    { edge: 720, quality: 0.68 },
  ]) {
    if (dataUrl.length <= AGENT_MESSAGE_ATTACHMENT_LIMITS.maxDataUrlChars) break;
    const next = document.createElement("canvas");
    const nextScale = Math.min(1, fallback.edge / Math.max(image.width, image.height));
    next.width = Math.max(1, Math.round(image.width * nextScale));
    next.height = Math.max(1, Math.round(image.height * nextScale));
    const nextContext = next.getContext("2d", { alpha: false });
    if (!nextContext) break;
    nextContext.drawImage(image.source, 0, 0, next.width, next.height);
    dataUrl = next.toDataURL("image/jpeg", fallback.quality);
  }
  if (dataUrl.length > AGENT_MESSAGE_ATTACHMENT_LIMITS.maxDataUrlChars) {
    throw new Error("这张图压缩后仍然过大，请换一张更小的图");
  }
  return dataUrl;
}

function loadImageElement(blob: Blob) {
  const url = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败"));
    };
    image.src = url;
  });
}

function boundedName(value: string, fallback: string) {
  const name = value.trim() || fallback;
  return name.length <= 128 ? name : name.slice(0, 128);
}

function createAttachmentId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
