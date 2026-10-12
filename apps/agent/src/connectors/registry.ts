import type { AgentConnector, AgentConnectorId } from "@weftcanvas/contracts";

import { defaultProbes, type ConnectorProbes, type ProbeResult } from "./probe.js";
import {
  cloneSettings,
  mergeSettings,
  type AgentConnectorPatch,
  type AgentConnectorSettings,
  type AgentConnectorSettingsStore,
} from "./settings.js";

export type ConnectorDescriptor = {
  id: AgentConnectorId;
  label: string;
  summary: string;
  capabilities: string[];
  setup: string;
  /** 未显式配置时的默认目标。 */
  defaultEndpoint: string;
  endpointLabel: string;
  endpointPlaceholder: string;
};

export const CONNECTOR_DESCRIPTORS: readonly ConnectorDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    summary: "把当前画布暴露给本机 Codex：它通过 MCP 直接建节点、改正文、连线，浏览器负责落盘。",
    capabilities: [
      "新建文本 / 图片 / 视频 / 配置节点",
      "修改节点正文与位置",
      "连接、选择、组合节点",
      "调整画布视口",
    ],
    setup:
      "在 Codex 的 MCP 配置里加入 apps/agent/mcp/canvas-mcp.mjs（需要 WEFTCANVAS_AGENT_URL 与 WEFTCANVAS_AGENT_TOKEN）。",
    defaultEndpoint: "codex",
    endpointLabel: "Codex 命令",
    endpointPlaceholder: "codex",
  },
  {
    id: "blender",
    label: "Blender",
    summary: "让 Agent 把 Python 交给本机 Blender 执行，用于建模、材质与渲染准备。",
    capabilities: [
      "在 Blender 中执行 Python",
      "读取当前场景对象与材质摘要",
      "按指令生成或调整 3D 资产",
    ],
    setup:
      "在 Blender 中运行 apps/agent/blender/weftcanvas_bridge.py 启动桥接（默认 127.0.0.1:9876）。",
    defaultEndpoint: "127.0.0.1:9876",
    endpointLabel: "桥接地址",
    endpointPlaceholder: "127.0.0.1:9876",
  },
] as const;

export type AgentConnectorRegistryOptions = {
  probes?: ConnectorProbes;
  /** 一键接入：写 Codex 配置 / 安装 Blender 插件。缺省时 connect() 只做开关。 */
  provisioner?: ConnectorProvisioner;
  cacheMs?: number;
  now?: () => number;
  /** 由服务端环境变量提供的默认命令/地址。 */
  defaults?: Partial<Record<AgentConnectorId, string>>;
};

export type ConnectorProvisionOutcome = {
  ok: boolean;
  detail: string;
  action: string | null;
};

export type ConnectorProvisioner = {
  codex(command: string, signal?: AbortSignal): Promise<ConnectorProvisionOutcome>;
  blender(
    address: string,
    launch: boolean,
    signal?: AbortSignal,
  ): Promise<ConnectorProvisionOutcome>;
};

type CacheEntry = { key: string; probe: ProbeResult; expiresAt: number };

export class AgentConnectorRegistry {
  private readonly probes: ConnectorProbes;
  private readonly provisioner: ConnectorProvisioner | undefined;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly defaults: Record<AgentConnectorId, string>;
  private readonly cache = new Map<AgentConnectorId, CacheEntry>();
  private inflight = new Map<AgentConnectorId, Promise<ProbeResult>>();

  constructor(
    private readonly store: AgentConnectorSettingsStore,
    options: AgentConnectorRegistryOptions = {},
  ) {
    this.probes = options.probes ?? defaultProbes();
    this.provisioner = options.provisioner;
    this.cacheMs = options.cacheMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.defaults = {
      codex: options.defaults?.codex?.trim() || "codex",
      blender: options.defaults?.blender?.trim() || "127.0.0.1:9876",
    };
  }

  async list(signal?: AbortSignal): Promise<AgentConnector[]> {
    const settings = await this.store.read();
    return Promise.all(
      CONNECTOR_DESCRIPTORS.map((descriptor) => this.describe(descriptor, settings, signal)),
    );
  }

  async get(id: AgentConnectorId, signal?: AbortSignal): Promise<AgentConnector> {
    const descriptor = CONNECTOR_DESCRIPTORS.find((item) => item.id === id)!;
    return this.describe(descriptor, await this.store.read(), signal);
  }

  async update(id: AgentConnectorId, patch: AgentConnectorPatch): Promise<AgentConnector> {
    const current = await this.store.read();
    const next = mergeSettings(current, id, patch);
    await this.store.write(next);
    this.invalidate(id);
    return this.get(id);
  }

