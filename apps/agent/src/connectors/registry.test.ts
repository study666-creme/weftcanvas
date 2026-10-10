import { describe, expect, it, vi } from "vitest";

import { AgentConnectorRegistry, type ConnectorProvisioner } from "./registry.js";
import { MemoryConnectorSettingsStore } from "./settings.js";
import type { ConnectorProbes } from "./probe.js";

function probes(overrides: Partial<ConnectorProbes> = {}): ConnectorProbes {
  return {
    codex: vi.fn(async () => ({ reachable: true, detail: "codex-cli 0.9.0" })),
    blender: vi.fn(async () => ({ reachable: false, detail: "端口上没有 Blender 桥接在监听" })),
    ...overrides,
  };
}

function provisioner(overrides: Partial<ConnectorProvisioner> = {}): ConnectorProvisioner {
  return {
    codex: vi.fn(async () => ({ ok: true, detail: "已写入 Codex 配置", action: "重启 Codex 后生效" })),
    blender: vi.fn(async () => ({ ok: true, detail: "已装好插件并启用，已启动 Blender", action: null })),
    ...overrides,
  };
}

describe("AgentConnectorRegistry", () => {
  it("reports disabled connectors without probing the machine", async () => {
    const fake = probes();
    const registry = new AgentConnectorRegistry(new MemoryConnectorSettingsStore(), { probes: fake });
    const list = await registry.list();
    expect(list.map((item) => item.state)).toEqual(["disabled", "disabled"]);
    expect(fake.codex).not.toHaveBeenCalled();
    expect(fake.blender).not.toHaveBeenCalled();
    await expect(registry.active()).resolves.toEqual([]);
  });

  it("maps probe results to ready and unavailable states", async () => {
    const store = new MemoryConnectorSettingsStore({
      codex: { enabled: true, endpoint: null },
      blender: { enabled: true, endpoint: null },
    });
    const registry = new AgentConnectorRegistry(store, { probes: probes() });
    const [codex, blender] = await registry.list();
    expect(codex?.state).toBe("ready");
    expect(codex?.detail).toBe("codex-cli 0.9.0");
    expect(blender?.state).toBe("unavailable");
    expect(blender?.detail).toBe("端口上没有 Blender 桥接在监听");
  });

  it("caches probe results and invalidates them when settings change", async () => {
    const fake = probes();
    let now = 0;
    const registry = new AgentConnectorRegistry(new MemoryConnectorSettingsStore(), {
      probes: fake,
      cacheMs: 1_000,
      now: () => now,
    });
    await registry.update("codex", { enabled: true });
    await registry.list();
    await registry.list();
    expect(fake.codex).toHaveBeenCalledTimes(1);

    now = 2_000;
    await registry.list();
    expect(fake.codex).toHaveBeenCalledTimes(2);

    await registry.update("codex", { enabled: true, endpoint: "codex-beta" });
    await registry.list();
    expect(fake.codex).toHaveBeenCalledTimes(3);
    expect(fake.codex).toHaveBeenLastCalledWith("codex-beta", undefined);
  });

  it("only exposes enabled and reachable connectors as active tools", async () => {
    const store = new MemoryConnectorSettingsStore({
      codex: { enabled: true, endpoint: null },
      blender: { enabled: true, endpoint: null },
    });
    const registry = new AgentConnectorRegistry(store, { probes: probes() });
    await expect(registry.active()).resolves.toEqual([{ id: "codex", target: "codex" }]);
  });

  it("falls back to environment defaults for the target address", async () => {
    const store = new MemoryConnectorSettingsStore({
      codex: { enabled: true, endpoint: null },
      blender: { enabled: false, endpoint: null },
    });
    const registry = new AgentConnectorRegistry(store, {
      probes: probes(),
      defaults: { codex: "codex-dev", blender: "10.0.0.2:9999" },
    });
    await expect(registry.target("blender")).resolves.toBe("10.0.0.2:9999");
    await expect(registry.active()).resolves.toEqual([{ id: "codex", target: "codex-dev" }]);
  });
});

describe("AgentConnectorRegistry.connect", () => {
  it("does not touch the machine when the connection already works", async () => {
    const provision = provisioner();
    const registry = new AgentConnectorRegistry(new MemoryConnectorSettingsStore(), {
      probes: probes({ blender: vi.fn(async () => ({ reachable: true, detail: null })) }),
      provisioner: provision,
    });
    const connector = await registry.connect("blender");
    expect(connector.enabled).toBe(true);
    expect(connector.state).toBe("ready");
    expect(provision.blender).not.toHaveBeenCalled();
  });

  it("provisions on first connect and reports what the user still has to do", async () => {
    const provision = provisioner();
    const store = new MemoryConnectorSettingsStore();
    const registry = new AgentConnectorRegistry(store, {
      probes: probes({ blender: vi.fn(async () => ({ reachable: false, detail: "端口上没有 Blender 桥接在监听" })) }),
      provisioner: provision,
      defaults: { blender: "127.0.0.1:9876" },
    });
    const connector = await registry.connect("blender", { launch: false });
    expect(provision.blender).toHaveBeenCalledWith("127.0.0.1:9876", false, undefined);
    expect(connector.enabled).toBe(true);
    expect(connector.state).toBe("unavailable");
    // 接入说明与探测原因都要给到用户，不能只报"未连上"。
    expect(connector.detail).toContain("已装好插件并启用，已启动 Blender");
    expect(connector.detail).toContain("端口上没有 Blender 桥接在监听");
    await expect(store.read()).resolves.toMatchObject({ blender: { enabled: true } });
  });

  it("keeps the switch on and explains the failure when provisioning throws", async () => {
    const registry = new AgentConnectorRegistry(new MemoryConnectorSettingsStore(), {
      probes: probes({ codex: vi.fn(async () => ({ reachable: false, detail: "本机找不到 codex" })) }),
      provisioner: provisioner({ codex: vi.fn(async () => { throw new Error("boom"); }) }),
    });
    const connector = await registry.connect("codex");
    expect(connector.enabled).toBe(true);
    expect(connector.state).toBe("unavailable");
    expect(connector.detail).toContain("一键接入没有完成");
  });

  it("still connects when no provisioner is configured", async () => {
    const registry = new AgentConnectorRegistry(new MemoryConnectorSettingsStore(), { probes: probes() });
    const connector = await registry.connect("codex");
    expect(connector).toMatchObject({ enabled: true, state: "ready" });
  });
});
