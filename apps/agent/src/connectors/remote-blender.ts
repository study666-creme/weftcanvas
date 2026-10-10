import type { AgentTool } from "../tools.js";

export type RemoteBlenderResult = { ok: boolean; content: string };

/**
 * 通过 Canvas API 把 Python 派发到"用户自己机器上的 Blender"。
 *
 * 托管站点上运行时在服务器上，服务器没有、也不该有用户的 Blender；
 * 用户机器上的插件用配对令牌主动连到 API 领取任务，所以这里只需要 API 的地址与共享令牌。
 */
export class RemoteBlenderRunner {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 60_000,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Canvas API URL must use HTTP or HTTPS");
    if (!token.trim()) throw new Error("Agent runtime token is required");
    this.endpoint = new URL("/internal/v1/connectors/blender/run", url).toString();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(ownerId: string, code: string, signal?: AbortSignal): Promise<RemoteBlenderResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Remote Blender dispatch timed out")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ownerId, code }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, content: "用户机器上的 Blender 暂时不可达" };
      }
      const payload = await response.json() as {
        ok?: unknown;
        data?: { status?: unknown; stdout?: unknown; error?: unknown };
      };
      const data = payload?.data;
      if (payload?.ok !== true || !data) return { ok: false, content: "连接服务返回了无法识别的结果" };
      if (data.status === "completed") {
        const stdout = typeof data.stdout === "string" ? data.stdout.trim() : "";
        return {
          ok: true,
          content: stdout ? `Blender 执行完成：\n${stdout.slice(0, 2_000)}` : "Blender 执行完成。",
        };
      }
      const reason = typeof data.error === "string" && data.error
        ? data.error
        : data.status === "timeout"
          ? "等待用户机器回执超时"
          : data.status === "disconnected"
            ? "用户机器上的 Blender 当前不在线"
            : "Blender 执行失败";
      return { ok: false, content: reason };
    } catch {
      return { ok: false, content: "用户机器上的 Blender 暂时不可达" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

/** 与本地桥接工具同名同参数，所以提示词与工具目录不需要分叉。 */
export function createRemoteBlenderTool(runner: RemoteBlenderRunner, ownerId: string): AgentTool {
  return {
    name: "blender_run_python",
    description: "在用户自己机器的 Blender 中执行一段 Python（bpy）代码，并返回 stdout。用于建模、材质、场景整理和渲染准备。",
    parameters: [
      { name: "code", description: "完整可执行的 Python 代码，可用 bpy 与 bpy.context", required: true },
      { name: "purpose", description: "这次操作的中文目的，会显示给用户", required: false },
    ],
    async run(args, context) {
      const value = args["code"];
      const code = typeof value === "string" ? value.trim() : "";
      if (!code) return { ok: false, content: "缺少要执行的 Python 代码" };
      return runner.run(ownerId, code, context.signal);
    },
  };
}
