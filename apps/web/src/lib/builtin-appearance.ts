import {
  registerAppearanceOption,
  type AppearanceOption,
  type AppearanceSlot,
} from "./appearance-registry";

/**
 * 内置外观档位（docs/PLUGIN-ROADMAP.md §4 P1）：原硬编码在
 * appearance-toolbar 的选项数组全部收拢到这里，经注册表登记。
 * ui-preferences-store 的 normalize 依赖本模块先注册完成（import 顺序保证）。
 */

function registerAll(slot: AppearanceSlot, options: AppearanceOption[]) {
  for (const option of options) {
    registerAppearanceOption(slot, { ...option, builtin: true });
  }
}

registerAll("canvasVisualStyle", [
  { id: "airy", label: "疏朗" },
  { id: "studio", label: "无界" },
  { id: "classic", label: "经典" },
  { id: "onyx", label: "纯黑" },
  // 巨幕只在节点档出现（界面档没有），与旧 NodeVisualStyle 的并集一致。
  { id: "imax", label: "巨幕" },
]);

registerAll("chromeVisualStyle", [
  { id: "airy", label: "疏朗" },
  { id: "studio", label: "无界" },
  { id: "classic", label: "经典" },
  { id: "onyx", label: "纯黑" },
]);

registerAll("canvasBackgroundStyle", [
  { id: "layered-grid", label: "网格" },
  { id: "zoom-dots", label: "点阵" },
  { id: "starfield", label: "星空" },
  { id: "water", label: "水面" },
  { id: "onyx", label: "纯黑" },
]);

registerAll("generationEffectStyle", [
  { id: "beam", label: "流光" },
  { id: "nebula", label: "星云" },
  { id: "water", label: "水镜" },
  { id: "quiet", label: "光环" },
]);

registerAll("edgePathStyle", [
  { id: "taut", label: "张力", geometry: "taut", pathCurvature: 0.42 },
  { id: "gravity", label: "柔弧", geometry: "gravity", pathCurvature: 0.25 },
  // 翡翠是纯 CSS 换肤档：几何复用张力，颜色交给 emerald-edge.css。
  { id: "emerald", label: "翡翠", geometry: "taut", pathCurvature: 0.32 },
]);

registerAll("edgeFlowStyle", [
  { id: "stream", label: "流光" },
  { id: "stardust", label: "星点" },
]);

registerAll("cursorStyle", [
  { id: "classic", label: "质感" },
  { id: "precision", label: "精确" },
]);

registerAll("nodePortStyle", [
  { id: "classic", label: "质感" },
  { id: "compact", label: "简洁" },
]);
