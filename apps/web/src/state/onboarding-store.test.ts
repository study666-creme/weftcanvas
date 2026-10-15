import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "weftcanvas:onboarding:v1";

describe("新手教程状态", () => {
  beforeEach(() => {
    vi.resetModules();
    installMemoryStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("第一次进首屏会自动开跑，重复进首屏不会把进度拽回第一步", async () => {
    const { useOnboardingStore } = await import("./onboarding-store");

    expect(useOnboardingStore.getState().status).toBe("idle");
    useOnboardingStore.getState().start("home");
    useOnboardingStore.getState().next();
    expect(useOnboardingStore.getState().stepIndex).toBe(1);

    // 路由回来重进首屏：start 只在 idle 生效。
    useOnboardingStore.getState().start("home");
    expect(useOnboardingStore.getState().stepIndex).toBe(1);
  });

  it("首屏 → 画布时把进度对齐到画布那一段的第一步", async () => {
    const { useOnboardingStore } = await import("./onboarding-store");

    useOnboardingStore.getState().start("home");
    useOnboardingStore.getState().alignToRoute("canvas");
    const { ONBOARDING_STEPS } = await import("../lib/onboarding");
    expect(ONBOARDING_STEPS[useOnboardingStore.getState().stepIndex]!.id).toBe("create-node");

    // 同路由重复对齐不动进度。
    useOnboardingStore.getState().next();
    const advanced = useOnboardingStore.getState().stepIndex;
    useOnboardingStore.getState().alignToRoute("canvas");
    expect(useOnboardingStore.getState().stepIndex).toBe(advanced);
  });

  it("重看从首屏第一步起，人在画布上也不会被对齐快进到画布那一段", async () => {
    const { useOnboardingStore } = await import("./onboarding-store");
    const { ONBOARDING_STEPS } = await import("../lib/onboarding");

    // 用户在画布上按「重看新手教程」：App 会先把路由切回首屏，对齐在那之前
    // 不能把首屏这一步跳掉（用户：先引导去首屏，再从里面进画布）。
    useOnboardingStore.getState().replay();
    expect(ONBOARDING_STEPS[useOnboardingStore.getState().stepIndex]!.id).toBe("workbench");
    useOnboardingStore.getState().alignToRoute("canvas");
    expect(ONBOARDING_STEPS[useOnboardingStore.getState().stepIndex]!.id).toBe("workbench");

    // 首屏走完，点「进入画布」→ 对齐照旧把进度接到画布那一段。
    useOnboardingStore.getState().next();
    useOnboardingStore.getState().alignToRoute("canvas");
    expect(ONBOARDING_STEPS[useOnboardingStore.getState().stepIndex]!.id).toBe("create-node");
  });

  it("走完最后一步即完成，并写入不再自动弹出的存档", async () => {
    const { useOnboardingStore } = await import("./onboarding-store");
    const { ONBOARDING_STEPS } = await import("../lib/onboarding");

    useOnboardingStore.getState().replay();
    for (let index = 0; index < ONBOARDING_STEPS.length; index += 1) {
      useOnboardingStore.getState().next();
    }

    expect(useOnboardingStore.getState().status).toBe("done");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("done");

    // 下次加载：已完成，直接 idle 不再起教程。
    vi.resetModules();
    const { useOnboardingStore: reloaded } = await import("./onboarding-store");
    expect(reloaded.getState().status).toBe("done");
    reloaded.getState().start("home");
    expect(reloaded.getState().status).toBe("done");
  });

  it("跳过即完成，之后仍可从画布重看（一律回到首屏第一步）", async () => {
    const { useOnboardingStore } = await import("./onboarding-store");
    const { ONBOARDING_STEPS } = await import("../lib/onboarding");

    useOnboardingStore.getState().start("home");
    useOnboardingStore.getState().finish();
    expect(useOnboardingStore.getState().status).toBe("done");

    useOnboardingStore.getState().replay();
    expect(useOnboardingStore.getState().status).toBe("running");
    expect(ONBOARDING_STEPS[useOnboardingStore.getState().stepIndex]!.id).toBe("workbench");
  });

  it("上一步回到起点即停住，不会退成负下标", async () => {
    const { useOnboardingStore } = await import("./onboarding-store");

    useOnboardingStore.getState().start("home");
    useOnboardingStore.getState().back();
    expect(useOnboardingStore.getState().stepIndex).toBe(0);
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
