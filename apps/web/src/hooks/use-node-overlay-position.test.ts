import { describe, expect, it } from "vitest";

import {
  fitGenerationOverlayVerticalPosition,
  fitOverlayHorizontalPosition,
  fitOverlayVerticalPosition,
} from "./use-node-overlay-position";

describe("node overlay horizontal placement", () => {
  it("keeps the editor between the create rail and Agent drawer", () => {
    expect(fitOverlayHorizontalPosition({
      preferredLeft: 8,
      overlayWidth: 420,
      minLeft: 82,
      maxRight: 668,
    })).toBe(82);

    expect(fitOverlayHorizontalPosition({
      preferredLeft: 520,
      overlayWidth: 420,
      minLeft: 82,
      maxRight: 668,
    })).toBe(248);
  });
});

describe("node overlay vertical placement", () => {
  it("keeps the editor below the node when it fits", () => {
    expect(fitOverlayVerticalPosition({
      nodeBottom: 240,
    })).toEqual({ top: 254, placement: "below" });
  });

  it("keeps the editor below a node near the viewport bottom", () => {
    expect(fitOverlayVerticalPosition({
      nodeBottom: 580,
    })).toEqual({ top: 594, placement: "below" });
  });
});

describe("generation overlay vertical placement", () => {
  it("keeps the composer below the node when it fits", () => {
    expect(fitGenerationOverlayVerticalPosition({
      nodeBottom: 536,
      nodeTop: 344,
      viewportHeight: 900,
      overlayHeight: 280,
    })).toEqual({ top: 550, placement: "below" });
  });

  it("flips the composer above the node when it would overflow the viewport bottom", () => {
    expect(fitGenerationOverlayVerticalPosition({
      nodeBottom: 536,
      nodeTop: 344,
      viewportHeight: 768,
      overlayHeight: 280,
    })).toEqual({ top: 50, placement: "above" });
  });

  it("clamps the flipped composer to the viewport margin", () => {
    expect(fitGenerationOverlayVerticalPosition({
      nodeBottom: 760,
      nodeTop: 740,
      viewportHeight: 768,
      overlayHeight: 900,
    })).toEqual({ top: 16, placement: "above" });
  });
});
