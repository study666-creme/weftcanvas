const OBJECT_URL_RELEASE_GRACE_MS = 8_000;

type MediaObjectUrlEntry = {
  promise: Promise<string | null>;
  url: string | null;
  references: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  invalidated: boolean;
};

const mediaObjectUrls = new Map<string, MediaObjectUrlEntry>();

/**
 * 同时进行的媒体读取上限。
 *
 * 进入画布后视口内的每个节点都会各自请求自己的媒体，没有上限就是几十次
 * IndexedDB 读取一拥而上：IO 争抢把单次读取拖慢，进而大面积触发
 * useMediaUrl 的服务器 fallback，本该命中本地缓存的媒体全部改为网络下载，
 * 这正是「一进画布加载一堆图片视频就卡」的来源。
 */
const MAX_CONCURRENT_MEDIA_READS = 4;

let activeMediaReads = 0;
const queuedMediaReads: Array<() => void> = [];

function scheduleMediaRead<T>(task: () => Promise<T>, onStart: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeMediaReads += 1;
      onStart();
      task().then(resolve, reject).finally(() => {
        activeMediaReads -= 1;
        queuedMediaReads.shift()?.();
      });
    };
    if (activeMediaReads < MAX_CONCURRENT_MEDIA_READS) run();
    else queuedMediaReads.push(run);
  });
}

export function acquireMediaObjectUrl(
  mediaId: string,
  load: () => Promise<Blob | null>,
  onStart?: () => void,
) {
  let entry = mediaObjectUrls.get(mediaId);
  if (!entry) {
    entry = {
      promise: Promise.resolve(null),
      url: null,
      references: 0,
      releaseTimer: null,
      invalidated: false,
    };
    const createdEntry = entry;
    createdEntry.promise = scheduleMediaRead(load, () => {
      if (!createdEntry.invalidated) onStart?.();
    }).then((blob) => {
      if (!blob || createdEntry.invalidated) return null;
      const url = URL.createObjectURL(blob);
      if (createdEntry.invalidated) {
        URL.revokeObjectURL(url);
        return null;
      }
      createdEntry.url = url;
      return url;
    });
    mediaObjectUrls.set(mediaId, createdEntry);
  } else {
    // 复用正在读取的条目时，让新的调用者立刻开始自己的兜底计时。
    onStart?.();
  }

  entry.references += 1;
  if (entry.releaseTimer !== null) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
  }
  return entry.promise;
}

export function releaseMediaObjectUrl(mediaId: string) {
  const entry = mediaObjectUrls.get(mediaId);
  if (!entry) return;
  entry.references = Math.max(0, entry.references - 1);
  if (entry.references > 0 || entry.releaseTimer !== null) return;
  entry.releaseTimer = setTimeout(() => {
    entry.releaseTimer = null;
    if (entry.references > 0 || mediaObjectUrls.get(mediaId) !== entry) return;
    mediaObjectUrls.delete(mediaId);
    if (entry.url) URL.revokeObjectURL(entry.url);
  }, OBJECT_URL_RELEASE_GRACE_MS);
}

export function invalidateMediaObjectUrl(mediaId: string) {
  const entry = mediaObjectUrls.get(mediaId);
  if (!entry) return;
  mediaObjectUrls.delete(mediaId);
  entry.invalidated = true;
  if (entry.releaseTimer !== null) clearTimeout(entry.releaseTimer);
  if (entry.url) URL.revokeObjectURL(entry.url);
}

export function clearMediaObjectUrlCache() {
  for (const mediaId of [...mediaObjectUrls.keys()]) invalidateMediaObjectUrl(mediaId);
}
