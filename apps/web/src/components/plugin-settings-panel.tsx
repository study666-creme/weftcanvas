import { Puzzle, RefreshCw } from "lucide-react";
import { useSyncExternalStore, useState } from "react";

import {
  getLoadedPlugin,
  getPluginPreference,
  listInstalledPluginIds,
  setPluginEnabled,
  subscribeToPlugins,
  uninstallPlugin,
} from "../lib/plugin-host";
import {
  enableOfficialPlugin,
  installOfficialPlugin,
  officialPluginIds,
  officialPluginMetaFor,
} from "../lib/official-plugins";

/**
 * 插件管理（设置中心「插件」板块，docs/PLUGIN-ROADMAP.md §6 遗留项）：
 * 逐条列出官方插件，按状态给出「停用 / 启用 / 卸载 / 装载」；卸载即逆序回收节点
 * 类型（已存在节点仍渲染），停用保留「已装」身份可一键恢复。装载状态跨刷新持久。
 *
 * 一期没有远程代码加载：官方插件随应用打包，第三方安装是后续规划（见说明卡）。
 */
export function PluginSettingsPanel() {
  const installedIds = useSyncExternalStore(
    subscribeToPlugins,
    listInstalledPluginIds,
    listInstalledPluginIds,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 停用/卸载会改持久偏好，但偏好不在 useSyncExternalStore 的快照里，用一个
  // 本地 tick 强制重渲染，让 getPluginPreference 的最新值反映到行状态上。
  const [, setRenderTick] = useState(0);
  const officialIds = officialPluginIds();
  // 非官方的已装载插件（当前没有，为未来本地开发插件保留展示位）。
  const extraInstalled = installedIds.filter((id) => !officialIds.includes(id));

  const run = async (id: string, action: () => void | Promise<void>) => {
    setError(null);
    setBusyId(id);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
    setRenderTick((value) => value + 1);
  };

  const renderRow = (
    id: string,
    meta: { label: string; version: string; description: string } | undefined,
    status: "installed" | "disabled" | "uninstalled",
  ) => {
    const loaded = getLoadedPlugin(id);
    const label = meta?.label ?? id;
    const version = loaded?.version ?? meta?.version ?? "";
    const description = loaded?.description ?? meta?.description ?? "";
    return (
      <li key={id} className="wc-plugin-settings-row" data-plugin-id={id} data-status={status}>
        <span className="wc-plugin-settings-name">
          <Puzzle aria-hidden="true" />
          {label}
        </span>
        <span className="wc-plugin-settings-meta">
          {version ? `${version} · ` : ""}
          {description}
        </span>
        <span className="wc-plugin-settings-actions">
          {status === "installed" ? (
            <>
              <button
                type="button"
                className="wc-plugin-settings-action"
                disabled={busyId === id}
                onClick={() => run(id, () => setPluginEnabled(id, false))}
              >
                停用
              </button>
              <button
                type="button"
                className="wc-plugin-settings-action"
                disabled={busyId === id}
                onClick={() => run(id, () => uninstallPlugin(id))}
              >
                卸载
              </button>
            </>
          ) : null}
          {status === "disabled" ? (
            <button
              type="button"
              className="wc-plugin-settings-action is-primary"
              disabled={busyId === id}
              onClick={() => run(id, () => enableOfficialPlugin(id))}
            >
              {busyId === id ? <RefreshCw className="is-spinning" aria-hidden="true" /> : null}
              启用
            </button>
          ) : null}
          {status === "uninstalled" ? (
            <button
              type="button"
              className="wc-plugin-settings-action is-primary"
              disabled={busyId === id}
              onClick={() => run(id, () => installOfficialPlugin(id))}
            >
              {busyId === id ? <RefreshCw className="is-spinning" aria-hidden="true" /> : null}
              装载
            </button>
          ) : null}
        </span>
      </li>
    );
  };

  return (
    <div className="wc-plugin-settings" data-plugin-settings>
      <p className="wc-plugin-settings-intro">
        插件通过宿主注册表扩展画布（新增节点类型等）。官方插件随应用一起打包，在下方即可
        装载、停用或卸载；停用会回收它注册的节点类型（画布上已存在的节点仍照常渲染），
        重新启用即恢复。第三方插件的在线获取与安装正在规划中——目前可安装的官方插件如下。
      </p>
      <ul className="wc-plugin-settings-list">
        {officialIds.map((id) =>
          renderRow(
            id,
            officialPluginMetaFor(id),
            installedIds.includes(id)
              ? "installed"
              : getPluginPreference(id) === "disabled"
                ? "disabled"
                : "uninstalled",
          ),
        )}
        {extraInstalled.map((id) => renderRow(id, undefined, "installed"))}
      </ul>
      {!officialIds.length && !extraInstalled.length ? (
        <p className="wc-plugin-settings-empty">
          当前没有可安装的插件。想自己写一个？插件 SDK 与示例见仓库的 packages/plugin-sdk 与
          plugins/ 目录。
        </p>
      ) : null}
      {error ? (
        <div className="wc-plugin-settings-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
