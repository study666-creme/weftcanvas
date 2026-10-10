/**
 * MediaPipe Tasks Vision 的自托管资源入口。
 *
 * 运行时（约 21MB wasm）与人脸网格（人脸检测）的 .tflite 模型都在
 * `public/mediapipe/`，不引用外部 CDN。模型按任务分目录：
 * `mediapipe/models/<task>.tflite`。
 */

export const MEDIAPIPE_BASE_PATH = "mediapipe";

type MediapipeVisionModule = typeof import("@mediapipe/tasks-vision");

let visionModulePromise: Promise<MediapipeVisionModule> | null = null;

/** 动态 import 只做一次：任务运行时（含 wasm 加载器）在页面里是共享的。 */
export function loadMediapipeVision(): Promise<MediapipeVisionModule> {
  visionModulePromise ??= import("@mediapipe/tasks-vision");
  return visionModulePromise;
}

export function mediapipeAssetUrl(relativePath: string): string {
  if (typeof document === "undefined") return `/${MEDIAPIPE_BASE_PATH}/${relativePath}`;
  return new URL(`${MEDIAPIPE_BASE_PATH}/${relativePath}`, document.baseURI).toString();
}

export function normalizeMediapipeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export type MediapipeFileset = {
  wasmLoaderPath: string;
  wasmBinaryPath: string;
};

/**
 * 解析 wasm 文件集：优先 SIMD 版本，检测失败时按支持处理（与 face-grid 一致）。
 */
export async function resolveMediapipeFileset(wasmBaseUrl?: string): Promise<MediapipeFileset> {
  const { FilesetResolver } = await loadMediapipeVision();
  const base = normalizeMediapipeBaseUrl(wasmBaseUrl ?? mediapipeAssetUrl("wasm/"));
  const simd = await FilesetResolver.isSimdSupported().catch(() => true);
  const suffix = simd ? "" : "_nosimd";
  return {
    wasmLoaderPath: `${base}vision_wasm${suffix}_internal.js`,
    wasmBinaryPath: `${base}vision_wasm${suffix}_internal.wasm`,
  };
}

export function blazeFaceModelUrl(): string {
  return mediapipeAssetUrl("models/blaze_face_short_range.tflite");
}
