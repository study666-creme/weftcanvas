import { describe, expect, it } from "vitest";

import { AUTH_FILM_SEGMENTS, pickRandomAuthFilmSegment } from "./auth-film-background";

describe("auth film segment selection", () => {
  it("declares every chapter segment with a real duration", () => {
    expect(AUTH_FILM_SEGMENTS.map((segment) => segment.src.split("/").pop())).toEqual([
      "auth-film-blackhole",
      "auth-film-docking",
      "auth-film-ocean",
      "auth-film-wormhole",
    ]);
    for (const segment of AUTH_FILM_SEGMENTS) {
      expect(segment.seconds).toBeGreaterThan(SEAM_GUARDSeconds() * 2);
    }
  });

  it("picks a start position inside the seam-safe window", () => {
    // 起播点必须落在段内：落在 [0, guard] 或 [seconds-guard, seconds] 都会
    // 撞上烘焙接缝的交叉淡化带，读起来像画面坏了。
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const picked = pickRandomAuthFilmSegment()!;
      const segment = AUTH_FILM_SEGMENTS.find((item) => item.src === picked.src)!;
      expect(picked.startAt).toBeGreaterThanOrEqual(SEAM_GUARD_SECONDS);
      expect(picked.startAt).toBeLessThanOrEqual(segment.seconds - SEAM_GUARD_SECONDS);
    }
  });

  it("moves to a different segment when one finishes, never repeating the current one", () => {
    for (const segment of AUTH_FILM_SEGMENTS) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const next = pickRandomAuthFilmSegment(segment.src)!;
        expect(next.src).not.toBe(segment.src);
      }
    }
  });

  it("still resolves when only one segment exists", () => {
    // 退化为单段清单时不能挑空：换段是锦上添花，不是播放的前提。
    expect(pickRandomAuthFilmSegment("/nope")).not.toBeNull();
  });
});

const SEAM_GUARD_SECONDS = 2.5;
function SEAM_GUARDSeconds() {
  return SEAM_GUARD_SECONDS;
}
