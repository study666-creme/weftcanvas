/**
 * 剪辑工作台的媒体元素池。
 *
 * 之前预览区只复用一个 <video> 和一个 <img>：切换片段时要重设 src 并 load()，
 * 浏览器得重新拉流+解码，表现为"点空格先黑一下"、在线视频起播慢、图片素材
 * 干脆画不出来。这里改成按 mediaId 缓存常驻元素：
 *
 * - 打开工作台即对时间线上的全部素材 ensure()，让浏览器提前预取；
 * - 元素只创建一次、src 只设置一次，切换片段只是换绘制目标；
 * - 元素挂在屏幕外但仍在渲染树里（不是 display:none），保证 Chrome 持续解码
 *   视频帧，drawImage 才拿得到画面。
 */

export type ClipMediaKind = "video" | "image" | "audio";

export type ClipMediaHandle = {
  readonly mediaId: string;
  readonly kind: ClipMediaKind;
  readonly url: string;
  readonly element: HTMLVideoElement | HTMLImageElement | HTMLAudioElement;
  ready: boolean;
};

function isReady(handle: ClipMediaHandle) {
  const element = handle.element;
  if (handle.kind === "image") {
    const image = element as HTMLImageElement;
    return image.complete && image.naturalWidth > 0;
  }
  if (handle.kind === "video") {
    const video = element as HTMLVideoElement;
    return video.readyState >= 2 && video.videoWidth > 0;
  }
  return (element as HTMLAudioElement).readyState >= 2;
}

export class ClipMediaPool {
  private readonly handles = new Map<string, ClipMediaHandle>();
  private readonly listeners = new Set<(mediaId: string) => void>();
  private disposed = false;

  constructor(private readonly host: HTMLElement) {}

  /** 任一素材的可用状态发生变化时回调（用于请求重绘当前帧）。 */
  subscribe(listener: (mediaId: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get(mediaId: string) {
    return this.handles.get(mediaId) ?? null;
  }

  /** 取得（必要时创建）该素材对应的常驻元素。 */
  ensure(mediaId: string, kind: ClipMediaKind, url: string): ClipMediaHandle | null {
    if (this.disposed) return null;
    const existing = this.handles.get(mediaId);
    if (existing && existing.url === url && existing.kind === kind) return existing;
    if (existing) this.release(mediaId);

    let element: HTMLVideoElement | HTMLImageElement | HTMLAudioElement;
    if (kind === "video") {
      const video = document.createElement("video");
      video.preload = "auto";
      video.playsInline = true;
      // 不静音：导出时要把这个元素接进 AudioContext，静音会让音轨变成哑巴。
      video.muted = false;
      element = video;
    } else if (kind === "image") {
      const image = document.createElement("img");
      image.decoding = "async";
      image.draggable = false;
      element = image;
    } else {
      const audio = document.createElement("audio");
      audio.preload = "auto";
      element = audio;
    }

    const handle: ClipMediaHandle = { mediaId, kind, url, element, ready: false };
    const settle = () => {
      handle.ready = isReady(handle);
      this.emit(mediaId);
    };
    if (kind === "image") {
      element.addEventListener("load", settle);
    } else {
      element.addEventListener("loadeddata", settle);
      element.addEventListener("canplay", settle);
      element.addEventListener("seeked", settle);
      // 播放到新的缓冲边界也会改变可绘制性，用 timeupdate 兜住状态刷新。
      element.addEventListener("timeupdate", settle);
    }
    element.addEventListener("error", () => {
      handle.ready = false;
      this.emit(mediaId);
    });

    element.src = url;
    this.host.append(element);
    this.handles.set(mediaId, handle);
    // 图片可能命中缓存后同步就绪。
    handle.ready = isReady(handle);
    return handle;
  }

  /** 只返回已经可绘制的句柄，避免调用方到处判空。 */
  readyHandle(mediaId: string, kind: ClipMediaKind, url: string): ClipMediaHandle | null {
    const handle = this.ensure(mediaId, kind, url);
    if (!handle) return null;
    const ready = isReady(handle);
    if (ready !== handle.ready) handle.ready = ready;
    return ready ? handle : null;
  }

  /** 当前持有的全部元素（导出时要把它们接进 AudioContext）。 */
  list(): ClipMediaHandle[] {
    return [...this.handles.values()];
  }

  /** 暂停 keep 之外的所有媒体，防止切片段时上一段还在出声。 */
  pauseExcept(keep: Iterable<string>) {
    const keepIds = new Set(keep);
    for (const handle of this.handles.values()) {
      if (handle.kind === "image") continue;
      if (keepIds.has(handle.mediaId)) continue;
      const media = handle.element as HTMLVideoElement | HTMLAudioElement;
      if (!media.paused) media.pause();
    }
  }

  /** 时间线不再引用的素材直接释放，避免长会话里元素无限堆积。 */
  prune(keepMediaIds: ReadonlySet<string>) {
    for (const mediaId of [...this.handles.keys()]) {
      if (!keepMediaIds.has(mediaId)) this.release(mediaId);
    }
  }

  release(mediaId: string) {
    const handle = this.handles.get(mediaId);
    if (!handle) return;
    this.handles.delete(mediaId);
    const element = handle.element;
    if (handle.kind !== "image") {
      const media = element as HTMLVideoElement | HTMLAudioElement;
      media.pause();
      media.removeAttribute("src");
      media.load();
    } else {
      element.removeAttribute("src");
    }
    element.remove();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const mediaId of [...this.handles.keys()]) this.release(mediaId);
    this.listeners.clear();
  }

  private emit(mediaId: string) {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener(mediaId);
  }
}
