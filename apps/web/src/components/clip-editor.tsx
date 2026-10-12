import type { CanvasEditClip, CanvasNodeData } from "@weftcanvas/contracts";
import {
  ChevronLeft,
  Clapperboard,
  Layers,
  LoaderCircle,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import "./clip-editor.css";
import { readCachedAudioPeaks, loadAudioPeaks, type AudioPeaks } from "../lib/audio-peaks";
import { useMediaThumbUrlForProject, useMediaUrlForProject } from "../hooks/use-media-url";
import { ClipMediaPool } from "../lib/clip-media-pool";
import {
  activeClipAt,
  buildClipFromAsset,
  clipDurationMs,
  clipStartMs,
  clipTimelineStart,
  collectEditAssets,
  compositionDurationMs,
  formatTimecode,
  probeMediaDuration,
  removeClip,
  reorderClipInTrack,
  setClipRange,
  trackClips,
  type EditAsset,
} from "../lib/clip-composition";
import { requestConfirmation } from "../lib/confirmation";
import { removeMedia, storeMedia } from "../lib/media-store";
import { useCanvasStore } from "../state/canvas-store";
import { useToastStore } from "../state/toast-store";

/** 时间线像素密度：每秒像素数（默认档）。 */
const TIMELINE_PX_PER_SECOND = 48;
/** 可切换的时间线缩放档位，覆盖 0.25x ~ 8x 默认密度。 */
const TIMELINE_ZOOM_STEPS = [12, 24, 36, 48, 72, 96, 144, 216, 320] as const;
const MIN_TIMELINE_ZOOM = TIMELINE_ZOOM_STEPS[0] ?? 12;
const MAX_TIMELINE_ZOOM = TIMELINE_ZOOM_STEPS[TIMELINE_ZOOM_STEPS.length - 1] ?? 320;

/** 按档位表上下移动一格缩放；当前值不在表内时回落到默认档。 */
function nextZoomStep(current: number, direction: 1 | -1) {
  const index = TIMELINE_ZOOM_STEPS.indexOf(current as (typeof TIMELINE_ZOOM_STEPS)[number]);
  const base = index < 0 ? TIMELINE_ZOOM_STEPS.indexOf(TIMELINE_PX_PER_SECOND) : index;
  const next =
    TIMELINE_ZOOM_STEPS[Math.min(TIMELINE_ZOOM_STEPS.length - 1, Math.max(0, base + direction))];
  return next ?? TIMELINE_PX_PER_SECOND;
}
/** 导出画布尺寸（16:9）。 */
const EXPORT_WIDTH = 1280;
const EXPORT_HEIGHT = 720;

const kindLabels = {
  video: "视频",
  image: "图片",
  audio: "音频",
} as const;

function formatDurationMs(durationMs: number | null) {
  return durationMs === null ? "未计量" : formatTimecode(durationMs);
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
) {
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(
    source,
    (canvas.width - drawWidth) / 2,
    (canvas.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function resolveMediaUrl(assetUrls: Readonly<Record<string, string | null>>, mediaId: string) {
  return assetUrls[mediaId] ?? null;
}

export type ClipEditorHostProps = {
  nodeId: string;
  data: CanvasNodeData;
  projectId: string;
  cloudLinked: boolean;
  onClose: () => void;
};

export const ClipEditorHost = memo(function ClipEditorHost({
  nodeId,
  data,
  projectId,
  cloudLinked,
  onClose,
}: ClipEditorHostProps) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const showToast = useToastStore((state) => state.show);
  const [clips, setClips] = useState<CanvasEditClip[]>(() => data.edit?.clips ?? []);
  const [assetUrls, setAssetUrls] = useState<Record<string, string | null>>({});
  const [timelineMs, setTimelineMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  /** 当前帧的素材还没解码出来（预览区显示"缓冲中"而不是黑屏）。 */
  const [buffering, setBuffering] = useState(false);
  /** 时间线缩放：每秒像素数，长视频可以放大到逐帧级刻度。 */
  const [pxPerSecond, setPxPerSecond] = useState<number>(TIMELINE_PX_PER_SECOND);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaHostRef = useRef<HTMLDivElement | null>(null);
  const poolRef = useRef<ClipMediaPool | null>(null);

  const clipsRef = useRef(clips);
  const assetUrlsRef = useRef(assetUrls);
  const timelineMsRef = useRef(0);
  const playingRef = useRef(false);
  const exportingRef = useRef(false);
  const playbackBaseRef = useRef({ startedAt: 0, fromMs: 0 });
  /** 画布上是否已有画面：缓冲时保留上一帧，避免整块黑屏闪一下。 */
  const hasFrameRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  const exportProgressShownRef = useRef(-1);
  /** AudioContext 与元素一一对应，只能在同一 context 内复用，故随编辑器常驻。 */
  const exportAudioContextRef = useRef<AudioContext | null>(null);
  const exportAudioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const exportAudioSourcesRef = useRef<WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>>(
    new WeakMap(),
  );

  clipsRef.current = clips;
  assetUrlsRef.current = assetUrls;
  timelineMsRef.current = timelineMs;
  playingRef.current = playing;
  exportingRef.current = exporting;

  const assets = useMemo(() => collectEditAssets(nodes, edges, nodeId), [edges, nodeId, nodes]);
  const totalMs = useMemo(() => compositionDurationMs(clips), [clips]);

  const persistClips = useCallback(
    (next: CanvasEditClip[]) => {
      if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = window.setTimeout(() => {
        persistTimerRef.current = null;
        useCanvasStore.getState().updateNodeData(nodeId, { edit: { clips: next } }, false);
      }, 420);
    },
    [nodeId],
  );

  const onMediaUrl = useCallback((mediaId: string, url: string | null) => {
    setAssetUrls((previous) =>
      previous[mediaId] === url ? previous : { ...previous, [mediaId]: url },
    );
  }, []);

  const applyClips = useCallback(
    (next: CanvasEditClip[], persist = true) => {
      setClips(next);
      if (persist) persistClips(next);
    },
    [persistClips],
  );

  /** 合成当前帧（预览与导出共用）。 */
  const paint = useCallback((t: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const pool = poolRef.current;
    if (!canvas || !ctx) return;
    const simulatePlayback = playingRef.current || exportingRef.current;

    const videoTrack = trackClips(clipsRef.current, "video");
    const audioTrack = trackClips(clipsRef.current, "audio");
    const active = activeClipAt(videoTrack, t);
    const activeAudio = activeClipAt(audioTrack, t);
    let drawn = false;

    if (active && pool) {
      const sourceTime = active.clip.inMs + (t - active.startMs);
      const url = resolveMediaUrl(assetUrlsRef.current, active.clip.mediaId);
      const kind = active.clip.kind === "image" ? "image" : "video";
      const handle = url ? pool.ensure(active.clip.mediaId, kind, url) : null;
      if (handle?.ready) {
        if (kind === "video") {
          const videoEl = handle.element as HTMLVideoElement;
          const target = sourceTime / 1000;
          if (simulatePlayback) {
            if (Math.abs(videoEl.currentTime - target) > 0.3) videoEl.currentTime = target;
            if (videoEl.paused) void videoEl.play().catch(() => {});
          } else if (Math.abs(videoEl.currentTime - target) > 0.05 && !videoEl.seeking) {
            videoEl.currentTime = target;
          }
          if (!videoEl.seeking && videoEl.videoWidth > 0) {
            drawCover(ctx, canvas, videoEl, videoEl.videoWidth, videoEl.videoHeight);
            drawn = true;
          }
        } else {
          const imageEl = handle.element as HTMLImageElement;
          if (imageEl.naturalWidth > 0) {
            drawCover(ctx, canvas, imageEl, imageEl.naturalWidth, imageEl.naturalHeight);
            drawn = true;
          }
        }
      }
    }

    if (activeAudio && pool) {
      const sourceTime = activeAudio.clip.inMs + (t - activeAudio.startMs);
      const url = resolveMediaUrl(assetUrlsRef.current, activeAudio.clip.mediaId);
      const handle = url ? pool.ensure(activeAudio.clip.mediaId, "audio", url) : null;
      if (handle?.ready) {
        const audioEl = handle.element as HTMLAudioElement;
        const target = sourceTime / 1000;
        if (simulatePlayback) {
          if (Math.abs(audioEl.currentTime - target) > 0.3) audioEl.currentTime = target;
          if (audioEl.paused) void audioEl.play().catch(() => {});
        } else if (Math.abs(audioEl.currentTime - target) > 0.05 && !audioEl.seeking) {
          audioEl.currentTime = target;
        }
      }
    }

    // 不在时间线上的元素一律暂停，避免切段后旧素材继续出声。
    pool?.pauseExcept(
      [active?.clip.mediaId, activeAudio?.clip.mediaId].filter((id): id is string => Boolean(id)),
    );

    if (drawn) {
      hasFrameRef.current = true;
    } else if (!active || !hasFrameRef.current) {
      // 空隙与片尾铺黑底；素材还在解码时保留上一帧，避免"按空格先黑一下"。
      ctx.fillStyle = "#0b0c0b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      hasFrameRef.current = false;
    }
    setBuffering(Boolean(active) && !drawn);
  }, []);

  const renderFrame = useCallback(
    (t: number) => {
      timelineMsRef.current = t;
      setTimelineMs(t);
      paint(t);
    },
    [paint],
  );

  const seekTo = useCallback(
    (t: number, play = false) => {
      const clamped = Math.max(0, Math.min(t, compositionDurationMs(clipsRef.current)));
      if (play) {
        playbackBaseRef.current = { startedAt: performance.now(), fromMs: clamped };
        setPlaying(true);
      } else {
        setPlaying(false);
        poolRef.current?.pauseExcept([]);
        renderFrame(clamped);
      }
    },
    [renderFrame],
  );

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (!playingRef.current) return;
      const base = playbackBaseRef.current;
      const next = base.fromMs + (performance.now() - base.startedAt);
      const total = compositionDurationMs(clipsRef.current);
      if (next >= total) {
        renderFrame(total);
        setPlaying(false);
        poolRef.current?.pauseExcept([]);
        return;
      }
      renderFrame(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, renderFrame]);

  // 媒体元素池随工作台挂载；素材解码完成时立刻重画当前帧，
  // 不需要等鼠标移动或下一次 rAF 才出画面。
  useEffect(() => {
    const host = mediaHostRef.current;
    if (!host) return;
    const pool = new ClipMediaPool(host);
    poolRef.current = pool;
    const unsubscribe = pool.subscribe((mediaId) => {
      const t = timelineMsRef.current;
      const activeId = activeClipAt(trackClips(clipsRef.current, "video"), t)?.clip.mediaId;
      if (mediaId === activeId) paint(t);
    });
    return () => {
      unsubscribe();
      pool.dispose();
      poolRef.current = null;
      hasFrameRef.current = false;
      exportAudioDestinationRef.current = null;
      const context = exportAudioContextRef.current;
      exportAudioContextRef.current = null;
      if (context) void context.close().catch(() => {});
    };
  }, [paint]);

  // 时间线一变化就预取素材：打开工作台后浏览器即开始拉流解码，
  // 按空格播放不必再等网络与首帧解码。
  useEffect(() => {
    const pool = poolRef.current;
    if (!pool) return;
    const keep = new Set<string>();
    for (const clip of clips) {
      const url = resolveMediaUrl(assetUrls, clip.mediaId);
      if (!url) continue;
      keep.add(clip.mediaId);
      pool.ensure(clip.mediaId, clip.kind, url);
    }
    pool.prune(keep);
  }, [clips, assetUrls]);

  // 合成变化 / 素材地址就绪后重画当前帧
  useEffect(() => {
    paint(timelineMsRef.current);
  }, [clips, assetUrls, paint]);

  // 裁剪导致总时长变短时收回播放头
  useEffect(() => {
    if (totalMs <= 0) {
      if (timelineMsRef.current > 0) renderFrame(0);
      return;
    }
    if (timelineMsRef.current > totalMs) renderFrame(totalMs);
  }, [totalMs, renderFrame]);

  // 编辑器卸载前把未落盘的合成补写回去
  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        useCanvasStore
          .getState()
          .updateNodeData(nodeId, { edit: { clips: clipsRef.current } }, false);
      }
    },
    [nodeId],
  );

  const togglePlay = useCallback(() => {
    if (exportingRef.current) return;
    if (playingRef.current) {
      setPlaying(false);
      poolRef.current?.pauseExcept([]);
      return;
    }
    const total = compositionDurationMs(clipsRef.current);
    if (total <= 0) {
      showToast("时间线还是空的，先加入素材再播放", "error");
      return;
    }
    const from = timelineMsRef.current >= total ? 0 : timelineMsRef.current;
    setSelectedClipId(null);
    playbackBaseRef.current = { startedAt: performance.now(), fromMs: from };
    renderFrame(from);
    setPlaying(true);
  }, [renderFrame, showToast]);

  const addAsset = useCallback(
    async (asset: EditAsset) => {
      const url = resolveMediaUrl(assetUrlsRef.current, asset.media.id);
      if (!url) {
        showToast("素材仍在加载中，请稍后再试", "error");
        return;
      }
      let durationMs = asset.media.durationMs ?? null;
      if (asset.kind !== "image" && durationMs === null) {
        durationMs = await probeMediaDuration(url, asset.kind);
      }
      const clip = buildClipFromAsset(asset, durationMs);
      const next = [...clipsRef.current, clip];
      applyClips(next);
      seekTo(clipTimelineStart(next, clip.id));
      showToast(`${clip.name} 已加入${clip.track === "audio" ? "音频轨" : "时间线"}`, "success");
    },
    [applyClips, seekTo, showToast],
  );

  const trimClip = useCallback(
    (clipId: string, range: { inMs?: number; outMs?: number }) => {
      const current = clipsRef.current.find((clip) => clip.id === clipId);
      if (!current) return;
      const nextClip = setClipRange(current, range);
      applyClips(
        clipsRef.current.map((clip) => (clip.id === clipId ? nextClip : clip)),
        false,
      );
    },
    [applyClips],
  );

  const commitTrim = useCallback(() => {
    persistClips(clipsRef.current);
  }, [persistClips]);

  const reorderClip = useCallback(
    (clipId: string, trackIndex: number) => {
      const next = reorderClipInTrack(clipsRef.current, clipId, trackIndex);
      applyClips(next);
    },
    [applyClips],
  );

  const deleteClip = useCallback(
    (clipId: string) => {
      applyClips(removeClip(clipsRef.current, clipId));
      setSelectedClipId(null);
    },
    [applyClips],
  );

  const clearTimeline = useCallback(async () => {
    if (!clipsRef.current.length || exportingRef.current) return;
    const accepted = await requestConfirmation({
      title: "清空时间线",
      description: "将移除全部剪辑片段，素材节点本身不会受影响。",
      confirmLabel: "清空",
      tone: "danger",
    });
    if (!accepted) return;
    applyClips([]);
    setSelectedClipId(null);
    renderFrame(0);
  }, [applyClips, renderFrame]);

  const close = useCallback(() => {
    if (exportingRef.current) {
      showToast("导出进行中，稍等片刻", "error");
      return;
    }
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
      useCanvasStore
        .getState()
        .updateNodeData(nodeId, { edit: { clips: clipsRef.current } }, false);
    }
    onClose();
  }, [nodeId, onClose, showToast]);

  useEffect(() => {
    if (exporting) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const isTextInput =
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']");
      const interactive =
        isTextInput || (target instanceof HTMLElement && target.closest("button"));
      if (event.key === "Escape" && !isTextInput) {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === " " && !interactive) {
        event.preventDefault();
        event.stopPropagation();
        togglePlay();
      } else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        !isTextInput &&
        selectedClipId
      ) {
        event.preventDefault();
        deleteClip(selectedClipId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, deleteClip, exporting, selectedClipId, togglePlay]);

  const exportVideo = useCallback(async () => {
    if (exportingRef.current) return;
    const videoTrack = trackClips(clipsRef.current, "video");
    if (!videoTrack.length) {
      showToast("先把视频或图片素材加入时间线，再导出", "error");
      return;
    }
    const total = compositionDurationMs(clipsRef.current);
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof MediaRecorder === "undefined") {
      showToast("当前浏览器不支持视频导出", "error");
      return;
    }
    const mimeType = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) {
      showToast("当前浏览器不支持视频导出", "error");
      return;
    }

    setPlaying(false);
    poolRef.current?.pauseExcept([]);

    // 先把时间线上的素材全部实例化，音频图才能覆盖到之后每个可能出声的元素。
    const pool = poolRef.current;
    pool?.prune(new Set(clipsRef.current.map((clip) => clip.mediaId)));
    for (const clip of clipsRef.current) {
      const url = resolveMediaUrl(assetUrlsRef.current, clip.mediaId);
      if (url) pool?.ensure(clip.mediaId, clip.kind, url);
    }

    // 只有真正会出声的素材才建音频图：纯图片时间线挂一条没有样本的静音音轨，
    // MediaRecorder 会等不到该轨的数据而录出空文件。
    // 每个元素只能创建一次 MediaElementSource，所以 AudioContext 常驻，
    // 元素→source 用 WeakMap 缓存，跨多次导出复用。
    const soundHandles = (pool?.list() ?? []).filter((handle) => handle.kind !== "image");
    let audioDestination: MediaStreamAudioDestinationNode | null = null;
    if (soundHandles.length) {
      try {
        const context =
          exportAudioContextRef.current ?? (exportAudioContextRef.current = new AudioContext());
        exportAudioDestinationRef.current?.disconnect();
        audioDestination = context.createMediaStreamDestination();
        exportAudioDestinationRef.current = audioDestination;
        for (const handle of soundHandles) {
          const element = handle.element as HTMLVideoElement | HTMLAudioElement;
          let source = exportAudioSourcesRef.current.get(element);
          if (!source) {
            source = context.createMediaElementSource(element);
            exportAudioSourcesRef.current.set(element, source);
          }
          source.connect(context.destination);
          source.connect(audioDestination);
        }
        if (context.state === "suspended") void context.resume().catch(() => {});
      } catch {
        audioDestination = null;
      }
    }

    const stream = canvas.captureStream(30);
    if (audioDestination) {
      for (const track of audioDestination.stream.getAudioTracks()) stream.addTrack(track);
    }

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    const previousWidth = canvas.width;
    const previousHeight = canvas.height;
    canvas.width = EXPORT_WIDTH;
    canvas.height = EXPORT_HEIGHT;
    exportProgressShownRef.current = -1;
    setExporting(true);
    setExportProgress(0);
    recorder.start(250);

    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = performance.now() - startedAt;
        if (t >= total) {
          paint(total);
          resolve();
          return;
        }
        paint(t);
        const percent = Math.floor((t / total) * 100);
        if (percent !== exportProgressShownRef.current) {
          exportProgressShownRef.current = percent;
          setExportProgress(percent);
        }
        window.setTimeout(tick, 16);
      };
      window.setTimeout(tick, 16);
    });

    recorder.stop();
    await stopped;
    // AudioContext 随编辑器常驻（元素→source 只能建一次），这里只断开本次导出
    // 的录音轨并停掉所有素材，避免导出结束后还在往外放声音。
    poolRef.current?.pauseExcept([]);
    exportAudioDestinationRef.current?.disconnect();
    exportAudioDestinationRef.current = null;
    canvas.width = previousWidth;
    canvas.height = previousHeight;
    setExporting(false);
    setExportProgress(0);
    paint(timelineMsRef.current);

    const containerType = mimeType.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunks, { type: containerType === "mp4" ? "video/mp4" : "video/webm" });
    if (!blob.size) {
      showToast("导出没有生成画面，请重试", "error");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const file = new File([blob], `剪辑导出-${stamp}.${containerType}`, {
      type: containerType === "mp4" ? "video/mp4" : "video/webm",
    });
    try {
      const media = await storeMedia(file, "video");
      const resultNodeId = useCanvasStore.getState().addConnectedNode(nodeId, "right", "video");
      if (!resultNodeId) {
        await removeMedia(media.id);
        showToast("无法创建导出视频节点", "error");
        return;
      }
      useCanvasStore.getState().setNodeMedia(resultNodeId, media, false);
      showToast("导出完成，右侧已生成视频节点", "success");
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "导出保存失败，请重试", "error");
    }
  }, [paint, nodeId, showToast]);

  const totalSeconds = Math.ceil(totalMs / 1000);
  const contentWidth = Math.max(totalSeconds * pxPerSecond + 320, 720);

  return createPortal(
    <div
      className="wc-clip-editor-backdrop"
      data-testid="clip-editor"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="wc-clip-editor"
        role="dialog"
        aria-modal="true"
        aria-label="剪辑工作台"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="wc-clip-editor-header">
          <div className="wc-clip-editor-title">
            <button
              type="button"
              className="wc-clip-editor-back"
              aria-label="返回画布"
              title="返回画布"
              onClick={close}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <span className="wc-clip-editor-mark" aria-hidden="true">
              <Scissors />
            </span>
            <strong>剪辑工作台</strong>
            <span className="wc-clip-editor-head-meta">
              {clips.length} 段素材 · 总时长 {formatTimecode(totalMs)}
            </span>
          </div>
          <div className="wc-clip-editor-actions">
            {exporting ? (
              <div className="wc-clip-export-progress" role="status">
                <LoaderCircle className="is-spinning" aria-hidden="true" />
                <span>导出中 {exportProgress}%</span>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="wc-clip-editor-secondary"
                  disabled={!clips.length}
                  onClick={() => void clearTimeline()}
                >
                  <Trash2 aria-hidden="true" />
                  清空
                </button>
                <button
                  type="button"
                  className="wc-clip-editor-primary"
                  data-testid="clip-export"
                  onClick={() => void exportVideo()}
                >
                  <Clapperboard aria-hidden="true" />
                  导出视频
                </button>
              </>
            )}
          </div>
        </header>

        <div className="wc-clip-editor-body">
          <AssetPanel
            assets={assets}
            assetUrls={assetUrls}
            projectId={projectId}
            cloudLinked={cloudLinked}
            onUrl={onMediaUrl}
            onAdd={(asset) => void addAsset(asset)}
          />
          <div className="wc-clip-editor-main">
            <div className="wc-clip-stage">
              <div className="wc-clip-stage-frame" data-testid="clip-stage">
                <canvas
                  ref={canvasRef}
                  width={960}
                  height={540}
                  className="wc-clip-canvas"
                  aria-label="剪辑预览画面"
                />
                {!clips.length ? (
                  <div className="wc-clip-stage-empty">
                    <Scissors aria-hidden="true" />
                    <strong>时间线还是空的</strong>
                    <span>点击左侧素材的 + 号加入时间线</span>
                  </div>
                ) : null}
                {buffering && clips.length ? (
                  <div
                    className="wc-clip-stage-buffering"
                    role="status"
                    data-testid="clip-buffering"
                  >
                    <LoaderCircle aria-hidden="true" />
                    <span>素材缓冲中</span>
                  </div>
                ) : null}
              </div>
              <div className="wc-clip-transport">
                <button
                  type="button"
                  className="wc-clip-transport-play"
                  aria-label={playing ? "暂停" : "播放"}
                  title={playing ? "暂停" : "播放"}
                  data-testid="clip-play"
                  onClick={togglePlay}
                >
                  {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>
                <span className="wc-clip-timecode" data-testid="clip-timecode">
                  {formatTimecode(timelineMs)} / {formatTimecode(totalMs)}
                </span>
                <input
                  type="range"
                  className="wc-clip-seek"
                  min={0}
                  max={Math.max(totalMs, 1)}
                  step={40}
                  value={Math.min(timelineMs, totalMs)}
                  aria-label="播放进度"
                  onChange={(event) => seekTo(Number(event.target.value))}
                />
              </div>
            </div>

            <Timeline
              clips={clips}
              timelineMs={timelineMs}
              selectedClipId={selectedClipId}
              exporting={exporting}
              contentWidth={contentWidth}
              pxPerSecond={pxPerSecond}
              assetUrls={assetUrls}
              onZoomChange={setPxPerSecond}
              onSeek={seekTo}
              onSelect={setSelectedClipId}
              onTrim={trimClip}
              onCommitTrim={commitTrim}
              onReorder={reorderClip}
              onDelete={deleteClip}
            />
          </div>
        </div>

        {/* 常驻媒体池：元素挂在屏幕外但仍留在渲染树里（display:none 会让
            Chrome 停止解码视频帧，drawImage 就只会拿到黑帧）。 */}
        <div ref={mediaHostRef} className="wc-clip-media-pool" aria-hidden="true" />
      </section>
    </div>,
    document.body,
  );
});

