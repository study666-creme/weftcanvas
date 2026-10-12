import { describe, expect, it } from "vitest";

import type { CanvasEditClip } from "@weftcanvas/contracts";

import {
  activeClipAt,
  buildClipFromAsset,
  clipDurationMs,
  clipStartMs,
  collectEditAssets,
  compositionDurationMs,
  EDIT_FALLBACK_CLIP_DURATION_MS,
  EDIT_IMAGE_CLIP_DURATION_MS,
  EDIT_MIN_CLIP_DURATION_MS,
  formatTimecode,
  moveClip,
  removeClip,
  resolveSourceTimeMs,
  setClipRange,
  trackClips,
  trackDurationMs,
  type EditAsset,
} from "./clip-composition";
import type { WeftcanvasEdge, WeftcanvasNode } from "../types";

function makeClip(overrides: Partial<CanvasEditClip> & { id: string }): CanvasEditClip {
  return {
    track: "video",
    nodeId: "node-1",
    mediaId: "media-1",
    name: "clip.mp4",
    kind: "video",
    sourceDurationMs: 10_000,
    inMs: 0,
    outMs: 5_000,
    ...overrides,
  };
}

describe("clip-composition timeline math", () => {
  it("sums clip durations into track and composition times", () => {
    const clips = [
      makeClip({ id: "a", track: "video", inMs: 0, outMs: 4_000 }),
      makeClip({ id: "b", track: "video", inMs: 1_000, outMs: 3_500 }),
      makeClip({ id: "c", track: "audio", inMs: 0, outMs: 8_000 }),
    ];
    expect(trackClips(clips, "video").map((clip) => clip.id)).toEqual(["a", "b"]);
    expect(clipDurationMs(clips[1]!)).toBe(2_500);
    expect(trackDurationMs(clips, "video")).toBe(6_500);
    expect(trackDurationMs(clips, "audio")).toBe(8_000);
    expect(compositionDurationMs(clips)).toBe(8_000);
    expect(clipStartMs(trackClips(clips, "video"), 1)).toBe(4_000);
  });

  it("resolves the active clip and source time for a timeline position", () => {
    const clips = [
      makeClip({ id: "a", inMs: 500, outMs: 4_500 }),
      makeClip({ id: "b", inMs: 0, outMs: 3_000 }),
    ];
    expect(activeClipAt(clips, 0)?.clip.id).toBe("a");
    expect(activeClipAt(clips, 0)?.startMs).toBe(0);
    expect(resolveSourceTimeMs(clips, 1_000)).toBe(1_500);
    expect(activeClipAt(clips, 4_000)?.clip.id).toBe("b");
    expect(activeClipAt(clips, 4_000)?.startMs).toBe(4_000);
    expect(resolveSourceTimeMs(clips, 4_500)).toBe(500);
    expect(activeClipAt(clips, 7_000)).toBeNull();
    expect(resolveSourceTimeMs(clips, 10_000)).toBeNull();
  });

  it("clamps trim handles to the source range and the minimum duration", () => {
    const clip = {
      id: "a",
      track: "video",
      nodeId: "n",
      mediaId: "m",
      name: "v.mp4",
      kind: "video",
      sourceDurationMs: 10_000,
      inMs: 1_000,
      outMs: 6_000,
    } as const;
    expect(setClipRange(clip, { inMs: 3_000 })).toMatchObject({ inMs: 3_000, outMs: 6_000 });
    expect(setClipRange(clip, { outMs: 2_000 })).toMatchObject({ inMs: 1_000, outMs: 2_000 });
    expect(setClipRange(clip, { outMs: 1_400 })).toMatchObject({ inMs: 1_000, outMs: 1_400 });
    expect(setClipRange(clip, { outMs: 99_000 })).toMatchObject({ inMs: 1_000, outMs: 10_000 });
    const moved = setClipRange(clip, { inMs: 1_000, outMs: 6_000 });
    expect(moved).toBe(clip);
  });

  it("moves and removes clips by id", () => {
    const clips = [makeClip({ id: "a" }), makeClip({ id: "b" }), makeClip({ id: "c" })];
    expect(moveClip(clips, "c", 0).map((clip) => clip.id)).toEqual(["c", "a", "b"]);
    expect(moveClip(clips, "a", 99).map((clip) => clip.id)).toEqual(["b", "c", "a"]);
    expect(moveClip(clips, "missing", 0).map((clip) => clip.id)).toEqual(["a", "b", "c"]);
    expect(removeClip(clips, "b").map((clip) => clip.id)).toEqual(["a", "c"]);
  });

  it("builds clips from assets with image defaults and source duration fallbacks", () => {
    const asset: EditAsset = {
      nodeId: "node-1",
      kind: "image",
      media: {
        id: "media-1",
        name: "photo.png",
        mimeType: "image/png",
        size: 1,
        source: "local",
        serverId: null,
        width: 100,
        height: 100,
        durationMs: null,
      },
    };
    const imageClip = buildClipFromAsset(asset, null);
    expect(imageClip.track).toBe("video");
    expect(imageClip.outMs - imageClip.inMs).toBe(EDIT_IMAGE_CLIP_DURATION_MS);

    const videoClip = buildClipFromAsset({ ...asset, kind: "video" }, null);
    expect(videoClip.outMs - videoClip.inMs).toBe(EDIT_FALLBACK_CLIP_DURATION_MS);

    const audioClip = buildClipFromAsset(
      { ...asset, kind: "audio", media: { ...asset.media, durationMs: 9_800 } },
      9_800,
    );
    expect(audioClip.track).toBe("audio");
    expect(audioClip.outMs).toBe(9_800);
  });

  it("collects media assets from incoming edges only, deduplicated by media id", () => {
    const nodes = [
      { id: "edit", data: { kind: "edit" } },
      { id: "v1", data: { kind: "video", media: { id: "m1" } } },
      { id: "v2", data: { kind: "video", media: { id: "m1" } } },
      { id: "img", data: { kind: "image", media: { id: "m2" } } },
      { id: "note", data: { kind: "text", media: null } },
      { id: "other", data: { kind: "video", media: { id: "m3" } } },
    ] as unknown as WeftcanvasNode[];
    const edges = [
      { source: "v1", target: "edit" },
      { source: "v2", target: "edit" },
      { source: "img", target: "edit" },
      { source: "note", target: "edit" },
      { source: "other", target: "other-2" },
    ] as WeftcanvasEdge[];

    const assets = collectEditAssets(nodes, edges, "edit");
    expect(assets.map((asset) => asset.media.id)).toEqual(["m1", "m2"]);
    expect(assets.map((asset) => asset.kind)).toEqual(["video", "image"]);
  });

  it("collects streamed audio nodes (music link) as sourceUrl assets", () => {
    const nodes = [
      { id: "edit", data: { kind: "edit" } },
      {
        id: "stream",
        data: {
          kind: "audio",
          media: null,
          music: {
            pageUrl: "https://music.163.com/song?id=1",
            streamPath: "/api/v1/music/stream?u=x",
            coverPath: null,
            title: "Song",
            artist: "",
            source: "netease",
            resolvedAt: 1,
          },
        },
      },
      {
        id: "card",
        data: {
          kind: "audio",
          media: null,
          music: {
            pageUrl: "https://y.qq.com/x",
            streamPath: null,
            coverPath: null,
            title: "Card",
            artist: "",
            source: "qq",
            resolvedAt: 1,
          },
        },
      },
      {
        id: "foreign",
        data: {
          kind: "audio",
          media: null,
          music: {
            pageUrl: "https://evil.example/x.mp3",
            streamPath: "https://evil.example/x.mp3",
            coverPath: null,
            title: "Evil",
            artist: "",
            source: "direct",
            resolvedAt: 1,
          },
        },
      },
    ] as unknown as WeftcanvasNode[];
    const edges = [
      { source: "stream", target: "edit" },
      { source: "card", target: "edit" },
      { source: "foreign", target: "edit" },
    ] as WeftcanvasEdge[];

    const assets = collectEditAssets(nodes, edges, "edit");
    expect(assets).toHaveLength(1);
    expect(assets[0]!.nodeId).toBe("stream");
    expect(assets[0]!.kind).toBe("audio");
    expect(assets[0]!.sourceUrl).toBe("/api/v1/music/stream?u=x");
    expect(assets[0]!.media.id).toBe("music-stream");
    expect(assets[0]!.media.name).toBe("Song");
  });

  it("formats timecode with tabular minute padding and hours", () => {
    expect(formatTimecode(0)).toBe("00:00");
    expect(formatTimecode(65_900)).toBe("01:05");
    expect(formatTimecode(3_661_000)).toBe("01:01:01");
  });

  it("keeps the minimum clip duration constraint in setClipRange", () => {
    const clip = {
      id: "a",
      track: "video",
      nodeId: "n",
      mediaId: "m",
      name: "v.mp4",
      kind: "video",
      sourceDurationMs: 1_000,
      inMs: 0,
      outMs: 1_000,
    } as const;
    const trimmed = setClipRange(clip, { inMs: 900 });
    expect(trimmed.outMs - trimmed.inMs).toBeGreaterThanOrEqual(EDIT_MIN_CLIP_DURATION_MS);
  });
});
