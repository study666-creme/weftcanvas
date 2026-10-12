import { useEffect, useState } from "react";

import {
  acquireBoundedImageDetailed,
  releaseBoundedImage,
  type ImageLoadPriority,
  type LoadedImageAsset,
} from "../lib/bounded-image-loader";
import { decideImageLoadOutcome } from "../lib/image-load-recovery";

export type BoundedImageState = {
  asset: LoadedImageAsset | null;
  loading: boolean;
  error: boolean;
};

export function useBoundedImage(
  src: string | null | undefined,
  options: {
    priority?: ImageLoadPriority;
    credentials?: RequestCredentials;
    preferNative?: boolean;
  } = {},
): BoundedImageState {
  const priority = options.priority ?? "normal";
  const credentials = options.credentials;
  const preferNative = options.preferNative ?? false;
  const [asset, setAsset] = useState<LoadedImageAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!src) {
      setAsset(null);
      setLoading(false);
      setError(false);
      return;
    }
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    let holding = false;

    // 释放当前请求引用：重试前先松手，下一次 acquire 才会是全新请求，而不是
    // 复用已经 settle 的旧条目。
    const release = () => {
      if (!holding) return;
      holding = false;
      releaseBoundedImage(src);
    };

    const load = () => {
      holding = true;
      void acquireBoundedImageDetailed(src, { priority, credentials, preferNative })
        .then((result) => {
          if (!active) return;
          const decision = decideImageLoadOutcome(result, retryAttempt);
          if (decision.action === "show") {
            setLoading(false);
            setError(false);
            setAsset(decision.asset);
            return;
          }
          if (decision.action === "error") {
            setLoading(false);
            setError(true);
            return;
          }
          if (decision.action === "retry") {
            retryAttempt += 1;
            // 保持 loading 态（不闪错误），退避后自动重新请求。
            release();
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (active) load();
            }, decision.delayMs);
            return;
          }
          // ignore：请求被取消，交给清理逻辑，不改状态。
        })
        .catch(() => {
          if (!active) return;
          setLoading(false);
          setError(true);
        });
    };

    setAsset(null);
    setError(false);
    setLoading(true);
    load();
    return () => {
      active = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      release();
    };
  }, [src, priority, credentials, preferNative]);

  return { asset, loading, error };
}