// ---------------------------------------------------------------------------
// 素材栏
// ---------------------------------------------------------------------------

function AssetPanel({
  assets,
  assetUrls,
  projectId,
  cloudLinked,
  onUrl,
  onAdd,
}: {
  assets: EditAsset[];
  assetUrls: Readonly<Record<string, string | null>>;
  projectId: string;
  cloudLinked: boolean;
  onUrl: (mediaId: string, url: string | null) => void;
  onAdd: (asset: EditAsset) => void;
}) {
  return (
    <aside className="wc-clip-assets">
      <div className="wc-clip-assets-head">
        <Layers aria-hidden="true" />
        <span>素材</span>
        <small>来自链接节点</small>
      </div>
      <div className="wc-clip-assets-list">
        {assets.map((asset) => (
          <AssetRow
            key={asset.media.id}
            asset={asset}
            projectId={projectId}
            cloudLinked={cloudLinked}
            onUrl={onUrl}
            onAdd={onAdd}
          />
        ))}
        {assets.length === 0 ? (
          <div className="wc-clip-assets-empty">
            <Layers aria-hidden="true" />
            <strong>还没有素材</strong>
            <span>把图片、视频或音频节点连到剪辑节点左侧，素材会自动出现在这里。</span>
          </div>
        ) : null}
      </div>
      <div className="wc-clip-assets-legend">
        <span className={Object.keys(assetUrls).length ? "is-live" : ""}>
          {Object.keys(assetUrls).length} 个可用素材
        </span>
      </div>
    </aside>
  );
}

