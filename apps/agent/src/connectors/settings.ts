import type { AgentConnectorId } from "@kachang/contracts";

/** 本机连接配置。两个连接都在 Agent 运行时所在机器上生效。 */
export type AgentConnectorSettings = {
  codex: {
    enabled: boolean;
    /** Codex 可执行命令；null 表示走 PATH 上的 `codex`。 */
    endpoint: string | null;
  };
  blender: {
    enabled: boolean;
    /** Blender 桥接地址 host:port。 */
    endpoint: string | null;
  };
};

export const DEFAULT_CONNECTOR_SETTINGS: AgentConnectorSettings = {
  codex: { enabled: false, endpoint: null },
  blender: { enabled: false, endpoint: null },
};

export type AgentConnectorPatch = {
  enabled?: boolean;
  endpoint?: string | null;
};

export interface AgentConnectorSettingsStore {
  read(): Promise<AgentConnectorSettings>;
  write(settings: AgentConnectorSettings): Promise<void>;
}

export class MemoryConnectorSettingsStore implements AgentConnectorSettingsStore {
  private settings: AgentConnectorSettings;

  constructor(initial: AgentConnectorSettings = DEFAULT_CONNECTOR_SETTINGS) {
    this.settings = cloneSettings(initial);
  }

  async read() {
    return cloneSettings(this.settings);
  }

  async write(settings: AgentConnectorSettings) {
    this.settings = cloneSettings(settings);
  }
}

export function cloneSettings(settings: AgentConnectorSettings): AgentConnectorSettings {
  return {
    codex: { enabled: settings.codex.enabled, endpoint: settings.codex.endpoint },
    blender: { enabled: settings.blender.enabled, endpoint: settings.blender.endpoint },
  };
}

export function mergeSettings(
  current: AgentConnectorSettings,
  id: AgentConnectorId,
  patch: AgentConnectorPatch,
): AgentConnectorSettings {
  const next = cloneSettings(current);
  if (patch.enabled !== undefined) next[id].enabled = patch.enabled;
  if (patch.endpoint !== undefined) {
    const trimmed = patch.endpoint?.trim() ?? "";
    next[id].endpoint = trimmed ? trimmed : null;
  }
  return next;
}
