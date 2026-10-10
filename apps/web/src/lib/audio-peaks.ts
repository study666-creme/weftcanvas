/**
 * 音频波形峰值的轻量计算（剪辑时间线的波峰显示）。
 *
 * 关键取舍：用 8kHz 的 OfflineAudioContext 解码——浏览器把整段音频重采样
 * 到 8kHz 单声道后交给峰值统计，28 分钟的曲子峰值内存也只有 ~55MB 瞬时
 * （原速立体声解码要 600MB 量级），8kHz 采样密度对像素级波峰绰绰有余。
 * 解码失败（浏览器不支持该容器/编解码等）静默返回 null，UI 退回纯色块。
 */
export type AudioPeaks = {
  mins: Float32Array;
  maxs: Float32Array;
  /** 峰值覆盖的源时长（毫秒），用于把片段裁剪区间映射到桶区间。 */
  durationMs: number;
};

const PEAK_SAMPLE_RATE = 8_000;
const MAX_BUCKETS = 2_000;

const cache = new Map<string, AudioPeaks>();
const inflight = new Map<string, Promise<AudioPeaks | null>>();

export function readCachedAudioPeaks(key: string): AudioPeaks | null {
  return cache.get(key) ?? null;
}

export function loadAudioPeaks(key: string, url: string): Promise<AudioPeaks | null> {
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(key);
  if (running) return running;
  const task = (async () => {
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      const OfflineContext = window.OfflineAudioContext;
      if (!OfflineContext) return null;
      const context = new OfflineContext(1, 1, PEAK_SAMPLE_RATE);
      const buffer = await context.decodeAudioData(bytes);
      const channel = buffer.getChannelData(0);
      const bucketCount = Math.min(MAX_BUCKETS, Math.max(1, channel.length));
      const perBucket = Math.ceil(channel.length / bucketCount);
      const mins = new Float32Array(bucketCount);
      const maxs = new Float32Array(bucketCount);
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const start = bucket * perBucket;
        const end = Math.min(channel.length, start + perBucket);
        let min = 0;
        let max = 0;
        for (let cursor = start; cursor < end; cursor += 1) {
          const value = channel[cursor]!;
          if (value < min) min = value;
          else if (value > max) max = value;
        }
        mins[bucket] = min;
        maxs[bucket] = max;
      }
      const peaks: AudioPeaks = { mins, maxs, durationMs: Math.round(buffer.duration * 1000) };
      cache.set(key, peaks);
      return peaks;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}
