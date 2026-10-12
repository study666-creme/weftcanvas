import { Pause, Play, RefreshCw } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
} from "react";

import { videoLoadDeadlineReached } from "../lib/node-video-load";
import { captureFrameFromVideoElement } from "../lib/video-frame";
import { NodeLoadingState } from "./node-loading-state";

export type NodeVideoPlayerHandle = {
  captureCurrentFrame: () => Promise<Blob>;
};

type NodeVideoPlayerProps = {
  url: string;
  name: string;
  onDimensions?: (width: number, height: number) => void;
  /**
   * 元数据就绪时回报时长（毫秒）。画布上刚生成的视频工件不带时长（服务端只在
   * 内容被播放/下载后回写任务工件，且不会回流到本地节点），播放器解码时本来
   * 就拿得到这个值——回报给画布补进节点素材，参考视频时长参数与按秒计费的
   * 预估随即可用，不需要额外请求。
   */
  onDurationMs?: (durationMs: number) => void;
  /**
   * 旁观态（未选中/未悬停的节点）：视频不加载任何字节（preload="none"），
   * 只显示轻量占位与播放按钮。十兆级本地视频每个都要 preload=metadata
   * 的话，60+ 节点画布会把解码器与 IO 队列全部占满。首次点击播放时才
   * 真正 load()——此时节点必然已被用户注意，延迟不可感知。
   */
  lazy?: boolean;
};

// A bound on how long metadata and ready-state waits may run before the node
// settles to an explicit media-load failure. Delayed-but-arriving media still
// displays; only a media source that never produces a usable event fails.
const LOAD_WATCH_INTERVAL_MS = 250;

