import type { AgentConnectorId, ConnectorClientStatus } from "@kachang/contracts";
import { Check, CircleAlert, Copy, LoaderCircle } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import {
  CanvasApiError,
  createConnectorPairing,
  fetchConnectorClients,
  revokeConnectorPairing,
  runConnectorTask,
} from "../lib/api-client";
import { useToastStore } from "../state/toast-store";

const STATUS_POLL_MS = 10_000;
const SERVER_ORIGIN = typeof window === "undefined" ? "" : window.location.origin;

type ConnectorSpec = {
  id: AgentConnectorId;
  label: string;
  /** 这个客户端的连接方式说明。 */
  steps: string[];
  /** Blender 会持续轮询所以有在线状态；Codex 按需调用 MCP，没有心跳。 */
  showsPresence: boolean;
  /** 支持"在用户机器上跑一条测试任务"的客户端。 */
  testable: boolean;
};

const SPECS: readonly ConnectorSpec[] = [
  {
    id: "blender",
    label: "Blender",
    showsPresence: true,
    testable: true,
    steps: [
      "Blender → Preferences → Add-ons → Install…，选 kachang_bridge.py（仓库 apps/agent/blender/）并启用。",
      "在该插件偏好里粘贴配对令牌；模式保持「连接画布」。",
      "回到这里点「测试连接」，应返回 Blender 版本号。",
    ],
  },
  {
    id: "codex",
    label: "Codex",
    showsPresence: false,
    testable: false,
    steps: [
      `把 MCP 服务加进 Codex 配置：url = ${SERVER_ORIGIN}/api/external/v1/mcp`,
      "鉴权头用 Authorization: Bearer <配对令牌>。",
      "之后 Codex 就能用 canvas_read / canvas_add_node 等工具操作你当前的画布。",
    ],
  },
];

/**
 * 用户侧反向连接：用户的 Blender / Codex 跑在他自己的机器上，主动连到本服务端。
 * 服务端不在服务器上找 Blender、不写用户的 Codex 配置，配对令牌也只能影响该用户自己的画布。
 */
