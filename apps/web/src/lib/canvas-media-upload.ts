import type { CanvasMedia } from "@weftcanvas/contracts";

import { storeMedia, uploadMediaToServer } from "./media-store";
import { useCanvasStore } from "../state/canvas-store";
import { useCloudProjectStore } from "../state/cloud-project-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";

export type CanvasUploadKind = "image" | "video" | "audio";

export const canvasUploadKindLabels: Record<CanvasUploadKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

/**
 * 当前画布若已挂到云端项目，上传就落在这个项目作用域里。
 *
 * 服务端读取素材时，带 projectId 的访问只认已绑定到该项目的素材；画布上传
 * 过去不带 projectId，素材是「无项目」的未绑定记录。节点回显会带 projectId
 * 去读，于是先 404（界面报「结果加载失败」），要等自动保存把原图取回、再按
 * 项目重传一遍才恢复。对上传方立刻绑定项目，回显就不再走这段弯路。
 *
 * 本地项目还没有云端作用域，仍按账号上传，等保存到云端时再绑定。
 */
function currentCloudProjectId(): string | undefined {
  const projectId = useCanvasStore.getState().projectId;
  if (!projectId) return undefined;
  return useCloudProjectStore.getState().links[projectId] ? projectId : undefined;
}

/**
 * 画布上传的唯一入口，拖入 / 粘贴 / 工具栏导入与节点「上传素材」共用同一条：
 * - 打开「只保存本地」时只写浏览器媒体库，绝不发云端请求；
 * - 否则先直传服务端（元数据进数据库、字节进对象存储，跨设备可见），
 *   服务端不可用时回退本机媒体库。
 *
 * 两条路都用各自的校验报真实原因：文件内容非法、解码失败、超出体积上限
 * 会原样抛出，不会被"回退"掩盖成另一种错误。
 */
export async function uploadCanvasFile(file: File, kind: CanvasUploadKind): Promise<CanvasMedia> {
  if (useUiPreferencesStore.getState().localMediaOnly) return storeMedia(file, kind);
  try {
    return await uploadMediaToServer(file, kind, currentCloudProjectId());
  } catch (serverError) {
    console.warn("[canvas] 云端上传失败，回退本机媒体库", file.name, serverError);
    return storeMedia(file, kind);
  }
}
