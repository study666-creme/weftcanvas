import type { MediaKind, ReferenceImagePurpose } from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  initialDirectDraftSession,
  initialDirectReferenceSession,
  writeDirectReferenceSession,
} from "../lib/direct-reference-session";

export type DirectReference = {
  id: string;
  kind: MediaKind;
  name: string;
  previewUrl: string | null;
  serverId: string | null;
  status: "uploading" | "ready" | "error";
  error: string | null;
  uploadKey: string;
  imagePurpose: ReferenceImagePurpose | null;
  // 视频/音频素材的时长（毫秒）。H3 系列要求参考视频成对声明时长
  // （referenceVideoDurations），上传回包里就有这个字段；会话恢复的老数据
  // 没有，由工作台补查一次素材元数据。
  durationMs: number | null;
};

export type DirectModalityKey = "image" | "video";

type DirectReferenceState = {
  references: Record<DirectModalityKey, DirectReference[]>;
  addReferences: (modality: DirectModalityKey, items: DirectReference[]) => void;
  updateReference: (
    modality: DirectModalityKey,
    id: string,
    patch: Partial<DirectReference>,
  ) => void;
  removeReference: (modality: DirectModalityKey, id: string) => void;
  setReferences: (modality: DirectModalityKey, items: DirectReference[]) => void;
};

export const useDirectReferenceStore = create<DirectReferenceState>((set) => ({
  references: initialDirectReferenceSession(),
  addReferences: (modality, items) =>
    set((state) => ({
      references: { ...state.references, [modality]: [...state.references[modality], ...items] },
    })),
  updateReference: (modality, id, patch) =>
    set((state) => ({
      references: {
        ...state.references,
        [modality]: state.references[modality].map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      },
    })),
  removeReference: (modality, id) =>
    set((state) => ({
      references: {
        ...state.references,
        [modality]: state.references[modality].filter((item) => item.id !== id),
      },
    })),
  setReferences: (modality, items) =>
    set((state) => ({
      references: { ...state.references, [modality]: items },
    })),
}));

// 写穿：任何引用变更立即同步到标签页会话存储（仅持久化 ready + serverId），
// 刷新页面与同标签页全页导航后恢复，无需重新上传。
useDirectReferenceStore.subscribe((state) => {
  writeDirectReferenceSession(state.references);
});

// 草稿会话与素材会话共用同一生命周期判定：模块引导时若不在生成工作台
// （返回首页、打开画布、地址栏直达等），立即清空草稿，避免陈旧草稿复活。
initialDirectDraftSession();