  /**
   * 一键接入。已经连上时不做任何系统改动；没连上才去写 Codex 配置 / 装 Blender 插件，
   * 并把"用户还需做什么"写进 detail，让面板能直接告诉普通用户下一步。
   */
  async connect(
    id: AgentConnectorId,
    options: { launch?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<AgentConnector> {
    const launch = options.launch ?? true;
    const descriptor = CONNECTOR_DESCRIPTORS.find((item) => item.id === id)!;
    const settings = await this.store.read();
    const target = settings[id].endpoint ?? this.defaults[id];

    // 先探测一次：已经在运行就不动本机配置。
    const baseline = await this.probeFor(descriptor, settings, signal);
    if (baseline.reachable || !this.provisioner) {
      return this.enableAndDescribe(descriptor, settings, signal, null);
    }

    // 先把开关落上（接入失败也保持"已打开 + 失败原因"），再执行本机配置。
    await this.enableAndDescribe(descriptor, settings, signal, null);

    let outcome: ConnectorProvisionOutcome;
    try {
      outcome =
        id === "codex"
          ? await this.provisioner.codex(target, signal)
          : await this.provisioner.blender(target, launch, signal);
    } catch {
      return this.enableAndDescribe(descriptor, settings, signal, {
        ok: false,
        detail: "一键接入没有完成",
        action: null,
      });
    }

    return this.enableAndDescribe(descriptor, settings, signal, outcome);
  }

  private async enableAndDescribe(
    descriptor: ConnectorDescriptor,
    settings: AgentConnectorSettings,
    signal: AbortSignal | undefined,
    outcome: ConnectorProvisionOutcome | null,
  ): Promise<AgentConnector> {
    const next = mergeSettings(settings, descriptor.id, { enabled: true });
    await this.store.write(next);
    this.invalidate(descriptor.id);
    const probe = await this.probeFor(descriptor, next, signal);
    const described = await this.describe(descriptor, next, signal);
    if (!outcome) return described;
    const parts = [
      outcome.detail,
      outcome.action ? `（${outcome.action}）` : "",
      !probe.reachable && probe.detail ? ` ${probe.detail}` : "",
    ];
    return { ...described, detail: parts.join("").trim().slice(0, 500) };
  }

  /** 目标地址：显式配置优先，其次环境默认。 */
  async target(id: AgentConnectorId): Promise<string> {
    const settings = await this.store.read();
    return settings[id].endpoint ?? this.defaults[id];
  }

  /**
   * 启用且探测可达的连接。Agent 只用这些连接构建本轮工具，
   * 所以断开的连接不会变成模型眼里的"可用能力"。
   */
  async active(signal?: AbortSignal): Promise<Array<{ id: AgentConnectorId; target: string }>> {
    const settings = await this.store.read();
    const active: Array<{ id: AgentConnectorId; target: string }> = [];
    for (const descriptor of CONNECTOR_DESCRIPTORS) {
      if (!settings[descriptor.id].enabled) continue;
      const probe = await this.probeFor(descriptor, settings, signal);
      if (!probe.reachable) continue;
      active.push({
        id: descriptor.id,
        target: settings[descriptor.id].endpoint ?? this.defaults[descriptor.id],
      });
    }
    return active;
  }

  private async describe(
    descriptor: ConnectorDescriptor,
    settings: AgentConnectorSettings,
    signal?: AbortSignal,
  ): Promise<AgentConnector> {
    const endpoint = settings[descriptor.id].endpoint;
    const base = {
      id: descriptor.id,
      label: descriptor.label,
      summary: descriptor.summary,
      enabled: settings[descriptor.id].enabled,
      endpoint,
      capabilities: [...descriptor.capabilities],
      setup: descriptor.setup,
    };
    if (!settings[descriptor.id].enabled) {
      return {
        ...base,
        state: "disabled",
        detail: null,
        checkedAt: new Date(this.now()).toISOString(),
      };
    }
    const probe = await this.probeFor(descriptor, settings, signal);
    return {
      ...base,
      state: probe.reachable ? "ready" : "unavailable",
      detail: probe.detail,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  private async probeFor(
    descriptor: ConnectorDescriptor,
    settings: AgentConnectorSettings,
    signal?: AbortSignal,
  ): Promise<ProbeResult> {
    const target = settings[descriptor.id].endpoint ?? this.defaults[descriptor.id];
    const key = `${descriptor.id}:${target}`;
    const cached = this.cache.get(descriptor.id);
    if (cached && cached.key === key && cached.expiresAt > this.now()) return cached.probe;

    const existing = this.inflight.get(descriptor.id);
    if (existing) return existing;

    const request = (
      descriptor.id === "codex"
        ? this.probes.codex(target, signal)
        : this.probes.blender(target, signal)
    )
      .then((probe) => {
        this.cache.set(descriptor.id, { key, probe, expiresAt: this.now() + this.cacheMs });
        return probe;
      })
      .catch<ProbeResult>(() => ({ reachable: false, detail: "探测失败" }))
      .finally(() => {
        if (this.inflight.get(descriptor.id) === request) this.inflight.delete(descriptor.id);
      });
    this.inflight.set(descriptor.id, request);
    return request;
  }

  private invalidate(id: AgentConnectorId) {
    this.cache.delete(id);
  }
}

export function defaultConnectorSettings(env: {
  blenderAddress?: string | undefined;
  codexCommand?: string | undefined;
  blenderEnabled?: boolean;
  codexEnabled?: boolean;
}): AgentConnectorSettings {
  return cloneSettings({
    codex: { enabled: env.codexEnabled ?? false, endpoint: env.codexCommand?.trim() || null },
    blender: { enabled: env.blenderEnabled ?? false, endpoint: env.blenderAddress?.trim() || null },
  });
}
