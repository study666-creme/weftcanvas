import type { CanvasNodeKind } from "@kachang/contracts";

import { listCreatableNodes } from "./node-registry";
import "./builtin-nodes";

/**
 * 节点目录的兼容出口。真正的清单已内化到节点注册表（docs/PLUGIN-ROADMAP.md
 * §3）：内置定义在 ./builtin-nodes，装/卸插件后创建菜单经
 * useCreatableNodeDefinitions() 自动增减；此静态快照仅供非响应式场景
 * （估算/测试/脚本）使用。
 *
 * 剪辑开关 CLIP_EDITOR_AVAILABLE 由 edit 定义自带（builtin-nodes.ts），
 * 这里转出口保持旧引用可用。
 */
export { CLIP_EDITOR_AVAILABLE } from "./builtin-nodes";

/**
 * 插件本地开发装载路径（docs/PLUGIN-ROADMAP.md §6 P3）：构建时以
 * VITE_PLUGIN_DEV=1 打开。打开后暴露 window.__kachangPluginHost 调试钩子
 * （装/卸演练用）；正式装载仍只走随包 chunk，不做 URL 远程加载。
 */
export const PLUGIN_DEV = import.meta.env.VITE_PLUGIN_DEV === "1";

/** 静态快照：本模块求值时"可创建"的节点 kind。 */
export const creatableNodeKinds: CanvasNodeKind[] = listCreatableNodes().map(
  (definition) => definition.kind,
);