function AssetRow({
  asset,
  projectId,
  cloudLinked,
  onUrl,
  onAdd,
}: {
  asset: EditAsset;
  projectId: string;
  cloudLinked: boolean;
  onUrl: (mediaId: string, url: string | null) => void;
  onAdd: (asset: EditAsset) => void;
}) {
  // 流式素材（音乐链接解析出的同源代理流）没有真实 media 记录，
  // 跳过 IndexedDB/服务器媒体解析，URL 直接用 asset.sourceUrl。
  const streamed = typeof asset.sourceUrl === "string" && asset.sourceUrl.length > 0;
  const { url } = useMediaUrlForProject(streamed ? null : asset.media, projectId, cloudLinked);
  const { url: thumbUrl } = useMediaThumbUrlForProject(
    streamed ? null : asset.media,
    projectId,
    cloudLinked,
  );
  const resolvedUrl = streamed ? asset.sourceUrl! : url;
  useEffect(() => {
    onUrl(asset.media.id, resolvedUrl);
  }, [asset.media.id, onUrl, resolvedUrl]);
  const displayUrl = asset.kind === "image" && !streamed ? (thumbUrl ?? url) : resolvedUrl;
  return (
    <div className="wc-clip-asset" data-testid={`clip-asset-${asset.media.id}`}>
      <div className={`wc-clip-asset-thumb wc-clip-asset-thumb--${asset.kind}`}>
        {asset.kind === "image" && displayUrl ? (
          <img src={displayUrl} alt="" draggable={false} />
        ) : null}
        {asset.kind === "video" && displayUrl ? (
          <video src={displayUrl} muted playsInline preload="metadata" />
        ) : null}
        {asset.kind === "audio" || !displayUrl ? <Music2 aria-hidden="true" /> : null}
      </div>
      <div className="wc-clip-asset-info">
        <strong title={asset.media.name}>{asset.media.name}</strong>
        <span>
          {kindLabels[asset.kind]} · {formatDurationMs(asset.media.durationMs)}
        </span>
      </div>
      <button
        type="button"
        className="wc-clip-asset-add"
        title="加入时间线"
        aria-label={`把 ${asset.media.name} 加入时间线`}
        data-testid={`clip-add-${asset.media.id}`}
        onClick={(event) => {
          event.stopPropagation();
          // 加入后把焦点交还给文档：否则空格会被这个按钮吃掉（触发再次加入），
          // 而不是走工作台的全局播放快捷键。
          event.currentTarget.blur();
          onAdd(asset);
        }}
      >
        <Plus aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

type TimelineProps = {
  clips: CanvasEditClip[];
  timelineMs: number;
  selectedClipId: string | null;
  exporting: boolean;
  contentWidth: number;
  pxPerSecond: number;
  assetUrls: Readonly<Record<string, string | null>>;
  onZoomChange: (pxPerSecond: number) => void;
  onSeek: (t: number) => void;
  onSelect: (id: string | null) => void;
  onTrim: (clipId: string, range: { inMs?: number; outMs?: number }) => void;
  onCommitTrim: () => void;
  onReorder: (clipId: string, trackIndex: number) => void;
  onDelete: (clipId: string) => void;
};

function Timeline({
  clips,
  timelineMs,
  selectedClipId,
  exporting,
  contentWidth,
  pxPerSecond,
  assetUrls,
  onZoomChange,
  onSeek,
  onSelect,
  onTrim,
  onCommitTrim,
  onReorder,
  onDelete,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seekGestureRef = useRef<{ pointerId: number } | null>(null);
  const zoomAnchorRef = useRef<{ timeMs: number; offsetX: number } | null>(null);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const rect = scroll.getBoundingClientRect();
      const x = clientX - rect.left + scroll.scrollLeft;
      onSeek(Math.max(0, Math.round((x / pxPerSecond) * 1000)));
    },
    [onSeek, pxPerSecond],
  );

  const beginSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || exporting) return;
    event.preventDefault();
    event.stopPropagation();
    seekGestureRef.current = { pointerId: event.pointerId };
    seekFromPointer(event.clientX);
    const move = (next: globalThis.PointerEvent) => {
      if (seekGestureRef.current?.pointerId !== next.pointerId) return;
      seekFromPointer(next.clientX);
    };
    const finish = (next: globalThis.PointerEvent) => {
      if (seekGestureRef.current?.pointerId !== next.pointerId) return;
      seekGestureRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  /** 以指针（或视口中心）为锚点切换缩放档位，缩放后该处的时间点保持不动。 */
  const applyZoom = useCallback(
    (next: number, anchorClientX?: number) => {
      const scroll = scrollRef.current;
      if (!scroll || next === pxPerSecond) return;
      const rect = scroll.getBoundingClientRect();
      const offsetX =
        anchorClientX === undefined ? rect.width / 2 : Math.max(0, anchorClientX - rect.left);
      zoomAnchorRef.current = {
        timeMs: ((offsetX + scroll.scrollLeft) / pxPerSecond) * 1000,
        offsetX,
      };
      onZoomChange(next);
    },
    [onZoomChange, pxPerSecond],
  );

  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      applyZoom(nextZoomStep(pxPerSecond, direction));
    },
    [applyZoom, pxPerSecond],
  );

  const fitZoom = useCallback(() => {
    const scroll = scrollRef.current;
    const seconds = Math.max(1, compositionDurationMs(clips) / 1000);
    const available = (scroll?.clientWidth ?? 960) - 24;
    const target =
      [...TIMELINE_ZOOM_STEPS].reverse().find((step) => step * seconds <= available) ??
      MIN_TIMELINE_ZOOM;
    applyZoom(target);
  }, [applyZoom, clips]);

  // Ctrl/⌘ + 滚轮缩放时间线（与画布缩放手感一致）。React 的 onWheel 是 passive 的，
  // 必须自己挂非 passive 监听才能吃掉页面滚动。
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      applyZoom(nextZoomStep(pxPerSecond, event.deltaY < 0 ? 1 : -1), event.clientX);
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, [applyZoom, pxPerSecond]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const anchor = zoomAnchorRef.current;
    if (!scroll || !anchor) return;
    zoomAnchorRef.current = null;
    scroll.scrollLeft = Math.max(0, (anchor.timeMs / 1000) * pxPerSecond - anchor.offsetX);
  }, [pxPerSecond]);

  const videoTrack = trackClips(clips, "video");
  const audioTrack = trackClips(clips, "audio");
  const total = compositionDurationMs(clips);
  const playheadX = (Math.min(timelineMs, total) / 1000) * pxPerSecond;
  const scalePercent = Math.round((pxPerSecond / TIMELINE_PX_PER_SECOND) * 100);

  return (
    <div className="wc-clip-timeline" data-testid="clip-timeline">
      <div className="wc-clip-timeline-head">
        <span>时间线</span>
        <small>{formatTimecode(total)}</small>
        <em>拖动标尺定位 · 拖动片段排序 · 拖动边缘裁剪 · Ctrl+滚轮缩放</em>
        <div className="wc-clip-zoom" role="group" aria-label="时间线缩放">
          <button
            type="button"
            aria-label="缩小时间线"
            title="缩小时间线"
            disabled={pxPerSecond <= MIN_TIMELINE_ZOOM}
            onClick={() => stepZoom(-1)}
          >
            <Minus aria-hidden="true" />
          </button>
          <span className="wc-clip-zoom-value" data-testid="clip-zoom-value">
            {scalePercent}%
          </span>
          <button
            type="button"
            aria-label="放大时间线"
            title="放大时间线"
            disabled={pxPerSecond >= MAX_TIMELINE_ZOOM}
            onClick={() => stepZoom(1)}
          >
            <Plus aria-hidden="true" />
          </button>
          <button type="button" className="wc-clip-zoom-fit" onClick={fitZoom}>
            适应
          </button>
        </div>
      </div>
      <div className="wc-clip-timeline-scroll" ref={scrollRef}>
        <div
          className="wc-clip-timeline-content"
          style={{ width: contentWidth, "--wc-clip-ppx": `${pxPerSecond}px` } as CSSProperties}
        >
          <div className="wc-clip-ruler-zone" onPointerDown={beginSeek}>
            <TimelineRuler totalMs={total} pxPerSecond={pxPerSecond} />
          </div>
          <div className="wc-clip-timeline-lanes">
            <TrackLane
              label="视频轨"
              trackKind="video"
              track={videoTrack}
              selectedClipId={selectedClipId}
              exporting={exporting}
              pxPerSecond={pxPerSecond}
              assetUrls={assetUrls}
              onSelect={onSelect}
              onTrim={onTrim}
              onCommitTrim={onCommitTrim}
              onReorder={onReorder}
              onDelete={onDelete}
            />
            <TrackLane
              label="音频轨"
              trackKind="audio"
              track={audioTrack}
              selectedClipId={selectedClipId}
              exporting={exporting}
              pxPerSecond={pxPerSecond}
              assetUrls={assetUrls}
              onSelect={onSelect}
              onTrim={onTrim}
              onCommitTrim={onCommitTrim}
              onReorder={onReorder}
              onDelete={onDelete}
            />
          </div>
          <div
            className="wc-clip-playhead"
            style={{ transform: `translateX(${playheadX}px)` }}
            aria-hidden="true"
          >
            <span className="wc-clip-playhead-cap" />
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineRuler({ totalMs, pxPerSecond }: { totalMs: number; pxPerSecond: number }) {
  // 缩放档位不同，刻度密度也要跟着变，否则放大后刻度糊成一片、缩小后数字重叠。
  const tickStep = pxPerSecond >= 40 ? 1 : pxPerSecond >= 16 ? 5 : 10;
  const labelStep = pxPerSecond >= 96 ? 2 : pxPerSecond >= 40 ? 5 : pxPerSecond >= 16 ? 10 : 30;
  const seconds = Math.max(tickStep, Math.ceil(totalMs / 1000));
  const ticks: number[] = [];
  for (let second = 0; second <= seconds; second += tickStep) ticks.push(second);
  return (
    <div className="wc-clip-ruler" data-testid="clip-ruler">
      {ticks.map((second) => (
        <span
          key={second}
          className={`wc-clip-ruler-tick ${second % labelStep === 0 ? "is-major" : ""}`}
          style={{ left: second * pxPerSecond }}
        >
          {second % labelStep === 0 ? <em>{formatTimecode(second * 1000)}</em> : null}
        </span>
      ))}
    </div>
  );
}

function TrackLane({
  label,
  trackKind,
  track,
  selectedClipId,
  exporting,
  pxPerSecond,
  assetUrls,
  onSelect,
  onTrim,
  onCommitTrim,
  onReorder,
  onDelete,
}: {
  label: string;
  trackKind: "video" | "audio";
  track: CanvasEditClip[];
  selectedClipId: string | null;
  exporting: boolean;
  pxPerSecond: number;
  assetUrls: Readonly<Record<string, string | null>>;
  onSelect: (id: string | null) => void;
  onTrim: (clipId: string, range: { inMs?: number; outMs?: number }) => void;
  onCommitTrim: () => void;
  onReorder: (clipId: string, trackIndex: number) => void;
  onDelete: (clipId: string) => void;
}) {
  return (
    <div className={`wc-clip-lane wc-clip-lane--${trackKind}`}>
      <span className="wc-clip-lane-label">{label}</span>
      <div className="wc-clip-lane-clips">
        {track.length === 0 ? (
          <span className="wc-clip-lane-empty">点击左侧素材的 + 加入</span>
        ) : null}
        {track.map((clip, index) => (
          <ClipBlock
            key={clip.id}
            clip={clip}
            index={index}
            track={track}
            selected={selectedClipId === clip.id}
            exporting={exporting}
            pxPerSecond={pxPerSecond}
            assetUrls={assetUrls}
            onSelect={onSelect}
            onTrim={onTrim}
            onCommitTrim={onCommitTrim}
            onReorder={onReorder}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}

function ClipBlock({
  clip,
  index,
  track,
  selected,
  exporting,
  pxPerSecond,
  assetUrls,
  onSelect,
  onTrim,
  onCommitTrim,
  onReorder,
  onDelete,
}: {
  clip: CanvasEditClip;
  index: number;
  track: CanvasEditClip[];
  selected: boolean;
  exporting: boolean;
  pxPerSecond: number;
  assetUrls: Readonly<Record<string, string | null>>;
  onSelect: (id: string | null) => void;
  onTrim: (clipId: string, range: { inMs?: number; outMs?: number }) => void;
  onCommitTrim: () => void;
  onReorder: (clipId: string, trackIndex: number) => void;
  onDelete: (clipId: string) => void;
}) {
  const blockRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    mode: "move" | "trim-left" | "trim-right";
    originX: number;
    originClientX: number;
    moved: boolean;
    originRange: { inMs: number; outMs: number };
    originLeftContent: number;
  } | null>(null);

  const durationMs = clipDurationMs(clip);
  const startMs = clipStartMs(track, index);
  const widthPx = Math.max(28, (durationMs / 1000) * pxPerSecond);
  const leftPx = (startMs / 1000) * pxPerSecond;

  const beginGesture =
    (mode: "move" | "trim-left" | "trim-right") => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || exporting) return;
      event.preventDefault();
      event.stopPropagation();
      onSelect(clip.id);
      gestureRef.current = {
        pointerId: event.pointerId,
        mode,
        originX: event.clientX,
        originClientX: event.clientX,
        moved: false,
        originRange: { inMs: clip.inMs, outMs: clip.outMs },
        originLeftContent: leftPx,
      };
      if (mode === "move") blockRef.current?.classList.add("is-dragging");
      else blockRef.current?.classList.add("is-trimming");

      const handleMove = (next: globalThis.PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== next.pointerId) return;
        const deltaX = next.clientX - gesture.originX;
        if (Math.abs(deltaX) > 3) gesture.moved = true;
        if (gesture.mode === "trim-left") {
          onTrim(clip.id, {
            inMs: gesture.originRange.inMs + Math.round((deltaX / pxPerSecond) * 1000),
          });
        } else if (gesture.mode === "trim-right") {
          onTrim(clip.id, {
            outMs: gesture.originRange.outMs + Math.round((deltaX / pxPerSecond) * 1000),
          });
        } else if (blockRef.current) {
          blockRef.current.style.setProperty("--wc-clip-shift", `${deltaX}px`);
        }
      };
      const handleFinish = (next: globalThis.PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== next.pointerId) return;
        gestureRef.current = null;
        blockRef.current?.classList.remove("is-dragging");
        blockRef.current?.classList.remove("is-trimming");
        blockRef.current?.style.removeProperty("--wc-clip-shift");
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleFinish);
        window.removeEventListener("pointercancel", handleFinish);

        if (gesture.mode === "move" && gesture.moved) {
          // 指针内容坐标 = 片段原始左缘（内容坐标）+ 指针位移
          const pointerContentX =
            gesture.originLeftContent + (next.clientX - gesture.originClientX);
          let targetIndex = 0;
          for (let cursor = 0; cursor < track.length; cursor += 1) {
            const candidate = track[cursor]!;
            if (candidate.id === clip.id) continue;
            const candidateStart = clipStartMs(track, cursor);
            const centerX = ((candidateStart + clipDurationMs(candidate) / 2) / 1000) * pxPerSecond;
            if (pointerContentX > centerX) targetIndex = cursor + 1;
          }
          onReorder(clip.id, targetIndex);
        } else if (gesture.mode !== "move" && gesture.moved) {
          onCommitTrim();
        }
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleFinish);
      window.addEventListener("pointercancel", handleFinish);
    };

  return (
    <div
      ref={blockRef}
      className={`wc-clip wc-clip--${clip.kind} ${selected ? "is-selected" : ""}`}
      style={{ left: leftPx, width: widthPx, "--wc-clip-shift": "0px" } as CSSProperties}
      data-clip-id={clip.id}
      data-testid={`timeline-clip-${clip.id}`}
      onPointerDown={beginGesture("move")}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(clip.id);
      }}
    >
      {clip.kind === "audio" ? (
        <ClipWaveform clip={clip} url={assetUrls[clip.mediaId] ?? null} widthPx={widthPx} />
      ) : null}
      <button
        type="button"
        className="wc-clip-remove"
        aria-label={`删除 ${clip.name}`}
        title="删除片段"
        data-testid={`clip-delete-${clip.id}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete(clip.id);
        }}
      >
        <X aria-hidden="true" />
      </button>
      <div className="wc-clip-caption">
        <span className={`wc-clip-kind wc-clip-kind--${clip.kind}`}>{kindLabels[clip.kind]}</span>
        <strong title={clip.name}>{clip.name}</strong>
      </div>
      <div className="wc-clip-duration">{formatTimecode(durationMs)}</div>
      <div
        className={`wc-clip-trim wc-clip-trim--left ${selected ? "is-visible" : ""}`}
        onPointerDown={beginGesture("trim-left")}
      />
      <div
        className={`wc-clip-trim wc-clip-trim--right ${selected ? "is-visible" : ""}`}
        onPointerDown={beginGesture("trim-right")}
      />
    </div>
  );
}

/**
 * 音频切片的波峰层：8kHz 峰值桶按片段裁剪区间映射到切片宽度。
 * 峰值未就绪/解码失败时不渲染（退回纯色块），绝不阻塞时间线交互。
 */
function ClipWaveform({
  clip,
  url,
  widthPx,
}: {
  clip: CanvasEditClip;
  url: string | null;
  widthPx: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<AudioPeaks | null>(() => readCachedAudioPeaks(clip.mediaId));

  useEffect(() => {
    setPeaks(readCachedAudioPeaks(clip.mediaId));
    if (!url) return;
    let active = true;
    void loadAudioPeaks(clip.mediaId, url).then((next) => {
      if (active) setPeaks(next);
    });
    return () => {
      active = false;
    };
  }, [clip.mediaId, url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const height = canvas.clientHeight;
    if (!height) return;
    // 位图宽度封顶 4096、CSS 拉伸到切片全宽：峰值数据本身只有 ~2000 桶，
    // 超长切片（如 28 分钟）在 100px/s 缩放下宽达 20 万像素，直接按切片
    // 宽度建画布会超过浏览器画布尺寸上限。
    const width = Math.max(32, Math.min(Math.round(widthPx), 4_096));
    canvas.width = width;
    canvas.height = Math.max(8, Math.round(height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, canvas.height);
    ctx.fillStyle = "rgb(12 14 13 / 0.32)";
    const buckets = peaks.mins.length;
    const from = Math.floor((clip.inMs / peaks.durationMs) * buckets);
    const to = Math.min(
      buckets,
      Math.max(from + 1, Math.ceil((clip.outMs / peaks.durationMs) * buckets)),
    );
    const bars = Math.max(6, Math.floor(width / 2.5));
    const barWidth = width / bars;
    const mid = canvas.height / 2;
    for (let bar = 0; bar < bars; bar += 1) {
      const bucket = Math.min(buckets - 1, from + Math.floor(((bar + 0.5) / bars) * (to - from)));
      const min = peaks.mins[bucket] ?? 0;
      const max = peaks.maxs[bucket] ?? 0;
      const top = mid - max * mid;
      const bottom = mid - min * mid;
      ctx.fillRect(bar * barWidth, top, Math.max(1, barWidth - 0.6), Math.max(1, bottom - top));
    }
  }, [peaks, clip.inMs, clip.outMs, widthPx]);

  if (!url) return null;
  return <canvas ref={canvasRef} className="wc-clip-wave" aria-hidden="true" />;
}
