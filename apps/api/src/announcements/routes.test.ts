import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { WeftcanvasCatalogAdapter } from "../catalog/adapter.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { buildNonMjSourceCatalog } from "../catalog/nonmj-catalog-fixture.js";
import { MemoryModelOverrideStore } from "../catalog/overrides.js";
import { MemoryAnnouncementStore, type AnnouncementCollection } from "./store.js";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const SECRET = "ops-s3cret";

function seed(): AnnouncementCollection {
  return {
    items: [
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
        id: "draft",
        title: "草稿",
        body: "停用中",
        level: "info",
        pinned: false,
        enabled: false,
        publishedAt: "2026-10-10T08:00:00.000Z",
        expiresAt: null,
      },
      {
        id: "scheduled",
        title: "定时公告",
        body: "还没到点",
        level: "info",
        pinned: false,
        enabled: true,
        publishedAt: "2026-11-01T08:00:00.000Z",
        expiresAt: null,
      },
    ],
  };
}

function appWith(
  options: { secret?: string; announcements?: MemoryAnnouncementStore | undefined } = {},
) {
  const adapter = new WeftcanvasCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    overrides: new MemoryModelOverrideStore(),
    now: () => NOW,
    fetch: async () =>
      new Response(JSON.stringify(buildNonMjSourceCatalog()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  const announcements =
    "announcements" in options ? options.announcements : new MemoryAnnouncementStore(seed());
  return createApiApp({
    catalog: adapter,
    quotes: new GenerationQuoteService(adapter, { now: () => NOW }),
    ...(announcements ? { announcements } : {}),
    ...(options.secret ? { announcementsAdminSecret: options.secret } : {}),
  });
}

describe("announcement routes", () => {
  it("serves only enabled, due and unexpired items to anonymous readers", async () => {
    const app = appWith();
    const response = await app.request("/api/v1/announcements");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string; level: string; pinned: boolean }> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.items.map((item) => item.id)).toEqual(["pinned-important"]);
    expect(payload.data.items[0]).toEqual({
      id: "pinned-important",
      title: "开源说明",
      body: "置顶的重要消息",
      level: "important",
      pinned: true,
      publishedAt: "2026-10-10T08:00:00.000Z",
    });
  });

  it("returns an empty list when no store is configured", async () => {
    const app = appWith({ announcements: undefined });
    const response = await app.request("/api/v1/announcements");
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toEqual({ ok: true, data: { items: [] } });
  });

  it("hides the admin surface without the ops secret", async () => {
    const app = appWith({ secret: SECRET });
    expect((await app.request("/api/v1/admin/announcements")).status).toBe(404);
    expect(
      (
        await app.request("/api/v1/admin/announcements", {
          headers: { "x-canvas-ops-secret": "nope" },
        })
      ).status,
    ).toBe(404);
    expect((await appWith().request("/api/v1/admin/announcements")).status).toBe(404);
  });

  it("reads and writes the collection behind the secret and applies it immediately", async () => {
    const store = new MemoryAnnouncementStore(seed());
    const app = appWith({ secret: SECRET, announcements: store });
    const headers = { "x-canvas-ops-secret": SECRET, "content-type": "application/json" };

    const before = (await (
      await app.request("/api/v1/admin/announcements", { headers })
    ).json()) as {
      data: AnnouncementCollection;
    };
    expect(before.data.items).toHaveLength(3);

    const next: AnnouncementCollection = {
      items: [
        {
          id: "fresh",
          title: "新公告",
          body: "刚发布",
          level: "info",
          pinned: false,
          enabled: true,
          publishedAt: "2026-10-16T09:00:00.000Z",
          expiresAt: null,
        },
      ],
    };
    const put = await app.request("/api/v1/admin/announcements", {
      method: "PUT",
      headers,
      body: JSON.stringify(next),
    });
    expect(put.status).toBe(200);

    const publicList = (await (await app.request("/api/v1/announcements")).json()) as {
      data: { items: Array<{ id: string }> };
    };
    expect(publicList.data.items.map((item) => item.id)).toEqual(["fresh"]);
  });

  it("rejects malformed collections with 422", async () => {
    const app = appWith({ secret: SECRET });
    const response = await app.request("/api/v1/admin/announcements", {
      method: "PUT",
      headers: { "x-canvas-ops-secret": SECRET, "content-type": "application/json" },
      body: JSON.stringify({ items: [{ id: "x", title: "", body: "", publishedAt: "bogus" }] }),
    });
    expect(response.status).toBe(422);
  });
});
