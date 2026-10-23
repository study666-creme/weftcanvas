import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CANVAS_ASSET_DRAG_TYPE,
  hasCanvasAssetDrag,
  resetCanvasAssetDragRegistry,
  startCanvasAssetDrag,
  takeCanvasAssetDrag,
} from "./canvas-asset-drag";
import type { InsertableAsset } from "./insertable-asset";

function createDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "none" as const,
    get types() {
      return [...store.keys()];
    },
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
  };
}

const asset: InsertableAsset = { kind: "text", body: "提示词", media: null, extraMedia: [] };

afterEach(() => {
  resetCanvasAssetDragRegistry();
  vi.useRealTimers();
});

describe("canvas asset drag registry", () => {
  it("marks the drag with the private MIME type and keeps the text fallback", () => {
    const dataTransfer = createDataTransfer();
    startCanvasAssetDrag(dataTransfer, { title: "分镜", load: async () => asset });

    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(dataTransfer.types).toContain(CANVAS_ASSET_DRAG_TYPE);
    expect(dataTransfer.getData("text/plain")).toBe("分镜");
    expect(hasCanvasAssetDrag(dataTransfer)).toBe(true);
  });

  it("returns the registered loader once and removes it afterwards", async () => {
    const dataTransfer = createDataTransfer();
    const load = vi.fn(async () => asset);
    startCanvasAssetDrag(dataTransfer, { title: "分镜", load });

    const payload = takeCanvasAssetDrag(dataTransfer);
    expect(payload).not.toBeNull();
    await expect(payload?.load()).resolves.toEqual(asset);
    expect(load).toHaveBeenCalledTimes(1);
    expect(takeCanvasAssetDrag(dataTransfer)).toBeNull();
  });

  it("ignores drags that carry no registered id", () => {
    expect(takeCanvasAssetDrag(createDataTransfer())).toBeNull();
    expect(hasCanvasAssetDrag(createDataTransfer())).toBe(false);
  });
});
