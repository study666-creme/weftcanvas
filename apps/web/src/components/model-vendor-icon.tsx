import { KeyRound, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";

import { MODEL_VENDOR_GLYPHS } from "../lib/model-vendor-glyphs";
import { modelVendorByKey, type ModelVendor, type ModelVendorKey } from "../lib/model-vendor";

type ModelVendorIconProps = {
  /** 已解析好的厂商 key，通常来自 modelVendorOf(...).key。 */
  vendor: ModelVendorKey;
  /** 字形尺寸（px）。带 tile 时整块会多出 8px 的呼吸边。 */
  size?: number;
  /** 选项行用带底色的方形 tile，触发器 / 厂商标签页用裸字形。 */
  tile?: boolean;
  className?: string;
};

/**
 * 厂商商标：真商标路径（见 lib/model-vendor-glyphs.ts），不是首字母方块——
 * 模型广场里 16px 的字母块辨识度太差，认图标比读字快得多。
 *
 * 颜色只写在图标自己身上：`--wc-vendor-brand` 提供主色，再和当前正文色混一道，
 * 深色主题自动提亮、浅色主题自动压深，所以同一份品牌色两边都能看清，不用为
 * 深浅主题各维护一套色值。
 */
export function ModelVendorIcon({
  vendor,
  size = 16,
  tile = false,
  className = "",
}: ModelVendorIconProps) {
  const meta = modelVendorByKey(vendor);
  const paths = MODEL_VENDOR_GLYPHS[vendor as keyof typeof MODEL_VENDOR_GLYPHS] as
    readonly string[] | undefined;
  return (
    <span
      className={`wc-vendor-icon${tile ? " wc-vendor-icon--tile" : ""}${className ? ` ${className}` : ""}`}
      data-vendor={meta.key}
      style={
        {
          "--wc-vendor-brand": meta.brand,
          "--wc-vendor-size": `${size}px`,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {paths ? (
        <svg viewBox="0 0 24 24" focusable="false" role="presentation">
          {paths.map((path, index) => (
            <path key={index} d={path} fill="currentColor" />
          ))}
        </svg>
      ) : (
        <FallbackGlyph vendor={meta} />
      )}
    </span>
  );
}

/** 没有商标的厂商（自有 API / 其他）用等重的线性图标，视觉重量和实心商标接近。 */
function FallbackGlyph({ vendor }: { vendor: ModelVendor }) {
  const Icon = vendor.key === "custom" ? KeyRound : Sparkles;
  return <Icon className="wc-vendor-icon-fallback" strokeWidth={2.2} />;
}
