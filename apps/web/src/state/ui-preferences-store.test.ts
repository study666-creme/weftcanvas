import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "weftcanvas:ui-preferences:v1";

describe("UI preferences", () => {
  beforeEach(() => {
    vi.resetModules();
    installMemoryStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("uses the spacious visual defaults", async () => {
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    expect(useUiPreferencesStore.getState()).toMatchObject({
      nodePortStyle: "classic",
      colorScheme: "graphite",
      chromeVisualStyle: "airy",
      canvasVisualStyle: "facet",
      canvasBackgroundStyle: "layered-grid",
      generationEffectStyle: "beam",
      edgePathStyle: "taut",
      edgeFlowStyle: "stream",
      defaultNodeAspectRatio: "16:9",
    });
    // 旧的多彩配色档位已下线：偏好里不应再有 accentPalette，
    // 配色收敛成 colorScheme 四档（石墨 / 墨黑 / 素陶 / 糖彩）。自绘光标仍是
    // 可选偏好（appearance-toolbar 提供 classic / precision 两档），必须保留。
    expect(useUiPreferencesStore.getState()).not.toHaveProperty("accentPalette");
    expect(useUiPreferencesStore.getState().cursorStyle).toBe("classic");
  });

  it("keeps the colour scheme independent of the node and chrome styles", async () => {
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    useUiPreferencesStore.getState().setColorScheme("ink");
    useUiPreferencesStore.getState().setCanvasVisualStyle("classic");

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      colorScheme: "ink",
      canvasVisualStyle: "classic",
    });

    vi.resetModules();
    const { useUiPreferencesStore: hydratedStore } = await import("./ui-preferences-store");
    expect(hydratedStore.getState()).toMatchObject({
      colorScheme: "ink",
      canvasVisualStyle: "classic",
    });
  });

  it("migrates the retired onyx scheme onto ink", async () => {
    // 「纯黑」已并入「墨黑」。老记录必须落在墨黑上，不能跳回默认的石墨/素陶，
    // 否则这批用户会突然从近黑跳到浅色或暖炭。
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ colorScheme: "onyx" }));
    vi.resetModules();
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    expect(useUiPreferencesStore.getState().colorScheme).toBe("ink");
  });

  it("falls back to graphite for unknown or missing stored schemes", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ colorScheme: "neon" }));
    vi.resetModules();
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    expect(useUiPreferencesStore.getState().colorScheme).toBe("graphite");
  });

  it("persists appearance choices and hydrates them after reload", async () => {
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    useUiPreferencesStore.getState().setCanvasVisualStyle("imax");
    useUiPreferencesStore.getState().setChromeVisualStyle("classic");
    useUiPreferencesStore.getState().setCanvasBackgroundStyle("water");
    useUiPreferencesStore.getState().setGenerationEffectStyle("nebula");
    useUiPreferencesStore.getState().setEdgePathStyle("gravity");
    useUiPreferencesStore.getState().setEdgeFlowStyle("stardust");
    useUiPreferencesStore.getState().setNodePortStyle("compact");
    useUiPreferencesStore.getState().setDefaultNodeAspectRatio("3:4");

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      nodePortStyle: "compact",
      colorScheme: "graphite",
      chromeVisualStyle: "classic",
      canvasVisualStyle: "imax",
      canvasBackgroundStyle: "water",
      generationEffectStyle: "nebula",
      edgePathStyle: "gravity",
      edgeFlowStyle: "stardust",
      companionStyle: "whale",
      companionAnchor: null,
      defaultNodeAspectRatio: "3:4",
      cursorStyle: "classic",
      localMediaOnly: false,
      lastMediaGeneration: {},
    });

    vi.resetModules();
    const { useUiPreferencesStore: hydratedStore } = await import("./ui-preferences-store");
    expect(hydratedStore.getState()).toMatchObject({
      nodePortStyle: "compact",
      chromeVisualStyle: "classic",
      canvasVisualStyle: "imax",
      canvasBackgroundStyle: "water",
      generationEffectStyle: "nebula",
      edgePathStyle: "gravity",
      edgeFlowStyle: "stardust",
      companionStyle: "whale",
      defaultNodeAspectRatio: "3:4",
      lastMediaGeneration: {},
    });
  });

  it("persists the local-only media preference and hydrates it after reload", async () => {
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    expect(useUiPreferencesStore.getState().localMediaOnly).toBe(false);
    useUiPreferencesStore.getState().setLocalMediaOnly(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).localMediaOnly).toBe(true);

    vi.resetModules();
    const { useUiPreferencesStore: hydratedStore } = await import("./ui-preferences-store");
    expect(hydratedStore.getState().localMediaOnly).toBe(true);
  });

  it("remembers the last generation settings per modality and hydrates them after reload", async () => {
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    useUiPreferencesStore.getState().setLastMediaGeneration("video", {
      modelId: "seedance-lite",
      parameters: { size: "16:9", duration: 5 },
      maxOutputTokens: null,
    });
    useUiPreferencesStore.getState().setLastMediaGeneration("image", {
      modelId: "image2-4k-fast",
      parameters: { size: "9:16" },
      maxOutputTokens: 4_096,
    });

    expect(useUiPreferencesStore.getState().lastMediaGeneration.video).toEqual({
      modelId: "seedance-lite",
      parameters: { size: "16:9", duration: 5 },
      maxOutputTokens: null,
    });

    vi.resetModules();
    const { useUiPreferencesStore: hydratedStore } = await import("./ui-preferences-store");
    expect(hydratedStore.getState().lastMediaGeneration.image).toEqual({
      modelId: "image2-4k-fast",
      parameters: { size: "9:16" },
      maxOutputTokens: 4_096,
    });
    expect(hydratedStore.getState().lastMediaGeneration.text).toBeUndefined();
  });

  it("drops malformed remembered generation settings when hydrating", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        lastMediaGeneration: {
          image: { modelId: "", parameters: {} },
          video: { modelId: "video-model", maxOutputTokens: null },
          audio: 42,
          text: { modelId: "text-model", parameters: { temperature: 0.7 }, maxOutputTokens: 512 },
        },
      }),
    );

    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    expect(useUiPreferencesStore.getState().lastMediaGeneration.image).toBeUndefined();
    expect(useUiPreferencesStore.getState().lastMediaGeneration.video).toBeUndefined();
    expect(useUiPreferencesStore.getState().lastMediaGeneration.audio).toBeUndefined();
    expect(useUiPreferencesStore.getState().lastMediaGeneration.text).toEqual({
      modelId: "text-model",
      parameters: { temperature: 0.7 },
      maxOutputTokens: 512,
    });
  });

  it("falls back independently when stored values are invalid", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        nodePortStyle: "unknown",
        canvasVisualStyle: "unknown",
        chromeVisualStyle: "unknown",
        canvasBackgroundStyle: "unknown",
        generationEffectStyle: "unknown",
        edgePathStyle: "unknown",
        edgeFlowStyle: "unknown",
        defaultNodeAspectRatio: "unknown",
      }),
    );

    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    expect(useUiPreferencesStore.getState()).toMatchObject({
      nodePortStyle: "classic",
      chromeVisualStyle: "airy",
      canvasVisualStyle: "facet",
      canvasBackgroundStyle: "layered-grid",
      generationEffectStyle: "beam",
      edgePathStyle: "taut",
      edgeFlowStyle: "stream",
      defaultNodeAspectRatio: "16:9",
    });
  });

  it("normalizes retired cosmos and lingjing presets onto the spacious default", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        canvasVisualStyle: "cosmos",
        chromeVisualStyle: "lingjing",
      }),
    );

    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    expect(useUiPreferencesStore.getState()).toMatchObject({
      canvasVisualStyle: "facet",
      chromeVisualStyle: "airy",
    });
  });

  it("keeps a stored studio choice instead of forcing the new default", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        canvasVisualStyle: "studio",
        chromeVisualStyle: "studio",
      }),
    );

    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    expect(useUiPreferencesStore.getState()).toMatchObject({
      canvasVisualStyle: "studio",
      chromeVisualStyle: "studio",
    });
  });

  it("hydrates older v1 preferences without split chrome or aspect-ratio fields", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        canvasVisualStyle: "classic",
      }),
    );

    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    expect(useUiPreferencesStore.getState()).toMatchObject({
      canvasVisualStyle: "classic",
      chromeVisualStyle: "classic",
      edgePathStyle: "taut",
      defaultNodeAspectRatio: "16:9",
    });
  });

  it("keeps the IMAX preset node-only when stored chrome data is invalid", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        canvasVisualStyle: "imax",
        chromeVisualStyle: "imax",
      }),
    );

    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    expect(useUiPreferencesStore.getState()).toMatchObject({
      canvasVisualStyle: "imax",
      chromeVisualStyle: "airy",
    });
  });

  it("persists the quiet generation effect and hydrates it after reload", async () => {
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    useUiPreferencesStore.getState().setGenerationEffectStyle("quiet");

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      generationEffectStyle: "quiet",
    });

    vi.resetModules();
    const { useUiPreferencesStore: hydratedStore } = await import("./ui-preferences-store");
    expect(hydratedStore.getState()).toMatchObject({
      generationEffectStyle: "quiet",
    });
  });

  it("falls back to beam when a stored generation effect is not a known style", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        generationEffectStyle: "strobe",
      }),
    );

    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    expect(useUiPreferencesStore.getState()).toMatchObject({
      generationEffectStyle: "beam",
    });
  });
});

function installMemoryStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

describe("companion anchor", () => {
  beforeEach(installMemoryStorage);
  afterEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("keeps a dragged position and a docked panel across reloads", async () => {
    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    useUiPreferencesStore.getState().setCompanionAnchor({ kind: "free", x: 220, y: 340 });
    useUiPreferencesStore
      .getState()
      .setCompanionAnchor({ kind: "dock", dock: "edit-dock", x: 0.7 });

    vi.resetModules();
    const { useUiPreferencesStore: hydrated } = await import("./ui-preferences-store");
    expect(hydrated.getState().companionAnchor).toEqual({
      kind: "dock",
      dock: "edit-dock",
      x: 0.7,
    });
  });

  it("migrates a legacy node perch back to the default spot", async () => {
    // 老版本把她存成「坐在某个节点上」。她不许挂节点（用户 2026-10-15），
    // 所以旧存档读回时降级成 null = 默认位（天上），而不是留一个解不出位置的锚点。
    localStorage.setItem(
      "weftcanvas:ui-preferences:v1",
      JSON.stringify({ companionAnchor: { kind: "node", nodeId: "node-7" } }),
    );

    vi.resetModules();
    const { useUiPreferencesStore: hydrated } = await import("./ui-preferences-store");
    expect(hydrated.getState().companionAnchor).toBeNull();
  });

  it("clears back to the default spot with null", async () => {
    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    useUiPreferencesStore.getState().setCompanionAnchor({ kind: "free", x: 10, y: 10 });
    useUiPreferencesStore.getState().setCompanionAnchor(null);
    expect(useUiPreferencesStore.getState().companionAnchor).toBeNull();
  });

  it("drops unknown dock names and out-of-range fractions instead of trusting them", async () => {
    const { normalizeCompanionAnchor } = await import("./ui-preferences-store");
    expect(normalizeCompanionAnchor({ kind: "dock", dock: "made-up-panel", x: 0.5 })).toBeNull();
    expect(normalizeCompanionAnchor({ kind: "dock", dock: "edit-dock", x: 9 })).toEqual({
      kind: "dock",
      dock: "edit-dock",
      x: 0.94,
    });
    expect(normalizeCompanionAnchor({ kind: "free", x: Number.NaN, y: 10 })).toBeNull();
    // 节点锚点已取消：任何形态的 node 锚点都降级成 null（回天上）。
    expect(normalizeCompanionAnchor({ kind: "node", nodeId: "node-1" })).toBeNull();
    expect(normalizeCompanionAnchor({ kind: "node" })).toBeNull();
    expect(normalizeCompanionAnchor({ kind: "node", nodeId: "" })).toBeNull();
    expect(normalizeCompanionAnchor("junk")).toBeNull();
  });
});

