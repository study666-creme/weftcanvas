import { describe, expect, it } from "vitest";

import {
  NODE_VIDEO_METADATA_TIMEOUT_MS,
  NODE_VIDEO_READY_TIMEOUT_MS,
  videoLoadDeadlineReached,
  videoLoadRemainingMs,
} from "./node-video-load";

describe("node video load bound", () => {
  it("settles a source that never produces metadata once the metadata deadline passes", () => {
    const startedAt = 1_000;
    expect(videoLoadDeadlineReached({
      status: "loading",
      urlChangedAt: startedAt,
      metadataAt: null,
      now: startedAt + NODE_VIDEO_METADATA_TIMEOUT_MS - 1,
    })).toBe(false);
    expect(videoLoadDeadlineReached({
      status: "loading",
      urlChangedAt: startedAt,
      metadataAt: null,
      now: startedAt + NODE_VIDEO_METADATA_TIMEOUT_MS,
    })).toBe(true);
    expect(videoLoadDeadlineReached({
      status: "loading",
      urlChangedAt: startedAt,
      metadataAt: null,
      now: startedAt + NODE_VIDEO_METADATA_TIMEOUT_MS + 60_000,
    })).toBe(true);
  });

  it("allows delayed metadata and only fails after the ready deadline when data never becomes playable", () => {
    const startedAt = 1_000;
    const metadataAt = startedAt + NODE_VIDEO_METADATA_TIMEOUT_MS - 100;
    expect(videoLoadDeadlineReached({
      status: "loading",
      urlChangedAt: startedAt,
      metadataAt,
      now: metadataAt + NODE_VIDEO_READY_TIMEOUT_MS - 1,
    })).toBe(false);
    expect(videoLoadDeadlineReached({
      status: "loading",
      urlChangedAt: startedAt,
      metadataAt,
      now: metadataAt + NODE_VIDEO_READY_TIMEOUT_MS,
    })).toBe(true);
  });

  it("keeps a successfully delayed media loading while both bounds are open", () => {
    const startedAt = 1_000;
    expect(videoLoadDeadlineReached({
      status: "loading",
      urlChangedAt: startedAt,
      metadataAt: null,
      now: startedAt + 10_000,
    })).toBe(false);
    expect(videoLoadRemainingMs({
      status: "loading",
      urlChangedAt: startedAt,
      metadataAt: null,
      now: startedAt + 10_000,
    })).toBe(NODE_VIDEO_METADATA_TIMEOUT_MS - 10_000);
  });

  it("respects explicit custom bounds for tests and operators", () => {
    expect(videoLoadDeadlineReached({
      status: "loading",
      urlChangedAt: 0,
      metadataAt: null,
      now: 299,
      metadataTimeoutMs: 300,
    })).toBe(false);
    expect(videoLoadDeadlineReached({
      status: "loading",
      urlChangedAt: 0,
      metadataAt: null,
      now: 300,
      metadataTimeoutMs: 300,
    })).toBe(true);
    expect(videoLoadRemainingMs({
      status: "loading",
      urlChangedAt: 0,
      metadataAt: 0,
      now: 4_000,
      readyTimeoutMs: 5_000,
    })).toBe(1_000);
  });
});
