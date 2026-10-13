import { afterEach, describe, expect, it } from "vitest";

import {
  DIRECT_DRAFT_SESSION_KEY,
  DIRECT_REFERENCE_SESSION_KEY,
  clearDirectDraftSession,
  clearDirectReferenceSession,
  initialDirectDraftSession,
  initialDirectReferenceSession,
  isDirectGenerationPath,
  persistDirectDraft,
  readDirectDraftSession,
  readDirectReferenceSession,
  restoreDirectReferenceSession,
  writeDirectDraftSession,
  writeDirectReferenceSession,
} from "./direct-reference-session";
import type { DirectReference } from "../state/direct-reference-store";

type MemoryStorage = {
  setItem(key: string, value: string): void;
  getItem(key: string): string | null;
  removeItem(key: string): void;
};

function installMemoryStorage(): MemoryStorage {
  const entries = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => entries.set(key, value),
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => entries.delete(key),
    entries,
  };
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

function makeReference(overrides: Partial<DirectReference> = {}): DirectReference {
  return {
    id: "ref-1",
    kind: "image",
    name: "reference.png",
    previewUrl: "blob:http://localhost/abc",
    serverId: "server-1",
    status: "ready",
    error: null,
    uploadKey: "upload:key-1",
    imagePurpose: null,
    durationMs: null,
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).sessionStorage;
});

describe("isDirectGenerationPath", () => {
  it("accepts the workbench root and modality routes", () => {
    expect(isDirectGenerationPath("/generate")).toBe(true);
    expect(isDirectGenerationPath("/generate/image")).toBe(true);
    expect(isDirectGenerationPath("/generate/video")).toBe(true);
    expect(isDirectGenerationPath("/generate/image?autosubmit=1")).toBe(true);
  });

  it("rejects other routes", () => {
    expect(isDirectGenerationPath("/")).toBe(false);
    expect(isDirectGenerationPath("/canvas")).toBe(false);
    expect(isDirectGenerationPath("/catalog")).toBe(false);
    expect(isDirectGenerationPath("/generation")).toBe(false);
  });
});

describe("writeDirectReferenceSession", () => {
  it("persists only ready references with a server id", () => {
    const storage = installMemoryStorage();
    writeDirectReferenceSession({
      image: [
        makeReference(),
        makeReference({ id: "ref-2", status: "uploading", serverId: null }),
        makeReference({ id: "ref-3", status: "error", serverId: "server-3" }),
      ],
      video: [],
      audio: [],
    });
    const stored = storage.getItem(DIRECT_REFERENCE_SESSION_KEY);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as {
      schemaVersion: number;
      image: unknown[];
      video: unknown[];
    };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.image).toHaveLength(1);
    expect(parsed.image[0]).toMatchObject({
      id: "ref-1",
      kind: "image",
      name: "reference.png",
      serverId: "server-1",
      imagePurpose: null,
      durationMs: null,
    });
    expect(parsed.video).toEqual([]);
  });

  it("persists the probed duration of video references", () => {
    const storage = installMemoryStorage();
    writeDirectReferenceSession({
      image: [],
      video: [makeReference({ id: "ref-v", kind: "video", durationMs: 6_500 })],
      audio: [],
    });
    const parsed = JSON.parse(storage.getItem(DIRECT_REFERENCE_SESSION_KEY) as string) as {
      video: Array<{ durationMs: unknown }>;
    };
    expect(parsed.video[0]?.durationMs).toBe(6_500);
  });

  it("stores the image purpose for image references only", () => {
    const storage = installMemoryStorage();
    writeDirectReferenceSession({
      image: [makeReference({ imagePurpose: "styleImages" })],
      video: [makeReference({ id: "ref-v", kind: "video", imagePurpose: "images" })],
      audio: [],
    });
    const parsed = JSON.parse(storage.getItem(DIRECT_REFERENCE_SESSION_KEY) as string) as {
      image: Array<{ imagePurpose: unknown }>;
      video: Array<{ imagePurpose: unknown }>;
    };
    expect(parsed.image[0]?.imagePurpose).toBe("styleImages");
    expect(parsed.video[0]?.imagePurpose).toBeNull();
  });

  it("clears the key when every modality is empty", () => {
    const storage = installMemoryStorage();
    storage.setItem(DIRECT_REFERENCE_SESSION_KEY, '{"schemaVersion":1,"image":[],"video":[]}');
    writeDirectReferenceSession({ image: [], video: [], audio: [] });
    expect(storage.getItem(DIRECT_REFERENCE_SESSION_KEY)).toBeNull();
  });
});

