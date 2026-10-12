import { describe, expect, it } from "vitest";

import { decideImageLoadOutcome, TRANSIENT_IMAGE_RETRY_DELAYS_MS } from "./image-load-recovery";
import type { LoadedImageAsset } from "./bounded-image-loader";

const asset: LoadedImageAsset = {
  url: "blob:decoded",
  blob: null,
  width: 512,
  height: 512,
  fromMemory: false,
};

describe("image load recovery decision", () => {
  it("shows a decoded asset", () => {
    expect(decideImageLoadOutcome({ asset, failure: null }, 0)).toEqual({ action: "show", asset });
  });

  it("errors immediately on a permanent failure instead of retrying", () => {
    expect(decideImageLoadOutcome({ asset: null, failure: "permanent" }, 0)).toEqual({
      action: "error",
    });
  });

  it("ignores a cancelled request so the caller leaves its state untouched", () => {
    expect(decideImageLoadOutcome({ asset: null, failure: null }, 0)).toEqual({ action: "ignore" });
  });

  it("backs off through the full transient retry budget before giving up", () => {
    const delays = TRANSIENT_IMAGE_RETRY_DELAYS_MS.map((_, attempt) => {
      const decision = decideImageLoadOutcome({ asset: null, failure: "transient" }, attempt);
      expect(decision.action).toBe("retry");
      return decision.action === "retry" ? decision.delayMs : null;
    });
    expect(delays).toEqual([...TRANSIENT_IMAGE_RETRY_DELAYS_MS]);
    // 预算用尽后同一失败才落错误态。
    expect(
      decideImageLoadOutcome(
        { asset: null, failure: "transient" },
        TRANSIENT_IMAGE_RETRY_DELAYS_MS.length,
      ),
    ).toEqual({ action: "error" });
  });

  it("keeps retrying after a success would have been surfaced by a hard error", () => {
    // 回归护栏：慢存储上服务端首次生成缩略图时，界面必须是「继续载入」而不是
    // 立刻报「结果加载失败」。
    expect(decideImageLoadOutcome({ asset: null, failure: "transient" }, 0)).toEqual({
      action: "retry",
      delayMs: 2_000,
    });
  });
});
