import { spawn } from "node:child_process";

import { connectorEndpointRejectionReason } from "@kachang/contracts";

export type CodexRunResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 8_000;

/**
 * 本机 Codex 委派：把一段任务交给 `codex exec` 非交互执行，返回它的输出。
 * 只在 Codex 连接启用且命令可执行时才会被构建成工具。
 */
export class CodexRunner {
  constructor(
    private readonly command: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async run(prompt: string, signal?: AbortSignal): Promise<CodexRunResult> {
    const value = prompt.trim();
    if (!value) return { ok: false, error: "任务描述为空" };
    if (value.length > MAX_PROMPT_CHARS) return { ok: false, error: "任务描述过长" };
    if (signal?.aborted) return { ok: false, error: "已取消" };
    // command 来自用户可写的连接器配置，Windows 上 spawn 走 shell，
    // 落 exec 前再挡一次 shell 元字符，防止配置串变成命令执行。
    const rejection = connectorEndpointRejectionReason(this.command);
    if (rejection) return { ok: false, error: `连接目标不合法：${rejection}` };

    return new Promise<CodexRunResult>((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const finish = (result: CodexRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };

      let child;
      try {
        child = spawn(this.command, ["exec", value], {
          shell: process.platform === "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve({ ok: false, error: `无法启动 ${this.command}` });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, error: "Codex 执行超时" });
      }, this.timeoutMs);
      const abort = () => {
        child.kill();
        finish({ ok: false, error: "已取消" });
      };
      signal?.addEventListener("abort", abort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
      child.on("error", () => finish({ ok: false, error: `本机找不到 ${this.command}` }));
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish({ ok: false, error: stderr.trim().slice(0, 500) || `Codex 退出码 ${code ?? "unknown"}` });
          return;
        }
        finish({ ok: true, output: stdout.trim().slice(0, MAX_OUTPUT_CHARS) });
      });
    });
  }
}

function appendBounded(current: string, chunk: string) {
  if (current.length >= 400_000) return current;
  return (current + chunk).slice(0, 400_000);
}
