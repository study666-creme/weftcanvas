import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties } from "react";

function formatPlaybackClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, "0");
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${secs}`;
  }
  return `${minutes}:${secs}`;
}

/**
 * 画布音频的统一迷你播放器：原生 <audio controls> 的浏览器样式与画布
 * 视觉体系不搭。自绘「播放/暂停 + 进度条 + 时间」；拖动进度期间只更新
 * 视觉、松手才提交 seek，避免网络音频被连续拖动打出密集 Range 请求。
 * <audio> 元素隐藏，仅作解码与播放载体。
 */
export function MiniAudioPlayer({ src, label, onPlayingChange }: {
  src: string;
  label: string;
  onPlayingChange?: (playing: boolean) => void;
}) {
  const [audioRef, setAudioRef] = useState<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const syncPlaying = useCallback((next: boolean) => {
    setPlaying(next);
    onPlayingChange?.(next);
  }, [onPlayingChange]);

  useEffect(() => {
    if (!audioRef) return;
    const onPlay = () => syncPlaying(true);
    const onPause = () => syncPlaying(false);
    const onEnded = () => {
      syncPlaying(false);
      setCurrentTime(0);
    };
    const onTime = () => setCurrentTime(audioRef.currentTime);
    const onMeta = () => setDuration(Number.isFinite(audioRef.duration) ? audioRef.duration : 0);
    audioRef.addEventListener("play", onPlay);
    audioRef.addEventListener("pause", onPause);
    audioRef.addEventListener("ended", onEnded);
    audioRef.addEventListener("timeupdate", onTime);
    audioRef.addEventListener("loadedmetadata", onMeta);
    return () => {
      audioRef.removeEventListener("play", onPlay);
      audioRef.removeEventListener("pause", onPause);
      audioRef.removeEventListener("ended", onEnded);
      audioRef.removeEventListener("timeupdate", onTime);
      audioRef.removeEventListener("loadedmetadata", onMeta);
    };
  }, [audioRef, syncPlaying]);

  // 换源（换歌）重置进度与播放态。
  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setDragValue(null);
    syncPlaying(false);
  }, [src, syncPlaying]);

  const toggle = () => {
    if (!audioRef) return;
    if (audioRef.paused) void audioRef.play().catch(() => undefined);
    else audioRef.pause();
  };

  const commitSeek = (value: number) => {
    if (!audioRef || !Number.isFinite(value)) return;
    audioRef.currentTime = value;
    setCurrentTime(value);
  };

  const shown = dragValue ?? currentTime;
  const progress = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;

  return (
    <div className="kc-mini-player nodrag nowheel">
      <audio ref={setAudioRef} src={src} preload="metadata" aria-label={label} />
      <button
        type="button"
        className="kc-mini-player-toggle"
        aria-label={playing ? "暂停" : "播放"}
        title={playing ? "暂停" : "播放"}
        onClick={toggle}
      >
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </button>
      <input
        className="kc-mini-player-seek"
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={shown}
        disabled={!duration}
        aria-label="播放进度"
        style={{ "--kc-progress": `${progress}%` } as CSSProperties}
        onChange={(event) => setDragValue(Number(event.target.value))}
        onPointerUp={() => {
          if (dragValue !== null) {
            commitSeek(dragValue);
            setDragValue(null);
          }
        }}
        onKeyUp={() => {
          if (dragValue !== null) {
            commitSeek(dragValue);
            setDragValue(null);
          }
        }}
      />
      <span className="kc-mini-player-time">{formatPlaybackClock(shown)} / {formatPlaybackClock(duration)}</span>
    </div>
  );
}
