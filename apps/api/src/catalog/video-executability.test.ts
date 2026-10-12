import { describe, expect, it } from "vitest";

import { expandExecutorVideoIds, executorAvailability } from "./video-executability.js";

describe("executor video id expansion", () => {
  it("keeps executor ids as-is", () => {
    expect(expandExecutorVideoIds(["minimax_h3", "S-2.0-933-线路六"])).toEqual([
      "minimax_h3",
      "S-2.0-933-线路六",
    ]);
  });

  /**
   * 回归：执行器把 Grok 视频发布成 motion-video，纬线叫 grok-imagine-video。
   * 没有这张映射表，白名单过滤会把本来能跑的 Grok 线路一起误杀。
   */
  it("maps the executor's renamed Grok video lines back to the owned ids", () => {
    const ids = expandExecutorVideoIds(["motion-video", "motion-video-1-5", "minimax_h3"]);
    expect(ids).toContain("grok-imagine-video");
    expect(ids).toContain("grok-imagine-video-1.5");
    expect(ids).toContain("minimax_h3");
  });

  it("only expands aliases whose executor id is actually present", () => {
    const ids = expandExecutorVideoIds(["minimax_h3"]);
    expect(ids).not.toContain("grok-imagine-video");
  });
});

describe("executor availability annotation", () => {
  it("sorts the executable allowlist and de-duplicates it", () => {
    const availability = executorAvailability({
      executorVideoIds: ["b", "a", "b"],
      validatedAt: 123,
    });
    expect(availability.publicModelIds).toEqual(["a", "b"]);
    expect(availability.validatedAt).toBe(123);
  });

  /**
   * 关键取舍：执行器目录是「可执行」权威，它收录了哪些视频，纬线侧就只上架
   * 哪些。实测 2026-10-01 两边相差 8 条 token 计费 Seedance 线，它们报价能过、
   * 生成必失败。
   */
  it("carries the executor list through as the video allowlist", () => {
    const availability = executorAvailability({
      executorVideoIds: ["S-2.0-933-线路六", "motion-video"],
      disabledVideoIds: ["retired-line"],
      validatedAt: 456,
    });
    expect(availability.publicModelIds).toEqual(
      ["S-2.0-933-线路六", "grok-imagine-video", "motion-video"].sort(),
    );
    expect(availability.disabledModelIds).toEqual(["retired-line"]);
  });

  it("produces an empty allowlist when the executor reports no videos, so callers fail open", () => {
    const availability = executorAvailability({ executorVideoIds: [], validatedAt: 1 });
    expect(availability.publicModelIds).toEqual([]);
  });
});
