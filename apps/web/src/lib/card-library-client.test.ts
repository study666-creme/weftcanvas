import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cardLibraryDisplayImageUrls,
  clearCardLibraryCardsCache,
  downloadCardLibraryImages,
  getCachedCardLibraryCards,
  getCachedCardLibraryGroups,
  getCachedCardLibraryTags,
  listCardLibraryCards,
  listCardLibraryGroups,
  listCardLibraryTags,
} from "./card-library-client";

const responsePayload = {
  ok: true,
  data: {
    cards: [{
      id: "card-rain-shot",
      title: "雨夜镜头",
      prompt: "低机位跟拍",
      imageRef: "",
      imageRefs: [],
      thumbUrl: "",
      hasImage: false,
      tags: ["#分镜"],
      group: null,
      updatedAt: 1,
    }],
    total: 1,
    page: 1,
    limit: 18,
  },
};

const groupResponsePayload = {
  ok: true,
  data: { groups: ["分镜", "人物"] },
};

describe("card library list cache", () => {
  beforeEach(() => {
    clearCardLibraryCardsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deduplicates concurrent reads and reuses the scoped result", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(responsePayload));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      listCardLibraryCards({ page: 1, limit: 18 }, { cacheScope: "user-a" }),
      listCardLibraryCards({ page: 1, limit: 18 }, { cacheScope: "user-a" }),
    ]);
    const cached = await listCardLibraryCards({ page: 1, limit: 18 }, { cacheScope: "user-a" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(responsePayload.data);
    expect(second).toBe(first);
    expect(cached).toBe(first);
    expect(getCachedCardLibraryCards({ page: 1, limit: 18 }, "user-a")?.fresh).toBe(true);
  });

  it("isolates accounts and lets explicit refresh bypass a fresh cache", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(responsePayload));
    vi.stubGlobal("fetch", fetchMock);

    await listCardLibraryCards({ page: 1, limit: 18 }, { cacheScope: "user-a" });
    await listCardLibraryCards({ page: 1, limit: 18 }, { cacheScope: "user-b" });
    await listCardLibraryCards({ page: 1, limit: 18 }, { cacheScope: "user-a", force: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("normalizes group filters into the URL and scoped cache key", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => jsonResponse(responsePayload));
    vi.stubGlobal("fetch", fetchMock);

    await listCardLibraryCards({ page: 1, limit: 18, group: " 分镜 " }, { cacheScope: "user-a" });
    await listCardLibraryCards({ page: 1, limit: 18, group: "分镜" }, { cacheScope: "user-a" });
    await listCardLibraryCards({ page: 1, limit: 18, group: "uncategorized" }, { cacheScope: "user-a" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("group=%E5%88%86%E9%95%9C");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("group=uncategorized");
    expect(getCachedCardLibraryCards({ page: 1, limit: 18, group: "分镜" }, "user-a")?.fresh).toBe(true);
  });

  it("does not cache failed responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: { message: "暂时不可用" } }, 503))
      .mockResolvedValueOnce(jsonResponse(responsePayload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listCardLibraryCards({ page: 1, limit: 18 }, { cacheScope: "user-a" })).rejects.toMatchObject({ status: 503 });
    await expect(listCardLibraryCards({ page: 1, limit: 18 }, { cacheScope: "user-a" })).resolves.toEqual(responsePayload.data);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates and caches group reads per account for five minutes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = vi.fn(async () => jsonResponse(groupResponsePayload));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      listCardLibraryGroups({ cacheScope: "user-a" }),
      listCardLibraryGroups({ cacheScope: "user-a" }),
    ]);
    const cached = await listCardLibraryGroups({ cacheScope: "user-a" });
    await listCardLibraryGroups({ cacheScope: "user-b" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).toEqual(groupResponsePayload.data);
    expect(second).toBe(first);
    expect(cached).toBe(first);
    expect(getCachedCardLibraryGroups("user-a")?.fresh).toBe(true);

    now.mockReturnValue(5 * 60_000 + 1_001);
    expect(getCachedCardLibraryGroups("user-a")?.fresh).toBe(false);
  });

  it("clears group caches with card caches and does not cache group failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: { message: "暂时不可用" } }, 503))
      .mockImplementation(async () => jsonResponse(groupResponsePayload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listCardLibraryGroups({ cacheScope: "user-a" })).rejects.toMatchObject({ status: 503 });
    await expect(listCardLibraryGroups({ cacheScope: "user-a" })).resolves.toEqual(groupResponsePayload.data);
    await listCardLibraryGroups({ cacheScope: "user-b" });

    clearCardLibraryCardsCache("user-a");
    expect(getCachedCardLibraryGroups("user-a")).toBeNull();
    expect(getCachedCardLibraryGroups("user-b")?.fresh).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("card library tag filters and gallery downloads", () => {
  beforeEach(() => {
    clearCardLibraryCardsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes tag filters into the card list request", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => jsonResponse(responsePayload));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await listCardLibraryCards({ page: 1, limit: 18, tag: " 长焦 " }, { cacheScope: "user-a" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("tag=%E9%95%BF%E7%84%A6");
  });

  it("deduplicates and caches tag reads per account", async () => {
    const tagResponsePayload = { ok: true, data: { tags: ["#长焦", "#分镜"] } };
    const fetchMock = vi.fn(async () => jsonResponse(tagResponsePayload));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      listCardLibraryTags({ cacheScope: "user-a" }),
      listCardLibraryTags({ cacheScope: "user-a" }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(tagResponsePayload.data);
    expect(second).toBe(first);
    expect(getCachedCardLibraryTags("user-a")?.fresh).toBe(true);
  });

  it("downloads every gallery image and falls back to the same-origin proxy on CORS-style failures", async () => {
    const card = {
      id: "card-multi",
      title: "多图卡片",
      prompt: "p",
      imageRef: "storage://card-images/user/card-multi.jpg",
      imageRefs: ["storage://card-images/user/card-multi-2.jpg"],
      thumbUrl: "",
      hasImage: true,
      tags: [],
      group: null,
      updatedAt: 2,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/media-sign?")) {
        const ref = new URL(url, "https://canvas.test").searchParams.get("ref") ?? "";
        return jsonResponse({ ok: true, data: { url: `https://media.example/${encodeURIComponent(ref)}`, expiresIn: 3600, cdn: true } });
      }
      if (url === "https://media.example/storage%3A%2F%2Fcard-images%2Fuser%2Fcard-multi.jpg") {
        return imageResponse("image/jpeg");
      }
      if (url === "https://media.example/storage%3A%2F%2Fcard-images%2Fuser%2Fcard-multi-2.jpg") {
        return jsonResponse({ ok: false }, 500);
      }
      if (url.startsWith("/api/v1/card-library/media-proxy?")) {
        return imageResponse("image/png");
      }
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const blobs = await downloadCardLibraryImages(card);

    expect(blobs).toHaveLength(2);
    expect(blobs[0]).toBeInstanceOf(Blob);
    expect(blobs[1]).toBeInstanceOf(Blob);
    // 第二张图远端直连失败后必须经过同源代理。
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/v1/card-library/media-proxy?"))).toBe(true);
  });

  it("signs the same image ref once across repeated downloads", async () => {
    const card = {
      id: "card-single",
      title: "单图",
      prompt: "p",
      imageRef: "storage://card-images/user/card-single.jpg",
      imageRefs: [],
      thumbUrl: "",
      hasImage: true,
      tags: [],
      group: null,
      updatedAt: 3,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/media-sign?")) {
        return jsonResponse({ ok: true, data: { url: "https://media.example/full.jpg", expiresIn: 3600, cdn: true } });
      }
      return imageResponse("image/jpeg");
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadCardLibraryImages(card);
    await downloadCardLibraryImages(card);

    const signCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/media-sign?"));
    expect(signCalls).toHaveLength(1);
  });

  it("throws a card library error when no image can be downloaded", async () => {
    const card = {
      id: "card-none",
      title: "无图",
      prompt: "p",
      imageRef: "storage://card-images/user/card-none.jpg",
      imageRefs: [],
      thumbUrl: "",
      hasImage: true,
      tags: [],
      group: null,
      updatedAt: 4,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/media-sign?")) return jsonResponse({ ok: false }, 500);
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadCardLibraryImages(card)).rejects.toMatchObject({ name: "CardLibraryError" });
  });
});

describe("card library display image urls for the preview lightbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes https refs through without signing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const card = {
      id: "card-https",
      title: "直连图",
      prompt: "p",
      imageRef: "https://cdn.example/cover.png",
      imageRefs: ["https://cdn.example/extra.png"],
      thumbUrl: "https://cdn.example/thumb.png",
      hasImage: true,
      tags: [],
      group: null,
      updatedAt: 1,
    };

    await expect(cardLibraryDisplayImageUrls(card)).resolves.toEqual([
      "https://cdn.example/cover.png",
      "https://cdn.example/extra.png",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs storage refs in order and keeps only the resolvable ones", async () => {
    const card = {
      id: "card-signed",
      title: "签名图",
      prompt: "p",
      imageRef: "storage://card-images/user/cover.jpg",
      imageRefs: ["storage://card-images/user/extra.jpg"],
      thumbUrl: "/api/v1/card-library/card-thumbnails/cover.png",
      hasImage: true,
      tags: [],
      group: null,
      updatedAt: 2,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/media-sign?")) {
        const ref = new URL(url, "https://canvas.test").searchParams.get("ref") ?? "";
        if (ref.includes("extra")) return jsonResponse({ ok: false }, 500);
        return jsonResponse({ ok: true, data: { url: "https://media.example/signed-cover.jpg", expiresIn: 3600, cdn: true } });
      }
      throw new TypeError("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    // 第二张签名失败时跳过，不阻断封面。
    await expect(cardLibraryDisplayImageUrls(card)).resolves.toEqual(["https://media.example/signed-cover.jpg"]);
  });

  it("falls back to the thumbnail when nothing resolves", async () => {
    const card = {
      id: "card-thumb-only",
      title: "兜底图",
      prompt: "p",
      imageRef: "storage://card-images/user/gone.jpg",
      imageRefs: [],
      thumbUrl: "/api/v1/card-library/card-thumbnails/gone.png",
      hasImage: true,
      tags: [],
      group: null,
      updatedAt: 3,
    };
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(cardLibraryDisplayImageUrls(card)).resolves.toEqual(["/api/v1/card-library/card-thumbnails/gone.png"]);
  });

  it("returns an empty list for cards without any image", async () => {
    const card = {
      id: "card-text",
      title: "纯文本卡",
      prompt: "p",
      imageRef: "",
      imageRefs: [],
      thumbUrl: "",
      hasImage: false,
      tags: [],
      group: null,
      updatedAt: 4,
    };
    vi.stubGlobal("fetch", vi.fn());

    await expect(cardLibraryDisplayImageUrls(card)).resolves.toEqual([]);
  });
});

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function imageResponse(mimeType: string, status = 200) {
  return new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: mimeType }), {
    status,
    headers: { "Content-Type": mimeType },
  });
}
