import { Puzzle, Plus, RefreshCw } from "lucide-react";
import { useSyncExternalStore, useState } from "react";

import { getLoadedPlugin, listInstalledPluginIds, subscribeToPlugins, uninstallPlugin } from "../lib/plugin-host";
import { installOfficialPlugin, officialPluginIds } from "../lib/official-plugins";

/**
 * 插件管理（设置中心「插件」板块，docs/PLUGIN-ROADMAP.md §6 遗留项）：
 * 已装列表（版本/描述）+ 卸载；官方插件卸载后可重装（同一份随包 chunk）。
 * 卸载即逆序回收：插件节点从创建菜单消失，已存在节点仍渲染。
 */
export function PluginSettingsPanel() {
  const installedIds = useSyncExternalStore(
    subscribeToPlugins,
    listInstalledPluginIds,
    listInstalledPluginIds,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const officialIds = officialPluginIds();
  const uninstalledOfficial = officialIds.filter((id) => !installedIds.includes(id));

  const handleUninstall = (id: string) => {
    setError(null);
    uninstallPlugin(id);
  };

  const handleInstall = async (id: string) => {
    setError(null);
    setBusyId(id);
    try {
      await installOfficialPlugin(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="kc-plugin-settings" data-plugin-settings>
      <p className="kc-plugin-settings-intro">
        插件经宿主注册表扩展画布；卸载会回收它注册的节点类型（已存在节点仍渲染），再装即恢复。
      </p>
      {installedIds.length ? (
        <ul className="kc-plugin-settings-list">
          {installedIds.map((id) => {
            const plugin = getLoadedPlugin(id);
            return (
              <li key={id} className="kc-plugin-settings-row" data-plugin-id={id}>
                <span className="kc-plugin-settings-name"><Puzzle aria-hidden="true" />{id}</span>
                <span className="kc-plugin-settings-meta">
                  {plugin?.version ?? ""}
                  {plugin?.description ? ` · ${plugin.description}` : ""}
                </span>
                <button
                  type="button"
                  className="kc-plugin-settings-action"
                  onClick={() => handleUninstall(id)}
                >
                  卸载
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="kc-plugin-settings-empty">没有已装载的插件。</p>
      )}
      {uninstalledOfficial.length ? (
        <div className="kc-plugin-settings-available">
          <span className="kc-plugin-settings-label">官方插件</span>
          {uninstalledOfficial.map((id) => (
            <button
              key={id}
              type="button"
              className="kc-plugin-settings-action"
              disabled={busyId === id}
              onClick={() => void handleInstall(id)}
            >
              {busyId === id ? <RefreshCw className="is-spinning" aria-hidden="true" /> : <Plus aria-hidden="true" />}
              装载 {id}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <div className="kc-plugin-settings-error" role="alert">{error}</div> : null}
    </div>
  );
}