describe("readDirectReferenceSession", () => {
  it("returns null for absent, malformed, or wrongly versioned data", () => {
    const storage = installMemoryStorage();
    expect(readDirectReferenceSession()).toBeNull();

    storage.setItem(DIRECT_REFERENCE_SESSION_KEY, "not-json");
    expect(readDirectReferenceSession()).toBeNull();

    storage.setItem(DIRECT_REFERENCE_SESSION_KEY, '{"schemaVersion":99,"image":[],"video":[]}');
    expect(readDirectReferenceSession()).toBeNull();

    storage.setItem(DIRECT_REFERENCE_SESSION_KEY, '"a string"');
    expect(readDirectReferenceSession()).toBeNull();
  });

  it("drops invalid entries and normalizes image purposes", () => {
    const storage = installMemoryStorage();
    storage.setItem(
      DIRECT_REFERENCE_SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        image: [
          { id: "ok", kind: "image", name: "a.png", serverId: "s-1", imagePurpose: "styleImages" },
          { id: "bad-kind", kind: "sticker", name: "b.png", serverId: "s-2", imagePurpose: null },
          {
            id: "bad-purpose",
            kind: "image",
            name: "c.png",
            serverId: "s-3",
            imagePurpose: "gallery",
          },
          { id: "missing-server", kind: "image", name: "d.png", serverId: "", imagePurpose: null },
          {
            id: "video-purpose",
            kind: "video",
            name: "e.mp4",
            serverId: "s-5",
            imagePurpose: "images",
          },
          null,
          "garbage",
        ],
        video: [],
      }),
    );
    const session = readDirectReferenceSession();
    expect(session).not.toBeNull();
    expect(session?.image.map((item) => item.id)).toEqual(["ok", "bad-purpose", "video-purpose"]);
    expect(session?.image[1]?.imagePurpose).toBeNull();
    expect(session?.image[2]?.imagePurpose).toBeNull();
  });
});

describe("restoreDirectReferenceSession", () => {
  it("rebuilds references with server preview paths, fresh upload keys, and ready status", () => {
    const storage = installMemoryStorage();
    storage.setItem(
      DIRECT_REFERENCE_SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        image: [
          {
            id: "ref-1",
            kind: "image",
            name: "reference.png",
            serverId: "server-1",
            imagePurpose: "elementImages",
          },
        ],
        video: [],
      }),
    );
    const restored = restoreDirectReferenceSession();
    expect(restored.image).toHaveLength(1);
    const reference = restored.image[0]!;
    expect(reference.id).toBe("ref-1");
    expect(reference.name).toBe("reference.png");
    expect(reference.kind).toBe("image");
    expect(reference.serverId).toBe("server-1");
    expect(reference.imagePurpose).toBe("elementImages");
    expect(reference.status).toBe("ready");
    expect(reference.error).toBeNull();
    expect(reference.previewUrl).toContain("/api/v1/media/server-1/content");
    expect(reference.uploadKey).toMatch(/^restored-session:/);
  });

  it("returns empty collections when the session is absent", () => {
    installMemoryStorage();
    expect(restoreDirectReferenceSession()).toEqual({ image: [], video: [], audio: [] });
  });

  it("restores a v1 session without durations and lets the studio backfill them", () => {
    // 升级前写入的会话没有 durationMs：恢复不能失败，时长列为 null，由工作台
    // 补查一次素材元数据。
    const storage = installMemoryStorage();
    storage.setItem(
      DIRECT_REFERENCE_SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        image: [],
        video: [
          {
            id: "ref-v",
            kind: "video",
            name: "clip.mp4",
            serverId: "server-v",
            imagePurpose: null,
          },
        ],
      }),
    );
    const restored = restoreDirectReferenceSession();
    expect(restored.video).toHaveLength(1);
    expect(restored.video[0]).toMatchObject({
      id: "ref-v",
      serverId: "server-v",
      status: "ready",
      durationMs: null,
    });
  });
});

