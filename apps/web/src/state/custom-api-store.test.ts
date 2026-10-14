import type { ModelModality, PublicModel } from "@weftcanvas/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CustomApiCatalog } from "../lib/custom-api";
import type { CustomApiProfile } from "./custom-api-store";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("custom API profile migration", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let module: typeof import("./custom-api-store");

  // Cold module compilation belongs to fixture setup, before the migration assertions.
  beforeAll(async () => {
    storage = memoryStorage();
    storage.setItem(
      "weftcanvas:custom-api:v1",
      JSON.stringify({
        baseUrl: "https://legacy.example",
        apiKey: "legacy-key",
      }),
    );
    vi.stubGlobal("localStorage", storage);

    module = await import("./custom-api-store");
  });

  it("migrates the previous single connection only after writing v2", () => {
    const state = module.useCustomApiStore.getState();

    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0]).toMatchObject({
      id: "legacy",
      name: "自有 API",
      connection: { baseUrl: "https://legacy.example", apiKey: "legacy-key" },
    });
    expect(JSON.parse(storage.getItem(module.CUSTOM_API_STORAGE_KEY)!)).toMatchObject({
      version: 2,
    });
    expect(storage.getItem("weftcanvas:custom-api:v1")).toBeNull();
  });
});

describe("merged model visibility", () => {
  it("keeps same-named profile models isolated and can hide every built-in model", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const module = await import("./custom-api-store");
    const { customModelKey } = await import("../lib/custom-api");
    const profileA = profile("profile-a", "图片 API A", "shared-image");
    const profileB = profile("profile-b", "图片 API B", "shared-image");
    const keyA = customModelKey("profile-a", "image", "shared-image");
    const keyB = customModelKey("profile-b", "image", "shared-image");

    expect(keyA).not.toBe(keyB);
    const merged = module.getMergedModels(
      [builtinModel("builtin-image")],
      "image",
      [profileA, profileB],
      ["builtin-image", keyA],
    );

    expect(merged.map((model) => model.id)).toEqual([keyB]);
    expect(merged[0]?.label).toContain("图片 API B");
  });

  it("makes manually-assigned audio models executable with the chat-completions route", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const module = await import("./custom-api-store");
    const audioProfile = profile("audio-profile", "音频 API", "voice-model", ["audio"]);

    const [choice] = module.getCustomModelChoices(
      { profiles: [audioProfile], hiddenModelKeys: [] },
      "audio",
      true,
    );
    expect(choice).toMatchObject({ rawModelId: "voice-model", executable: true });
    expect(choice?.unsupportedReason).toBeNull();
    expect(choice?.route).toMatchObject({
      modality: "audio",
      endpointPath: "/v1/chat/completions",
    });
  });

  it("surfaces knowledge-recognized models without manual tagging and keeps unknown ids out", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const module = await import("./custom-api-store");

    // 中转站只给官方 id：视频族自动落到视频模态、官方 id 直显。
    const bare = profile("bare", "裸中转", "doubao-seedance-2.0");
    bare.manualModelModalities = {};
    const [choice] = module.getCustomModelChoices(
      { profiles: [bare], hiddenModelKeys: [] },
      "video",
    );
    expect(choice?.model.label).toContain("doubao-seedance-2.0");
    expect(choice?.route).toMatchObject({ modality: "video", endpointPath: "/v1/videos" });
    expect(
      module.getCustomModelChoices({ profiles: [bare], hiddenModelKeys: [] }, "image"),
    ).toEqual([]);

    // 未识别 id 不进选择器，但手动标注后立刻可用——未识别不等于不可用。
    const unknown = profile("unknown", "未知中转", "vendor-mystery-model");
    unknown.manualModelModalities = {};
    expect(
      module.getCustomModelChoices({ profiles: [unknown], hiddenModelKeys: [] }, "video"),
    ).toEqual([]);
    unknown.manualModelModalities = { "vendor-mystery-model": ["video"] };
    expect(
      module.getCustomModelChoices({ profiles: [unknown], hiddenModelKeys: [] }, "video"),
    ).toHaveLength(1);
  });

  it("deduplicates rich aliases that resolve to one profile model", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const module = await import("./custom-api-store");
    const aliased = profile("profile-a", "图片 API", "shared-image");
    const now = new Date();
    aliased.catalog = {
      version: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      fetchedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      quoteAvailable: false,
      models: [
        { ...builtinModel("alias-a"), label: "别名 A" },
        { ...builtinModel("alias-b"), label: "别名 B" },
      ],
      routes: {
        "alias-a": {
          sourceModelId: "shared-image",
          modality: "image",
          endpointPath: "/v1/images/generations",
          parameters: [],
        },
        "alias-b": {
          sourceModelId: "shared-image",
          modality: "image",
          endpointPath: "/v1/images/generations",
          parameters: [],
        },
      },
      availableModelIds: ["shared-image"],
      capabilitySource: "rich",
      catalogWarning: null,
    };

    const choices = module.getCustomModelChoices(
      { profiles: [aliased], hiddenModelKeys: [] },
      "image",
    );

    expect(choices).toHaveLength(1);
    expect(choices[0]?.rawModelId).toBe("shared-image");
  });

  it("persists an explicit all-hidden set without treating it as show-all", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const module = await import("./custom-api-store");
    const store = module.useCustomApiStore.getState();

    store.setModelVisible("builtin-a", false);
    store.setModelVisible("builtin-b", false);

    expect(module.useCustomApiStore.getState().hiddenModelKeys).toEqual(["builtin-a", "builtin-b"]);
    expect(
      module.getMergedModels(
        [builtinModel("builtin-a"), builtinModel("builtin-b")],
        "image",
        [],
        module.useCustomApiStore.getState().hiddenModelKeys,
      ),
    ).toEqual([]);
  });
});

describe("channel sync diff", () => {
  it("reports upstream additions and removals, and stays silent otherwise", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const module = await import("./custom-api-store");

    // 首次拉取不算变更：没有可比对的"上一次"。
    expect(module.computeSyncDiff([], ["a", "b"], 1)).toBeNull();
    // 没有任何变化时不产生噪音提示（轮询每次都会走到这里）。
    expect(module.computeSyncDiff(["a", "b"], ["b", "a"], 2)).toBeNull();

    expect(module.computeSyncDiff(["a", "b"], ["a", "c", "d"], 3)).toEqual({
      added: ["c", "d"],
      removed: ["b"],
      at: 3,
    });
  });
});

function profile(
  id: string,
  name: string,
  modelId: string,
  modalities: ModelModality[] = ["image"],
): CustomApiProfile {
  return {
    id,
    name,
    connection: { baseUrl: `https://${id}.example`, apiKey: `${id}-key` },
    enabled: true,
    status: "ready",
    connecting: false,
    refreshing: false,
    catalog: null as CustomApiCatalog | null,
    error: null,
    loadedAt: Date.now(),
    availableModelIds: [modelId],
    manualModelModalities: { [modelId]: modalities },
    lastSyncDiff: null,
  };
}

function builtinModel(id: string): PublicModel {
  return {
    id,
    label: id,
    description: "",
    modality: "image",
    operation: "generate",
    order: 0,
    input: { textRequired: true },
    output: { type: "image", minCount: 1, maxCount: 1 },
    parameters: [],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}
