import { spawn } from "node:child_process";
import { connect } from "node:net";

import { connectorEndpointRejectionReason, connectorHostRejectionReason } from "@kachang/contracts";

export type ProbeResult = {
  reachable: boolean;
  /** 不可用时的原因，或可用时的版本信息。 */
  detail: string | null;
};

export type ConnectorProbes = {
  codex(command: string, signal?: AbortSignal): Promise<ProbeResult>;
  blender(endpoint: string, signal?: AbortSignal): Promise<ProbeResult>;
};

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/** 探测本机 Codex CLI 是否可执行：`codex --version`。 */
export async function probeCodexCommand(
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // Windows 上 spawn 走 shell；命令串来自用户可写的连接器配置，
  // 元字符检查是 spawn 前的最后一道闸。
  const rejection = connectorEndpointRejectionReason(command);
  if (rejection) return { reachable: false, detail: `连接目标不合法：${rejection}` };
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      // Windows 上的 codex 通常是 .cmd，必须经 shell 解析。
      child = spawn(command, ["--version"], { shell: process.platform === "win32", windowsHide: true });
    } catch {
      finish({ reachable: false, detail: `无法启动 ${command}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ reachable: false, detail: `${command} 探测超时` });
    }, timeoutMs);
    const abort = () => {
      child.kill();
      finish({ reachable: false, detail: "探测已取消" });
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => finish({ reachable: false, detail: `本机找不到 ${command}` }));
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (settled) return;
      if (code === 0) {
        finish({ reachable: true, detail: stdout.trim().split("\n")[0]?.slice(0, 120) || null });
      } else {
        finish({ reachable: false, detail: `${command} 退出码 ${code ?? "unknown"}` });
      }
    });
  });
}

/** 探测 Blender 桥接端口是否可连接。 */
export async function probeBlenderEndpoint(
  endpoint: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = parseEndpoint(endpoint);
  if (!parsed) return { reachable: false, detail: "地址需要写成 host:port" };
  const hostRejection = connectorHostRejectionReason(endpoint);
  if (hostRejection) return { reachable: false, detail: `连接目标不合法：${hostRejection}` };
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = connect({ host: parsed.host, port: parsed.port });
    const timer = setTimeout(() => {
      socket.destroy();
      finish({ reachable: false, detail: "连接 Blender 超时" });
    }, timeoutMs);
    const abort = () => {
      socket.destroy();
      finish({ reachable: false, detail: "探测已取消" });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.end();
      finish({ reachable: true, detail: null });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      finish({
        reachable: false,
        detail: error.code === "ECONNREFUSED"
          ? "端口上没有 Blender 桥接在监听"
          : `无法连接 ${parsed.host}:${parsed.port}`,
      });
    });
  });
}

export function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  const value = endpoint.trim();
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(value);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const host = match[1]!.trim();
  if (!host) return null;
  return { host, port };
}

export function defaultProbes(): ConnectorProbes {
  return {
    codex: (command, signal) => probeCodexCommand(command, { ...(signal ? { signal } : {}) }),
    blender: (endpoint, signal) => probeBlenderEndpoint(endpoint, { ...(signal ? { signal } : {}) }),
  };
}
