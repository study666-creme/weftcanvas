import type { AgentConnector } from "@weftcanvas/contracts";
import {
  Blocks,
  Check,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Terminal,
  Unplug,
  X,
} from "lucide-react";
import { memo, useEffect, useState } from "react";

import { useConnectorStore } from "../state/connector-store";
import { useIdentityStore } from "../state/identity-store";
import { useToastStore } from "../state/toast-store";
import { AgentRemoteConnectors } from "./agent-remote-connectors";
import "./agent-connectors-panel.css";

const REFRESH_INTERVAL_MS = 12_000;

const STATE_LABELS: Record<AgentConnector["state"], string> = {
  disabled: "已关闭",
  unavailable: "未连上",
  ready: "已连接",
  error: "异常",
};

const ENDPOINT_PLACEHOLDERS: Record<string, string> = {
  codex: "codex",
  blender: "127.0.0.1:9876",
};

/**
 * Agent 的外部连接面板。普通用户只需要点一个按钮：
 * 运行时自己写 Codex 的 MCP 配置，自己把 Blender 插件装好并打开 Blender，
 * 结果（以及"还需要做什么"）原样显示在这里。
 */
export const AgentConnectorsPanel = memo(function AgentConnectorsPanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const items = useConnectorStore((state) => state.items);
  const status = useConnectorStore((state) => state.status);
  const error = useConnectorStore((state) => state.error);
  const saving = useConnectorStore((state) => state.saving);
  const load = useConnectorStore((state) => state.load);
  const connect = useConnectorStore((state) => state.connect);
  const update = useConnectorStore((state) => state.update);
  const identityStatus = useIdentityStore((state) => state.status);
  const showToast = useToastStore((state) => state.show);

  useEffect(() => {
    if (identityStatus !== "authenticated") return;
    void load();
  }, [identityStatus, load]);

  useEffect(() => {
    if (identityStatus !== "authenticated") return;
    const timer = window.setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [identityStatus, load]);

  const runConnect = async (connector: AgentConnector) => {
    const result = await connect(connector.id, { launch: true });
    if (!result) {
      showToast("一键接入没有完成，请稍后重试", "error");
      return;
    }
    if (result.state === "ready") {
      showToast(result.detail ?? `${result.label} 已连接`, "success");
      return;
    }
    showToast(result.detail ?? `${result.label} 还没连上`, "error");
  };

  const disconnect = async (connector: AgentConnector) => {
    const saved = await update(connector.id, { enabled: false });
    if (!saved) showToast("断开没有保存成功", "error");
  };

  return (
    <section className="wc-connectors" aria-label="Agent 外部连接">
      <header className="wc-connectors-head">
        <span>
          <Unplug aria-hidden="true" />
          外部连接
        </span>
        <div>
          <button
            type="button"
            aria-label="刷新连接状态"
            title="刷新"
            onClick={() => void load(true)}
            disabled={status === "loading"}
          >
            <RefreshCw
              className={status === "loading" ? "is-spinning" : undefined}
              aria-hidden="true"
            />
          </button>
          <button type="button" aria-label="收起外部连接" title="收起" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <p className="wc-connectors-note">
        点「连接」就行：运行时会自动把画布接进本机 Codex，或把 Blender 插件装好并打开 Blender。
        连上以后，Codex 对画布的操作会直接落盘（可撤销回退），Blender 则由 Agent 在本机执行 Python。
      </p>

      <AgentRemoteConnectors />

      {items.length ? (
        <ul className="wc-connectors-list">
          {items.map((connector) => (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              busy={saving === connector.id}
              disabled={saving !== null}
              onConnect={() => void runConnect(connector)}
              onDisconnect={() => void disconnect(connector)}
              onSaveEndpoint={(endpoint) => void update(connector.id, { endpoint })}
            />
          ))}
        </ul>
      ) : (
        <div className="wc-connectors-empty" role="status">
          {status === "loading" ? (
            <LoaderCircle className="is-spinning" aria-hidden="true" />
          ) : (
            <CircleAlert aria-hidden="true" />
          )}
          <span>
            {identityStatus !== "authenticated"
              ? "登录后可管理本机连接"
              : error || "没有读到本机连接"}
          </span>
        </div>
      )}

      {items.length && error ? (
        <div className="wc-connectors-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
});

function ConnectorRow({
  connector,
  busy,
  disabled,
  onConnect,
  onDisconnect,
  onSaveEndpoint,
}: {
  connector: AgentConnector;
  busy: boolean;
  disabled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSaveEndpoint: (endpoint: string) => void;
}) {
  const [endpoint, setEndpoint] = useState(connector.endpoint ?? "");
  useEffect(() => {
    setEndpoint(connector.endpoint ?? "");
  }, [connector.endpoint]);

  const Icon = connector.id === "blender" ? Blocks : Terminal;
  const placeholder = ENDPOINT_PLACEHOLDERS[connector.id] ?? "";
  const connected = connector.state === "ready";
  const commit = () => {
    const next = endpoint.trim();
    if (next === (connector.endpoint ?? "")) return;
    onSaveEndpoint(next);
  };

  return (
    <li className="wc-connector" data-connector={connector.id} data-state={connector.state}>
      <div className="wc-connector-main">
        <span className="wc-connector-icon" aria-hidden="true">
          <Icon />
        </span>
        <div className="wc-connector-copy">
          <strong>{connector.label}</strong>
          <small>{connector.summary}</small>
        </div>
        <span className="wc-connector-state" data-state={connector.state}>
          {busy ? (
            <LoaderCircle className="is-spinning" aria-hidden="true" />
          ) : connected ? (
            <Check aria-hidden="true" />
          ) : (
            <i aria-hidden="true" />
          )}
          {busy ? "接入中" : STATE_LABELS[connector.state]}
        </span>
        <button
          type="button"
          className="wc-connector-action"
          data-primary={connector.enabled ? undefined : "true"}
          aria-label={`${connector.enabled ? "断开" : "连接"}${connector.label}`}
          disabled={disabled}
          onClick={connector.enabled ? onDisconnect : onConnect}
        >
          {busy ? "接入中…" : connector.enabled ? "断开" : "连接"}
        </button>
      </div>

      {connector.enabled && connector.detail ? (
        <p className="wc-connector-detail">{connector.detail}</p>
      ) : null}

      {connected && connector.capabilities.length ? (
        <ul className="wc-connector-capabilities">
          {connector.capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      ) : null}

      <details className="wc-connector-setup">
        <summary>高级</summary>
        <label className="wc-connector-endpoint">
          <span>{connector.id === "blender" ? "桥接地址" : "Codex 命令"}</span>
          <input
            type="text"
            value={endpoint}
            placeholder={placeholder}
            maxLength={240}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setEndpoint(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        {connector.setup ? <p className="wc-connector-setup-text">{connector.setup}</p> : null}
      </details>
    </li>
  );
}
