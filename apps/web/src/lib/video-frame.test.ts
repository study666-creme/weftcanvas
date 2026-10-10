import { describe, expect, it } from "vitest";

import { getDefaultLastFrameTime } from "./video-frame";

describe("video frame timing", () => {
  it("selects a decodable point just before the final boundary", () => {
    expect(getDefaultLastFrameTime(8)).toBe(7.95);
    expect(getDefaultLastFrameTime(0)).toBe(0);
    expect(getDefaultLastFrameTime(Number.NaN)).toBe(0);
  });
});
