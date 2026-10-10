import { describe, expect, it } from "vitest";

import {
  directMentionCandidates,
  insertDirectMention,
  mentionQueryAtCursor,
  reconcileDirectMentions,
  removeInvalidDirectMentions,
} from "./direct-generation-mentions";

const refs = [
  { id: "i1", kind: "image" as const, name: "front.png", status: "ready" as const },
  { id: "i2", kind: "image" as const, name: "back.png", status: "ready" as const },
  { id: "v1", kind: "video" as const, name: "clip.mp4", status: "ready" as const },
  { id: "i3", kind: "image" as const, name: "pending.png", status: "uploading" as const },
];

describe("direct generation mentions", () => {
  it("labels ready references by media kind and ignores pending uploads", () => {
    expect(directMentionCandidates(refs).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "i1", label: "图片1" },
      { id: "i2", label: "图片2" },
      { id: "v1", label: "视频1" },
    ]);
  });

  it("finds a mention query only at a whitespace boundary", () => {
    expect(mentionQueryAtCursor("电影 @图片", 6)).toEqual({ start: 3, end: 6, query: "图片" });
    expect(mentionQueryAtCursor("email@test", 10)).toBeNull();
  });

  it("replaces the active query and returns the next cursor position", () => {
    expect(insertDirectMention("让 @图片运动", { start: 2, end: 5 }, directMentionCandidates(refs)[0]!)).toEqual({
      value: "让 @图片1 运动",
      cursor: 7,
    });
  });

  it("removes stale media mention tokens after a reference is deleted", () => {
    expect(removeInvalidDirectMentions("使用 @图片1 和 @视频1 以及 @音频1", refs)).toBe("使用 @图片1 和 @视频1 以及 ");
  });

  it("keeps mentions attached to the same material when earlier numbering shifts", () => {
    expect(reconcileDirectMentions("保留 @图片1 和 @图片2", refs, refs.slice(1))).toBe("保留  和 @图片1");
  });

  it("supports full-width cursor boundaries without treating email addresses as mentions", () => {
    expect(mentionQueryAtCursor("请参考 @", 5)).toEqual({ start: 4, end: 5, query: "" });
    expect(mentionQueryAtCursor("mail @图片1@test", 10)).toBeNull();
  });
});
