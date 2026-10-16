import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  JsonAnnouncementStore,
  MemoryAnnouncementStore,
  announcementCollectionSchema,
  publicAnnouncements,
  type AnnouncementCollection,
} from "./store.js";

const NOW = new Date("2026-10-16T12:00:00.000Z");

function collection(): AnnouncementCollection {
  return announcementCollectionSchema.parse({
    items: [
      {
        id: "old-info",
        title: "普通公告",
        body: "旧消息",
        level: "info",
        pinned: false,
        enabled: true,
        publishedAt: "2026-10-01T08:00:00.000Z",
        expiresAt: null,
      },
      {
        id: "pinned-important",
        title: "开源说明",
        body: "置顶的重要消息",
        level: "important",
        pinned: true,
        enabled: true,
        publishedAt: "2026-10-10T08:00:00.000Z",
        expiresAt: null,
      },
      {
        id: "disabled",
        title: "停用的公告",
        body: "不该出现",
        level: "info",
        pinned: false,
        enabled: false,
        publishedAt: "2026-10-01T08:00:00.000Z",
        expiresAt: null,
      },
      {
        id: "scheduled",
        title: "定时公告",
        body: "还没到点",
        level: "info",
        pinned: false,
        enabled: true,
        publishedAt: "2026-10-16T18:00:00.000Z",
        expiresAt: null,
      },
      {
        id: "expired",
        title: "已过期公告",
        body: "已经过期",
        level: "info",
        pinned: false,
        enabled: true,
        publishedAt: "2026-09-01T08:00:00.000Z",
        expiresAt: "2026-10-15T08:00:00.000Z",
      },
      {
        id: "fresh-info",
        title: "新公告",
        body: "比普通公告新",
        level: "info",
        pinned: false,
        enabled: true,
        publishedAt: "2026-10-15T08:00:00.000Z",
        expiresAt: null,
      },
    ],
  });
}

describe("announcement store", () => {
  it("drops disabled, scheduled and expired items and orders pinned first", () => {
    const items = publicAnnouncements(collection(), NOW);
    expect(items.map((item) => item.id)).toEqual(["pinned-important", "fresh-info", "old-info"]);
    // 公开视图不携带后台专用字段。
    expect(items[0]).not.toHaveProperty("enabled");
    expect(items[0]).not.toHaveProperty("expiresAt");
  });

  it("keeps the public/admin order stable for identical timestamps", () => {
    const items = publicAnnouncements(
      announcementCollectionSchema.parse({
        items: ["b", "a"].map((id) => ({
          id,
          title: id,
          body: "x",
          level: "info",
          pinned: false,
          enabled: true,
          publishedAt: "2026-10-01T08:00:00.000Z",
          expiresAt: null,
        })),
      }),
      NOW,
    );
    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("reads back what it wrote through the in-memory store", async () => {
    const store = new MemoryAnnouncementStore();
    expect((await store.load()).items).toEqual([]);
    await store.save(collection());
    expect((await store.load()).items).toHaveLength(6);
  });

  it("treats a missing or corrupt file as no announcements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "canvas-announcements-"));
    try {
      const missing = new JsonAnnouncementStore(join(directory, "announcements.json"));
      expect((await missing.load()).items).toEqual([]);

      const corruptPath = join(directory, "corrupt.json");
      await writeFile(corruptPath, "{ not json", "utf8");
      const corrupt = new JsonAnnouncementStore(corruptPath);
      expect((await corrupt.load()).items).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("round-trips a saved collection on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "canvas-announcements-"));
    try {
      const path = join(directory, "nested", "announcements.json");
      const store = new JsonAnnouncementStore(path);
      await store.save(collection());
      const reopened = new JsonAnnouncementStore(path);
      expect((await reopened.load()).items.map((item) => item.id)).toContain("pinned-important");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed items instead of persisting them", () => {
    expect(
      announcementCollectionSchema.safeParse({
        items: [{ id: "x", title: "", body: "y", publishedAt: "not-a-date" }],
      }).success,
    ).toBe(false);
  });
});