describe("clearDirectReferenceSession", () => {
  it("removes the stored key", () => {
    const storage = installMemoryStorage();
    storage.setItem(DIRECT_REFERENCE_SESSION_KEY, "{}");
    clearDirectReferenceSession();
    expect(storage.getItem(DIRECT_REFERENCE_SESSION_KEY)).toBeNull();
  });
});

describe("initialDirectReferenceSession", () => {
  it("hydrates on workbench routes", () => {
    const storage = installMemoryStorage();
    expect(initialDirectReferenceSession("/generate/image")).toEqual({
      image: [],
      video: [],
      audio: [],
    });
    writeDirectReferenceSession({ image: [makeReference()], video: [], audio: [] });
    expect(initialDirectReferenceSession("/generate/video").image).toHaveLength(1);
    expect(storage.getItem(DIRECT_REFERENCE_SESSION_KEY)).toBeTruthy();
  });

  it("clears the session when leaving the workbench", () => {
    const storage = installMemoryStorage();
    storage.setItem(
      DIRECT_REFERENCE_SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        image: [{ id: "ref-1", kind: "image", name: "a.png", serverId: "s-1", imagePurpose: null }],
        video: [],
      }),
    );
    expect(initialDirectReferenceSession("/canvas")).toEqual({ image: [], video: [], audio: [] });
    expect(storage.getItem(DIRECT_REFERENCE_SESSION_KEY)).toBeNull();
  });

  it("stays empty when sessionStorage is unavailable", () => {
    expect(initialDirectReferenceSession("/generate/image")).toEqual({
      image: [],
      video: [],
      audio: [],
    });
  });
});

describe("writeDirectDraftSession", () => {
  it("persists prompt, model, parameters, quantity, and token maximum", () => {
    const storage = installMemoryStorage();
    writeDirectDraftSession({
      image: {
        prompt: "一座被雨水照亮的未来城市",
        modelId: "home-image",
        parameters: { quality: "2k", count: 3 },
        quantity: 2,
        maxOutputTokens: 2_048,
      },
      video: null,
      audio: null,
    });
    const parsed = JSON.parse(storage.getItem(DIRECT_DRAFT_SESSION_KEY) as string) as {
      schemaVersion: number;
      image: Record<string, unknown>;
      video: unknown;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.image).toMatchObject({
      prompt: "一座被雨水照亮的未来城市",
      modelId: "home-image",
      parameters: { quality: "2k", count: 3 },
      quantity: 2,
      maxOutputTokens: 2_048,
    });
    expect(parsed.video).toBeNull();
  });

  it("clears the key when every modality draft is empty", () => {
    const storage = installMemoryStorage();
    storage.setItem(DIRECT_DRAFT_SESSION_KEY, '{"schemaVersion":1,"image":null,"video":null}');
    writeDirectDraftSession({ image: null, video: null, audio: null });
    expect(storage.getItem(DIRECT_DRAFT_SESSION_KEY)).toBeNull();
  });
});