export const NodeVideoPlayer = forwardRef<NodeVideoPlayerHandle, NodeVideoPlayerProps>(
  function NodeVideoPlayer({ url, name, onDimensions, onDurationMs, lazy = false }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const rangeRef = useRef<HTMLInputElement>(null);
    const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
    const [paused, setPaused] = useState(true);
    const [duration, setDuration] = useState(0);
    const urlChangedAtRef = useRef(0);
    const [metadataAt, setMetadataAt] = useState<number | null>(null);

    const ensureLoaded = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;
      // preload="none" 下浏览器不会主动拉数据；用户要播（或捕获帧）时手动 load。
      if (video.preload === "none" && video.readyState === 0) video.load();
    }, []);

    useEffect(() => {
      urlChangedAtRef.current = Date.now();
      setMetadataAt(null);
      setPhase("loading");
      setPaused(true);
      setDuration(0);
    }, [url]);

    // Cleanup-safe bound on the loading phase: the interval is cleared whenever
    // the phase changes, the source changes, metadata arrives, or the player
    // unmounts, so a timer can never outlive its load attempt. A media source
    // that never produces a usable event settles to an explicit failure.
    // 旁观态（lazy）不 load 任何字节，deadline 计时也不启动——点击加载后
    // urlChangedAt 才会重置，计时语义不变。
    useEffect(() => {
      if (
        phase !== "loading" ||
        (lazy && videoRef.current?.preload === "none" && videoRef.current.readyState === 0)
      )
        return;
      const timer = window.setInterval(() => {
        const reached = videoLoadDeadlineReached({
          status: "loading",
          urlChangedAt: urlChangedAtRef.current,
          metadataAt,
          now: Date.now(),
        });
        if (reached) setPhase("error");
      }, LOAD_WATCH_INTERVAL_MS);
      return () => window.clearInterval(timer);
    }, [phase, metadataAt, url, lazy]);

    const reportDimensions = useCallback(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 1 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      if (!mediaUrlMatches(video.currentSrc || video.src, url)) return;
      onDimensions?.(video.videoWidth, video.videoHeight);
    }, [onDimensions, url]);

    const reportDuration = useCallback(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 1) return;
      if (!mediaUrlMatches(video.currentSrc || video.src, url)) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      onDurationMs?.(Math.round(video.duration * 1_000));
    }, [onDurationMs, url]);

    useEffect(() => {
      reportDimensions();
      reportDuration();
    }, [reportDimensions, reportDuration]);

    useImperativeHandle(
      ref,
      () => ({
        captureCurrentFrame: async () => {
          const video = videoRef.current;
          if (!video || phase !== "ready" || video.readyState < 2)
            throw new Error("视频尚未准备好，请稍后再试");
          return captureFrameFromVideoElement(video);
        },
      }),
      [phase],
    );
    // 每 250ms 一次 timeupdate 若走 setState，节点多时就是每秒几十次全树重渲染，
    // 这是画布视频堆积卡顿的主要来源。duration/暂停态才走 React。
    const syncTimeline = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;
      if (Number.isFinite(video.duration) && video.duration > 0 && video.duration !== duration)
        setDuration(video.duration);
      const range = rangeRef.current;
      if (range && !range.matches(":active")) {
        const bounded = Number.isFinite(video.duration)
          ? Math.min(video.currentTime, video.duration)
          : 0;
        range.value = String(bounded);
        range.style.setProperty(
          "--wc-video-progress",
          `${video.duration > 0 ? (bounded / video.duration) * 100 : 0}%`,
        );
      }
    }, [duration]);

    const togglePlayback = () => {
      const video = videoRef.current;
      if (!video) return;
      if (lazy) ensureLoaded();
      if (phase !== "ready") return;
      if (video.paused) void video.play().catch(() => setPhase("error"));
      else video.pause();
    };

    const seek = (event: ChangeEvent<HTMLInputElement>) => {
      const video = videoRef.current;
      if (!video) return;
      const next = Number(event.target.value);
      video.currentTime = next;
      event.target.style.setProperty(
        "--wc-video-progress",
        `${video.duration > 0 ? (next / video.duration) * 100 : 0}%`,
      );
    };

    const stopCanvasGesture = (event: PointerEvent<HTMLElement>) => event.stopPropagation();

    const retry = () => {
      const video = videoRef.current;
      if (!video) return;
      urlChangedAtRef.current = Date.now();
      setMetadataAt(null);
      setPhase("loading");
      video.load();
    };

    return (
      <div
        className={`wc-node-video-player ${paused ? "is-paused" : "is-playing"} ${phase === "ready" ? "is-ready" : ""}`}
      >
        <video
          ref={videoRef}
          src={url}
          aria-label={name || "节点视频"}
          playsInline
          // The node must render a preview before the user presses play.
          // `preload="none"` can defer the first frame indefinitely and trip
          // the bounded loader into a false failure state — so it is used only
          // for lazy (bystander) nodes whose loading starts on first interaction.
          preload={lazy ? "none" : "metadata"}
          draggable={false}
          onLoadedMetadata={() => {
            setMetadataAt(Date.now());
            reportDimensions();
            reportDuration();
            syncTimeline();
          }}
          onDurationChange={syncTimeline}
          onTimeUpdate={syncTimeline}
          onLoadedData={() => {
            setPhase("ready");
            setPaused(videoRef.current?.paused ?? true);
            syncTimeline();
          }}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onEnded={() => {
            setPaused(true);
            syncTimeline();
          }}
          onError={() => setPhase("error")}
        />

        {lazy && phase === "loading" ? (
          <button
            type="button"
            className="wc-video-poster wc-video-poster--lazy nodrag nowheel"
            aria-label={`加载并播放 ${name || "节点视频"}`}
            title="点击加载并播放"
            onClick={(event) => {
              event.stopPropagation();
              togglePlayback();
            }}
          >
            <Play aria-hidden="true" />
          </button>
        ) : null}

        {!lazy && phase === "loading" ? (
          <NodeLoadingState variant="video" activity="loading" label="加载视频" />
        ) : null}

        {phase === "ready" ? (
          <>
            <button
              type="button"
              className={`wc-video-playback nodrag nowheel ${paused ? "is-paused" : "is-playing"}`}
              aria-label={paused ? "播放视频" : "暂停视频"}
              title={paused ? "播放" : "暂停"}
              onPointerDown={stopCanvasGesture}
              onClick={(event) => {
                event.stopPropagation();
                togglePlayback();
              }}
            >
              {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            </button>

            <div
              className="wc-video-controls nodrag nowheel"
              onPointerDown={stopCanvasGesture}
              onClick={(event) => event.stopPropagation()}
            >
              <input
                ref={rangeRef}
                type="range"
                aria-label="视频进度"
                min={0}
                max={Math.max(duration, 0.01)}
                step={0.01}
                defaultValue={0}
                onChange={seek}
              />
            </div>
          </>
        ) : null}

        {phase === "error" ? (
          <div className="wc-video-error">
            <span>视频加载失败</span>
            <button type="button" className="nodrag nowheel" onClick={retry}>
              <RefreshCw aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : null}
      </div>
    );
  },
);

function mediaUrlMatches(actual: string, expected: string) {
  try {
    return new URL(actual, document.baseURI).href === new URL(expected, document.baseURI).href;
  } catch {
    return actual === expected;
  }
}