describe("appearance pack registry (P1)", () => {
  beforeEach(() => {
    vi.resetModules();
    installMemoryStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("hydrates a registered pack option without rollback", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ edgePathStyle: "amber-edge" }));
    vi.resetModules();
    const { registerAppearanceOption } = await import("../lib/appearance-registry");
    registerAppearanceOption("edgePathStyle", { id: "amber-edge", label: "琥珀" });
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    expect(useUiPreferencesStore.getState().edgePathStyle).toBe("amber-edge");
  });

  it("falls back to the builtin default for values nothing registers", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ edgePathStyle: "cosmos-curve" }));
    vi.resetModules();
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    expect(useUiPreferencesStore.getState().edgePathStyle).toBe("taut");
  });

  it("keeps every legacy stored builtin choice after reload (onyx chrome included)", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        canvasVisualStyle: "onyx",
        chromeVisualStyle: "onyx",
        canvasBackgroundStyle: "onyx",
        generationEffectStyle: "quiet",
        nodePortStyle: "compact",
        cursorStyle: "precision",
      }),
    );
    vi.resetModules();
    const { useUiPreferencesStore } = await import("./ui-preferences-store");

    expect(useUiPreferencesStore.getState()).toMatchObject({
      canvasVisualStyle: "onyx",
      chromeVisualStyle: "onyx",
      canvasBackgroundStyle: "onyx",
      generationEffectStyle: "quiet",
      nodePortStyle: "compact",
      cursorStyle: "precision",
    });
  });

  it("falls back to the default on the next load after a pack unregisters", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ edgePathStyle: "amber-edge" }));
    vi.resetModules();
    const { registerAppearanceOption } = await import("../lib/appearance-registry");
    const unregister = registerAppearanceOption("edgePathStyle", {
      id: "amber-edge",
      label: "琥珀",
    });
    const { useUiPreferencesStore } = await import("./ui-preferences-store");
    expect(useUiPreferencesStore.getState().edgePathStyle).toBe("amber-edge");
    unregister();

    // 下一"次加载"（重置模块、注册表回到内置集）读取同一份存量偏好。
    vi.resetModules();
    const { useUiPreferencesStore: reloaded } = await import("./ui-preferences-store");
    expect(reloaded.getState().edgePathStyle).toBe("taut");
  });
});
