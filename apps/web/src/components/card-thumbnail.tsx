import { FileText, LoaderCircle } from "lucide-react";
import { memo } from "react";

import { useBoundedImage } from "../hooks/use-bounded-image";
import { useInViewport } from "../hooks/use-in-viewport";

export const CardThumbnail = memo(function CardThumbnail({
  thumbUrl,
  title,
}: {
  thumbUrl: string;
  title: string;
}) {
  const { ref, inViewport } = useInViewport<HTMLDivElement>({ rootMargin: "240px" });
  // 卡片缩略图指向远端媒体域，fetch 会被 CORS 拦截：直接走原生 <img> 解码，
  // 一次下载即可渲染，避免先重复下载再回退 <img> 的双倍流量。
  const isRemote = /^https?:\/\//i.test(thumbUrl);
  const { asset, loading, error } = useBoundedImage(
    inViewport && thumbUrl ? thumbUrl : null,
    isRemote
      ? { priority: "normal", preferNative: true }
      : { priority: "normal", credentials: "same-origin" },
  );

  if (!thumbUrl) {
    return <FileText aria-hidden="true" />;
  }

  return (
    <div ref={ref} className="kc-card-library-preview">
      {error ? (
        <span
          className="kc-card-thumbnail-state is-error"
          role="img"
          aria-label={`${title} 缩略图不可用`}
          title="缩略图不可用"
        >
          <FileText aria-hidden="true" />
        </span>
      ) : asset ? (
        <img src={asset.url} alt="" draggable={false} loading="eager" decoding="async" />
      ) : loading ? (
        <span
          className="kc-card-thumbnail-state is-loading"
          role="status"
          aria-label={`${title} 缩略图加载中`}
        >
          <LoaderCircle className="is-spinning" aria-hidden="true" />
        </span>
      ) : (
        <FileText aria-hidden="true" />
      )}
    </div>
  );
});
