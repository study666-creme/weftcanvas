import { describe, expect, it } from "vitest";

import { resolveWhaleMode, type WhaleActivity, type WhaleReaction } from "./whale-girl-companion";

const mode = (activity: WhaleActivity, reaction: WhaleReaction, feedPulse = 0, docked = false) =>
  resolveWhaleMode({ activity, reaction, feedPulse, docked });

describe("whale companion head / full body decision", () => {
  it("sits on the canvas as a head only while nothing is happening", () => {
    expect(mode("idle", "idle")).toBe("head");
    expect(mode("idle", "listening")).toBe("head");
  });

  it("does not grow a body just because a node is selected", () => {
    expect(mode("idle", "curious")).toBe("head");
  });

  it("brings the whole body out while the Agent drawer is open", () => {
    expect(mode("open", "listening")).toBe("full");
  });

  it("brings the whole body out while she is working or has failed", () => {
    expect(mode("working", "thinking")).toBe("full");
    expect(mode("error", "concerned")).toBe("full");
  });

  it("brings the whole body out for a momentary reaction", () => {
    expect(mode("idle", "celebrate")).toBe("full");
    expect(mode("idle", "concerned")).toBe("full");
  });

  it("brings the whole body out briefly after being fed", () => {
    expect(mode("idle", "idle", 1)).toBe("full");
    expect(mode("idle", "idle", 0)).toBe("head");
  });

  it("brings the body out while perched — a peek is a body behind a wall, not a floating head", () => {
    // 用户原话：探头不是只有一个头，正常人从墙后探头还能看到小手扶墙、
    // 一点衣物裙摆。遮挡交给面板本身（她的 z 比面板低），姿态交给 pose。
    expect(mode("idle", "idle", 0, true)).toBe("full");
    expect(mode("idle", "curious", 0, true)).toBe("full");
    expect(mode("open", "listening", 0, true)).toBe("full");
  });

  it("still goes full for a real action no matter where she is", () => {
    expect(mode("working", "thinking", 0, true)).toBe("full");
    expect(mode("error", "concerned", 0, true)).toBe("full");
    expect(mode("idle", "celebrate", 0, true)).toBe("full");
    expect(mode("idle", "idle", 1, true)).toBe("full");
    expect(mode("open", "listening", 0, false)).toBe("full");
  });
});
