import { useSyncExternalStore } from "react";

/**
 * 外观/效果包注册表（docs/PLUGIN-ROADMAP.md §4 P1）：把 ui-preferences 的
 * 外观枚举改为开放注册。内置选项在 ./builtin-appearance 登记；外观包
 * （如琥珀边形演示包）在应用启动或插件装载时调用 registerAppearanceOption，
 * 设置中心的面板按钮随注册表自动增减。
 *
 * 未知存量值的回落由 ui-preferences-store 的 read normalize 负责：
 * isRegisteredAppearanceValue 是唯一的"这个档位现在存不存在"判定源。
 */
export type AppearanceSlot =
  | "canvasVisualStyle"
  | "chromeVisualStyle"
  | "canvasBackgroundStyle"
  | "generationEffectStyle"
  | "edgePathStyle"
  | "edgeFlowStyle"
  | "cursorStyle"
  | "nodePortStyle";

export type AppearanceOption = {
  id: string;
  label: string;
  /**
   * 连线线形档声明复用哪种内置几何（is-soft-curve 类名与默认曲率）。
   * 纯 CSS 换肤的线形包（如琥珀）声明 "taut" 即可，不用碰路径生成。
   */
  geometry?: "taut" | "gravity";
  /** 覆盖内置几何的默认曲率（贝塞尔 curvature）。 */
  pathCurvature?: number;
  /** 内置档位标记；仅供诊断，卸载行为与注册档位一致。 */
  builtin?: boolean;
};

const slots = new Map<AppearanceSlot, Map<string, AppearanceOption>>();
const snapshots = new Map<AppearanceSlot, readonly AppearanceOption[]>();
const listeners = new Set<() => void>();

function snapshotFor(slot: AppearanceSlot): readonly AppearanceOption[] {
  const existing = snapshots.get(slot);
  if (existing) return existing;
  const options = [...(slots.get(slot)?.values() ?? [])];
  snapshots.set(slot, options);
  return options;
}

function emitChange() {
  snapshots.clear();
  for (const listener of listeners) listener();
}

/** 注册一个外观档位；同槽位同 id 重复注册直接报错。返回卸载函数。 */
export function registerAppearanceOption(
  slot: AppearanceSlot,
  option: AppearanceOption,
): () => void {
  let bucket = slots.get(slot);
  if (!bucket) {
    bucket = new Map();
    slots.set(slot, bucket);
  }
  if (bucket.has(option.id)) {
    throw new Error(`[appearance-registry] 外观档位 "${slot}:${option.id}" 已注册，拒绝覆盖`);
  }
  bucket.set(option.id, option);
  emitChange();
  return () => {
    if (bucket.get(option.id) !== option) return;
    bucket.delete(option.id);
    emitChange();
  };
}

/** 槽位内全部档位（注册顺序，内置先注册所以排前面）。 */
export function listAppearanceOptions(slot: AppearanceSlot): readonly AppearanceOption[] {
  return snapshotFor(slot);
}

export function getAppearanceOption(slot: AppearanceSlot, id: string): AppearanceOption | null {
  return slots.get(slot)?.get(id) ?? null;
}

/** store normalize 的唯一档位存在性判定。 */
export function isRegisteredAppearanceValue(slot: AppearanceSlot, value: unknown): boolean {
  return typeof value === "string" && slots.get(slot)?.has(value) === true;
}

export function subscribeToAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 响应式读取：外观包装/卸后设置中心按钮自动增减。 */
export function useAppearanceOptions(slot: AppearanceSlot): readonly AppearanceOption[] {
  return useSyncExternalStore(
    subscribeToAppearance,
    () => snapshotFor(slot),
    () => snapshotFor(slot),
  );
}
