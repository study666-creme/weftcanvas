import { describe, expect, it } from "vitest";

import { hasCanvasBuildChanged } from "./canvas-release-freshness";

describe("canvas release freshness", () => {
  it("reloads only when the served Canvas build marker changes", () => {
    expect(hasCanvasBuildChanged("release-a", "release-b")).toBe(true);
    expect(hasCanvasBuildChanged("release-a", "release-a")).toBe(false);
    expect(hasCanvasBuildChanged("release-a", null)).toBe(false);
  });
});
