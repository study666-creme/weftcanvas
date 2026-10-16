import { describe, expect, it } from "vitest";

import { announcementListResponseSchema, publicAnnouncementSchema } from "./announcements.js";

const VALID = {
  id: "open-source",
  title: "开源说明",
  body: "纬线画布已经开源。\n\n开源地址：[去仓库看看](https://github.com/study666-creme/weftcanvas)",
  level: "important",
  pinned: true,
  publishedAt: "2026-10-16T08:00:00.000Z",
} as const;

describe("announcement contracts", () => {
  it("accepts a complete public announcement", () => {
    expect(publicAnnouncementSchema.parse(VALID)).toEqual(VALID);
  });

  it("rejects unknown levels, empty titles and non-ISO timestamps", () => {
    expect(publicAnnouncementSchema.safeParse({ ...VALID, level: "urgent" }).success).toBe(false);
    expect(publicAnnouncementSchema.safeParse({ ...VALID, title: "" }).success).toBe(false);
    expect(
      publicAnnouncementSchema.safeParse({ ...VALID, publishedAt: "10/16/2026" }).success,
    ).toBe(false);
  });

  it("wraps the list in the ok/data response envelope", () => {
    const parsed = announcementListResponseSchema.parse({ ok: true, data: { items: [VALID] } });
    expect(parsed.data.items).toHaveLength(1);
    expect(
      announcementListResponseSchema.safeParse({ ok: false, data: { items: [] } }).success,
    ).toBe(false);
  });
});
