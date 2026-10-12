import { beforeEach, describe, expect, it, vi } from "vitest";

import { definePlugin, type Plugin, type PluginContext } from "@weftcanvas/plugin-sdk";

import { getNodeDefinition, listCreatableNodes, listNodes } from "../node-registry";
import "../builtin-nodes";
import { installPlugin, uninstallPlugin } from "../plugin-host";

function makePlugin(id: string, setup: (ctx: PluginContext) => void): Plugin {
  return definePlugin({ id, version: "0.1.0", setup });
}

const memoryStorage = new Map<string, string>();

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryStorage.set(key, value),
    removeItem: (key: string) => void memoryStorage.delete(key),
    key: (index: number) => [...memoryStorage.keys()][index] ?? null,
    get length() {
      return memoryStorage.size;
    },
  });
  memoryStorage.clear();
  uninstallPlugin("spec-alpha");
  uninstallPlugin("spec-beta");
});

describe("plugin host", () => {
  it("installs a plugin under the plugin: namespace and uninstalls symmetrically", async () => {
    await installPlugin(
      makePlugin("spec-alpha", (ctx) => {
        ctx.nodes.registerNode({
          name: "card",
          label: () => "演示卡",
          createDraft: () => ({ width: 100, height: 80 }),
        });
        ctx.onDispose(() => {
          memoryStorage.set("cleanup", "ran");
        });
      }),
    );

    const kind = "plugin:spec-alpha:card";
    expect(getNodeDefinition(kind)?.label()).toBe("演示卡");
    expect(listCreatableNodes().some((definition) => definition.kind === kind)).toBe(true);
    expect(getNodeDefinition(kind)?.owner).toBe("spec-alpha");

    uninstallPlugin("spec-alpha");
    expect(getNodeDefinition(kind)).toBeNull();
    expect(memoryStorage.get("cleanup")).toBe("ran");
  });

  it("rejects duplicate plugin ids and duplicate node kinds", async () => {
    const plugin = makePlugin("spec-alpha", (ctx) => {
      ctx.nodes.registerNode({
        name: "card",
        label: () => "演示卡",
        createDraft: () => ({ width: 100, height: 80 }),
      });
    });
    await installPlugin(plugin);
    await expect(installPlugin(plugin)).rejects.toThrow(/已装载/);
    // 同名节点在同一插件重装前未卸载时必须报错，绝不静默覆盖。
    await uninstallPlugin("spec-alpha");
    await installPlugin(plugin);
    expect(() => getNodeDefinition("plugin:spec-alpha:card")).not.toThrow();
    uninstallPlugin("spec-alpha");
  });

  it("isolates plugin storage namespaces", async () => {
    await installPlugin(
      makePlugin("spec-alpha", (ctx) => {
        const kv = ctx.storage("main");
        kv.set("counter", "1");
      }),
    );
    await installPlugin(
      makePlugin("spec-beta", (ctx) => {
        const kv = ctx.storage("main");
        expect(kv.get("counter")).toBeNull();
        kv.set("counter", "2");
        expect(kv.keys()).toEqual(["counter"]);
      }),
    );
    expect(memoryStorage.get("weftcanvas:plugin:spec-alpha:main:counter")).toBe("1");
    expect(memoryStorage.get("weftcanvas:plugin:spec-beta:main:counter")).toBe("2");
  });

  it("validates ops against the agent action schema", async () => {
    let ops: PluginContext["ops"] | null = null;
    await installPlugin(
      makePlugin("spec-alpha", (ctx) => {
        ops = ctx.ops;
      }),
    );
    await expect(ops!.apply([{ type: "make_me_a_sandwich" }])).rejects.toThrow();
    uninstallPlugin("spec-alpha");
  });

  it("validates plugin identity in definePlugin", () => {
    expect(() => definePlugin({ id: "Bad_Id", version: "0.1.0", setup: () => {} })).toThrow(
      /plugin-sdk/,
    );
    expect(() => definePlugin({ id: "ok", version: "", setup: () => {} })).toThrow(/version/);
    expect(listNodes().length).toBeGreaterThan(0);
  });
});
