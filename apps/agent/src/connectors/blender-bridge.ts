import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

import { connectorHostRejectionReason } from "@weftcanvas/contracts";

import { parseEndpoint } from "./probe.js";

export type BlenderRunResult =
  { ok: true; value: unknown; stdout: string } | { ok: false; error: string };

type BridgeResponse = {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
};

const MAX_PYTHON_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** 与桥接（apps/agent/blender/weftcanvas_bridge.py）同一套令牌来源：env 直配或用户主目录令牌文件。 */
export const BRIDGE_TOKEN_ENV = "WEFTCANVAS_BRIDGE_TOKEN";
export const BRIDGE_TOKEN_FILE_ENV = "WEFTCANVAS_BRIDGE_TOKEN_FILE";

export function defaultBridgeTokenFile(): string {
  return join(homedir(), ".weftcanvas-bridge", "token");
}

/** 解析本机桥接访问令牌；找不到时返回 null（由调用方给出可操作的错误文案）。 */
export function resolveBridgeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[BRIDGE_TOKEN_ENV]?.trim();
  if (explicit) return explicit;
  const file = env[BRIDGE_TOKEN_FILE_ENV]?.trim() || defaultBridgeTokenFile();
  try {
    const value = readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Blender 桥接客户端：一行 JSON 请求、一行 JSON 响应。
 * 协议实现见 apps/agent/blender/weftcanvas_bridge.py。本机模式的端口要求访问令牌，
 * 令牌来源见 resolveBridgeToken——每次调用都重新解析，桥接轮换令牌后无需重启 Agent。
 */
export class BlenderBridgeClient {
  constructor(
    private readonly address: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly tokenProvider: () => string | null = () => resolveBridgeToken(),
  ) {}

  async runPython(code: string, signal?: AbortSignal): Promise<BlenderRunResult> {
    if (!code.trim()) return { ok: false, error: "Python 代码为空" };
    if (code.length > MAX_PYTHON_CHARS) return { ok: false, error: "Python 代码过长" };
    const response = await this.call("run_python", { code }, signal);
    return response;
  }

  async ping(signal?: AbortSignal): Promise<BlenderRunResult> {
    return this.call("ping", {}, signal);
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BlenderRunResult> {
    const parsed = parseEndpoint(this.address);
    if (!parsed) return { ok: false, error: "Blender 桥接地址无效，需要 host:port" };
    const hostRejection = connectorHostRejectionReason(this.address);
    if (hostRejection) return { ok: false, error: `Blender 桥接地址不合法：${hostRejection}` };
    if (signal?.aborted) return { ok: false, error: "已取消" };
    const token = this.tokenProvider();
    if (!token) {
      return {
        ok: false,
        error:
          "找不到 Blender 桥接访问令牌：请先在 Blender 里启动桥接（它会在用户主目录生成令牌），或用 WEFTCANVAS_BRIDGE_TOKEN 指定",
      };
    }

    return new Promise<BlenderRunResult>((resolve) => {
      const id = randomUUID();
      let settled = false;
      let buffer = "";
      const finish = (result: BlenderRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        resolve(result);
      };

      const socket = connect({ host: parsed.host, port: parsed.port });
      const timer = setTimeout(
        () => finish({ ok: false, error: "等待 Blender 响应超时" }),
        this.timeoutMs,
      );
      const abort = () => finish({ ok: false, error: "已取消" });
      signal?.addEventListener("abort", abort, { once: true });

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params, token })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (buffer.length > 4_000_000) finish({ ok: false, error: "Blender 返回内容过大" });
          return;
        }
        const line = buffer.slice(0, newline);
        const parsedResponse = parseResponse(line);
        if (!parsedResponse) {
          finish({ ok: false, error: "无法解析 Blender 返回内容" });
          return;
        }
        if (parsedResponse.id !== undefined && parsedResponse.id !== id) {
          finish({ ok: false, error: "Blender 返回了不匹配的响应" });
          return;
        }
        if (parsedResponse.ok === true) {
          const result = isRecord(parsedResponse.result) ? parsedResponse.result : {};
          finish({
            ok: true,
            value: result.value ?? null,
            stdout: typeof result.stdout === "string" ? result.stdout : "",
          });
          return;
        }
        finish({
          ok: false,
          error:
            typeof parsedResponse.error === "string" ? parsedResponse.error : "Blender 执行失败",
        });
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          error:
            error.code === "ECONNREFUSED"
              ? "Blender 桥接没有在监听，请先在 Blender 里运行 weftcanvas_bridge.py"
              : `无法连接 Blender 桥接：${error.code ?? "未知错误"}`,
        });
      });
      socket.on("close", () => finish({ ok: false, error: "Blender 桥接提前关闭了连接" }));
    });
  }
}

function parseResponse(line: string): BridgeResponse | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
