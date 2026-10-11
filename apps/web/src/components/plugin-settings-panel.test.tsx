import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PluginSettingsPanel } from "./plugin-settings-panel";
import { installPlugin, uninstallPlugin } from "../lib/plugin-host";
import type { Plugin } from "@kachang/plugin-sdk";

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

  it("offers reinstall for uninstalled official plugins", async () => {
    // 测试环境是全新模块注册表：split-list 未装载 → 面板显示重装入口。
    const uninstalled = renderToStaticMarkup(<PluginSettingsPanel />);
    expect(uninstalled).toContain("装载 split-list");

    await installPlugin({ id: "split-list", version: "0.1.0", setup: () => {} });
    const installed = renderToStaticMarkup(<PluginSettingsPanel />);
    expect(installed).toContain("split-list");
    expect(installed).not.toContain("装载 split-list");
    uninstallPlugin("split-list");
  });
});
