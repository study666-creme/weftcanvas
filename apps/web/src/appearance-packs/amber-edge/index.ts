import "./amber-edge.css";

import { registerAppearanceOption } from "../../lib/appearance-registry";

/**
 * 琥珀线形包（P1 演示，docs/PLUGIN-ROADMAP.md §4 验收①）：
 * 纯注册 + 一个 CSS 文件即成为一个可切换的线形档。
 * import 本模块即装载（与内置档位同一注册表）。
 */
export const unloadAmberEdgePack = registerAppearanceOption("edgePathStyle", {
  id: "amber-edge",
  label: "琥珀",
  geometry: "taut",
  pathCurvature: 0.42,
});
