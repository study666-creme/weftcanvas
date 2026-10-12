import type { Plugin } from "@weftcanvas/plugin-sdk";

import { PLUGIN_DEV } from "./canvas-features";
import { exposePluginHostTestHook, installPlugin } from "./plugin-host";

/**
 * 官方插件装载（docs/PLUGIN-ROADMAP.md §6）：随包 chunk 经动态 import 懒加载
 * （vite 自动分包，不进主 bundle）。本地开发插件：在officialPluginLoaders
 * 里加一条 loader 即可（不提供 URL 远程加载，不做 eval）。
 */
const officialPluginLoaders: Record<string, () => Promise<{ default: Plugin }>> = {
  "split-list": async () => import("@weftcanvas-plugin/split-list"),
};

let started = false;

export async function loadOfficialPlugins(): Promise<void> {
  if (started) return;
  started = true;
  if (import.meta.env.DEV || PLUGIN_DEV) {
    exposePluginHostTestHook();
    if (PLUGIN_DEV)
      console.info(
        "[plugins] PLUGIN_DEV 已开启：插件宿主调试钩子可用（window.__weftcanvasPluginHost）",
      );
  }
  await Promise.all(
    Object.entries(officialPluginLoaders).map(async ([id, loader]) => {
      try {
        await installPlugin(await loader());
      } catch (error) {
        // 装载失败只降级这个插件：画布与其它插件不受影响。
        console.error(`[plugins] 官方插件 ${id} 装载失败`, error);
      }
    }),
  );
}

/** 已随包提供的官方插件 id（设置中心的重装列表）。 */
export function officialPluginIds(): string[] {
  return Object.keys(officialPluginLoaders);
}

/** 重装一个官方插件（用户在设置中心卸载后可从这里恢复）。 */
export async function installOfficialPlugin(id: string): Promise<void> {
  const loader = officialPluginLoaders[id];
  if (!loader) throw new Error(`未知的官方插件: ${id}`);
  await installPlugin(await loader());
}