describe("readDirectDraftSession", () => {
  it("returns null for absent, malformed, or wrongly versioned data", () => {
    const storage = installMemoryStorage();
    expect(readDirectDraftSession()).toBeNull();
    storage.setItem(DIRECT_DRAFT_SESSION_KEY, "not-json");
    expect(readDirectDraftSession()).toBeNull();
    storage.setItem(DIRECT_DRAFT_SESSION_KEY, '{"schemaVersion":99,"image":null,"video":null}');
    expect(readDirectDraftSession()).toBeNull();
  });

  it("normalizes parameter values and clamps quantity and tokens", () => {
    const storage = installMemoryStorage();
    storage.setItem(
      DIRECT_DRAFT_SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        image: {
          prompt: "x".repeat(5_000),
          modelId: "home-image",
          parameters: { ok: "yes", num: 2, bool: true, nested: { a: 1 }, big: "y".repeat(5_000) },
          quantity: 500,
          maxOutputTokens: 999_999,
        },
        video: null,
      }),
    );
    const session = readDirectDraftSession();
    expect(session?.image?.prompt).toHaveLength(4_000);
    expect(session?.image?.parameters).toEqual({
      ok: "yes",
      num: 2,
      bool: true,
      big: "y".repeat(2_000),
    });
    expect(session?.image?.quantity).toBe(99);
    expect(session?.image?.maxOutputTokens).toBe(32_768);
  });

  it("drops empty drafts (no prompt and no model)", () => {
    const storage = installMemoryStorage();
    storage.setItem(
      DIRECT_DRAFT_SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        image: { prompt: "", modelId: "", parameters: {}, quantity: 1, maxOutputTokens: null },
        video: {
          prompt: "hint",
          modelId: "home-video",
          parameters: {},
          quantity: 1,
          maxOutputTokens: null,
        },
      }),
    );
    const session = readDirectDraftSession();
    expect(session?.image).toBeNull();
    expect(session?.video?.prompt).toBe("hint");
  });
});

describe("persistDirectDraft", () => {
  it("caps field sizes and rejects non-JSON-safe values", () => {
    const persisted = persistDirectDraft({
      prompt: "p".repeat(10_000),
      modelId: "m",
      parameters: { fn: () => 1, sym: Symbol("x"), ok: 5 },
      quantity: Number.NaN,
      maxOutputTokens: 0,
    });
    expect(persisted.prompt).toHaveLength(4_000);
    expect(persisted.parameters).toEqual({ ok: 5 });
    expect(persisted.quantity).toBe(1);
    expect(persisted.maxOutputTokens).toBe(1);
  });
});

describe("initialDirectDraftSession", () => {
  it("hydrates on workbench routes and leaves the key intact", () => {
    const storage = installMemoryStorage();
    writeDirectDraftSession({
      image: {
        prompt: "夜晚的港口",
        modelId: "home-image",
        parameters: {},
        quantity: 1,
        maxOutputTokens: null,
      },
      video: null,
      audio: null,
    });
    const session = initialDirectDraftSession("/generate/image");
    expect(session?.image?.prompt).toBe("夜晚的港口");
    expect(storage.getItem(DIRECT_DRAFT_SESSION_KEY)).toBeTruthy();
  });

  it("clears the draft session when leaving the workbench", () => {
    const storage = installMemoryStorage();
    storage.setItem(
      DIRECT_DRAFT_SESSION_KEY,
      JSON.stringify({
        schemaVersion: 1,
        image: { prompt: "p", modelId: "m", parameters: {}, quantity: 1, maxOutputTokens: 1_024 },
        video: null,
      }),
    );
    const session = initialDirectDraftSession("/canvas");
    expect(session?.image).toBeNull();
    expect(session?.video).toBeNull();
    expect(storage.getItem(DIRECT_DRAFT_SESSION_KEY)).toBeNull();
  });
});

describe("clearDirectDraftSession", () => {
  it("removes the stored key", () => {
    const storage = installMemoryStorage();
    storage.setItem(DIRECT_DRAFT_SESSION_KEY, "{}");
    clearDirectDraftSession();
    expect(storage.getItem(DIRECT_DRAFT_SESSION_KEY)).toBeNull();
  });
});
