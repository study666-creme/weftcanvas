import { create } from "zustand";

import {
  firstStepIndexForRoute,
  normalizeStepIndex,
  ONBOARDING_STEPS,
  readOnboardingDone,
  stepRunsOnRoute,
  writeOnboardingDone,
  type OnboardingRoute,
} from "../lib/onboarding";

/**
 * 新手教程的运行状态。
 *
 * 只活在本会话内存里（`done` 才落 localStorage）：教程走到一半刷新页面不会
 * 卡在某个半截步骤上，也不会把"还没看完"当成"看完了"。首屏挂载时 `start`
 * 只在 idle 状态生效，所以回来重进首屏不会把用户拽回第一步。
 */
export type OnboardingStatus = "idle" | "running" | "done";

type OnboardingState = {
  status: OnboardingStatus;
  stepIndex: number;
  /**
   * 「重看教程」这一次运行：一律从首屏第一步起步。标记它的原因只有一个——
   * 用户在画布上重看时，教程要先把人带回**首屏**（用户：「画布引导先要引导用户去
   * 首屏，然后从里面再去画布」），路由对齐不能把首屏那一步直接快进掉。
   */
  entryReplay: boolean;
  /** 首屏首次挂载时调用：已经跑过或已完成则不动。 */
  start: (route: OnboardingRoute) => void;
  /** 用户主动重看：从首屏第一步重新开始（人在画布上就先回到首屏）。 */
  replay: () => void;
  /** 路由切换后把进度对齐到新路由的第一步（首屏 ↔ 画布）。 */
  alignToRoute: (route: OnboardingRoute) => void;
  next: () => void;
  back: () => void;
  /** 完成或跳过：写存档，之后不再自动弹出。 */
  finish: () => void;
};

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  status: readOnboardingDone() ? "done" : "idle",
  stepIndex: 0,
  entryReplay: false,
  start: (route) => {
    if (get().status !== "idle") return;
    set({
      status: "running",
      stepIndex: normalizeStepIndex(firstStepIndexForRoute(route)),
      entryReplay: false,
    });
  },
  replay: () => set({ status: "running", stepIndex: 0, entryReplay: true }),
  alignToRoute: (route) => {
    const state = get();
    if (state.status !== "running") return;
    const step = ONBOARDING_STEPS[state.stepIndex];
    if (!step || stepRunsOnRoute(step, route)) return;
    // 重看的第一步就在首屏：人还站在画布上时这一步不能被对齐跳过，
    // 否则「先首屏、后画布」的次序当场就没了。
    if (state.entryReplay && state.stepIndex === 0) return;
    set({ stepIndex: normalizeStepIndex(firstStepIndexForRoute(route)) });
  },
  next: () => {
    const state = get();
    if (state.status !== "running") return;
    if (state.stepIndex >= ONBOARDING_STEPS.length - 1) {
      get().finish();
      return;
    }
    set({ stepIndex: state.stepIndex + 1 });
  },
  back: () => {
    const state = get();
    if (state.status !== "running" || state.stepIndex === 0) return;
    set({ stepIndex: state.stepIndex - 1 });
  },
  finish: () => {
    writeOnboardingDone();
    set({ status: "done", entryReplay: false });
  },
}));