export const AgentRemoteConnectors = memo(function AgentRemoteConnectors() {
  const showToast = useToastStore((state) => state.show);
  const [clients, setClients] = useState<ConnectorClientStatus[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  /** 明文令牌只在新生成时拿得到。 */
  const [tokens, setTokens] = useState<Partial<Record<AgentConnectorId, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setClients(await fetchConnectorClients());
      setStatusError(null);
    } catch (cause) {
      setStatusError(cause instanceof CanvasApiError ? cause.message : "读不到连接状态");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const pair = async (connectorId: AgentConnectorId) => {
    setBusy(`pair:${connectorId}`);
    setTestResult(null);
    try {
      const pairing = await createConnectorPairing(connectorId);
      setTokens((current) => ({ ...current, [connectorId]: pairing.token }));
      await load();
      showToast("配对令牌已生成，请复制到客户端（只显示这一次）", "success");
    } catch (cause) {
      showToast(cause instanceof CanvasApiError ? cause.message : "生成配对令牌失败", "error");
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (connectorId: AgentConnectorId) => {
    setBusy(`revoke:${connectorId}`);
    try {
      await revokeConnectorPairing(connectorId);
      setTokens((current) => ({ ...current, [connectorId]: undefined }));
      setTestResult(null);
      await load();
      showToast("已撤销配对，客户端需要重新配对", "info");
    } catch (cause) {
      showToast(cause instanceof CanvasApiError ? cause.message : "撤销失败", "error");
    } finally {
      setBusy(null);
    }
  };

  const test = async (connectorId: AgentConnectorId) => {
    setBusy(`test:${connectorId}`);
    setTestResult(null);
    try {
      const result = await runConnectorTask({ connectorId, method: "ping", params: {}, waitMs: 20_000 });
      if (result.status === "completed") {
        const text = result.stdout.trim() || "已连通";
        setTestResult({ ok: true, text });
        showToast(`已连通：${text}`, "success");
      } else {
        setTestResult({ ok: false, text: result.error ?? result.status });
        showToast(result.error ?? "连接没有成功", "error");
      }
    } catch (cause) {
      const message = cause instanceof CanvasApiError ? cause.message : "测试连接失败";
      setTestResult({ ok: false, text: message });
      showToast(message, "error");
    } finally {
      setBusy(null);
      void load();
    }
  };

  const copy = (token: string) => {
    void navigator.clipboard?.writeText(token)
      .then(() => showToast("令牌已复制", "success"))
      .catch(() => showToast("复制失败，请手动选中复制", "error"));
  };

  return (
    <section className="kc-remote-connectors" aria-label="远程连接（运行在你自己的机器上）">
      <header className="kc-connectors-head">
        <span>运行在你自己的机器上</span>
      </header>
      <p className="kc-connectors-note">
        画布是托管站点，服务器上没有你的 Blender，也不该往你的机器上写配置。这里生成
        只属于你的配对令牌：客户端带着它主动连过来，画布里的需求就落到你自己的机器上执行。
        令牌等同于该客户端在本机的执行权限，别分享；怀疑泄露就重新配对。
      </p>

      {SPECS.map((spec) => {
        const client = clients?.find((item) => item.connectorId === spec.id) ?? null;
        const connected = client?.connected === true;
        const token = tokens[spec.id] ?? null;
        const stateLabel = !client?.paired
          ? "未配对"
          : spec.showsPresence
            ? (connected ? "已在线" : "已配对 · 离线")
            : "已配对";
        return (
          <div
            key={spec.id}
            className="kc-connector"
            data-connector={spec.id}
            data-state={client?.paired && (!spec.showsPresence || connected) ? "ready" : "unavailable"}
          >
            <div className="kc-connector-main">
              <div className="kc-connector-copy">
                <strong>{spec.label}</strong>
                <small>{SERVER_ORIGIN}</small>
              </div>
              <span
                className="kc-connector-state"
                data-state={client?.paired && (!spec.showsPresence || connected) ? "ready" : "unavailable"}
              >
                {client?.paired && (!spec.showsPresence || connected) ? <Check aria-hidden="true" /> : <i aria-hidden="true" />}
                {stateLabel}
              </span>
              <button
                type="button"
                className="kc-connector-action"
                data-primary={client?.paired ? undefined : "true"}
                disabled={busy !== null}
                onClick={() => void pair(spec.id)}
              >
                {busy === `pair:${spec.id}` ? "生成中…" : client?.paired ? "重新配对" : "生成配对令牌"}
              </button>
            </div>

            {client?.lastSeenAt && spec.showsPresence ? (
              <p className="kc-connector-detail">最近一次心跳：{new Date(client.lastSeenAt).toLocaleString("zh-CN")}</p>
            ) : null}

            {token ? (
              <div className="kc-connector-token">
                <span>配对令牌（只显示这一次，请立刻复制）</span>
                <div>
                  <code>{token}</code>
                  <button type="button" className="kc-connector-action" onClick={() => copy(token)}>
                    <Copy aria-hidden="true" /> 复制
                  </button>
                </div>
              </div>
            ) : null}

            <ol className="kc-connector-steps">
              {spec.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>

            <div className="kc-connector-footer">
              {spec.testable ? (
                <button
                  type="button"
                  className="kc-connector-action"
                  disabled={busy !== null || !connected}
                  onClick={() => void test(spec.id)}
                >
                  {busy === `test:${spec.id}` ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : null} 测试连接
                </button>
              ) : null}
              {client?.paired ? (
                <button
                  type="button"
                  className="kc-connector-action"
                  disabled={busy !== null}
                  onClick={() => void revoke(spec.id)}
                >
                  撤销配对
                </button>
              ) : null}
              {testResult && spec.testable ? (
                <span className="kc-connector-detail" data-ok={testResult.ok ? "true" : undefined}>{testResult.text}</span>
              ) : null}
            </div>

            {spec.showsPresence && !connected && client?.paired ? (
              <p className="kc-connector-detail">
                还没收到心跳：确认 Blender 已打开、插件已启用、令牌已粘贴，且能访问 {SERVER_ORIGIN}。
              </p>
            ) : null}
          </div>
        );
      })}

      {statusError ? (
        <div className="kc-connectors-error" role="alert"><CircleAlert aria-hidden="true" /><span>{statusError}</span></div>
      ) : null}

      <p className="kc-connectors-note">
        配对记录目前存在 API 进程内存里：服务重启后需要重新配对（面板会显示"未配对"）。
      </p>
    </section>
  );
});
