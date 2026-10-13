import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PluginSettingsPanel } from "./plugin-settings-panel";
import { installPlugin, uninstallPlugin } from "../lib/plugin-host";
import type { Plugin } from "@weftcanvas/plugin-sdk";

describe("plugin settings panel", () => {
  it("lists an installed plugin with its version and drops it after uninstall", async () => {
    const plugin: Plugin = {
      id: "spec-settings",
      version: "1.2.3",
      description: "演示插件",
      setup: () => {},
    };
    await installPlugin(plugin);
    const withPlugin = renderToStaticMarkup(<PluginSettingsPanel />);
    expect(withPlugin).toContain("spec-settings");
    expect(withPlugin).toContain("1.2.3");
    uninstallPlugin("spec-settings");

    const withoutPlugin = renderToStaticMarkup(<PluginSettingsPanel />);
    expect(withoutPlugin).not.toContain("spec-settings");
  });

  it("offers install for uninstalled official plugins and disable for installed ones", async () => {
    // 测试环境是全新模块注册表：官方 split-list 未装载 → 面板按「可装载」呈现。
    const uninstalled = renderToStaticMarkup(<PluginSettingsPanel />);
    expect(uninstalled).toContain('data-plugin-id="split-list"');
    expect(uninstalled).toContain('data-status="uninstalled"');
    expect(uninstalled).toContain("装载");
    // 官方插件用友好名展示，而非裸 id。
    expect(uninstalled).toContain("批量拆单");

    await installPlugin({ id: "split-list", version: "0.1.0", setup: () => {} });
    const installed = renderToStaticMarkup(<PluginSettingsPanel />);
    expect(installed).toContain('data-status="installed"');
    expect(installed).toContain("停用");
    expect(installed).toContain("卸载");
    // 已装载的行没有「装载/启用」主操作按钮（说明卡里的“装载”二字不算）。
    expect(installed).not.toContain("is-primary");
    uninstallPlugin("split-list");
  });
});
