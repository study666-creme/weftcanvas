import { randomUUID } from "node:crypto";

import {
  canvasControlCommandSchema,
  type AgentAction,
  type AgentCanvasContext,
  type AgentConnectorId,
  type CanvasControlCommand,
  type CanvasControlReceiptRequest,
} from "@weftcanvas/contracts";

export type CanvasControlSettlement = {
  commandId: string;
  status: CanvasControlReceiptRequest["status"];
  appliedActions: number;
  skippedActions: CanvasControlReceiptRequest["skippedActions"];
  reason: string | null;
};

export type CanvasControlEnqueueResult =
  | { ok: true; command: CanvasControlCommand; receipt: CanvasControlSettlement }
  | { ok: false; error: string };

type PendingEntry = {
  command: CanvasControlCommand;
  resolve: (settlement: CanvasControlSettlement) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_MAX_PENDING = 32;
const DEFAULT_CONTEXT_MAX_AGE_MS = 90_000;

/**
 * 外部连接（Codex MCP）与浏览器之间的画布指令通道：
 * 外部连接入队并等待，画布页面拉取、执行、回执，入队的一方拿到同一条回执。
 * 队列只在内存里，画布页面没打开时指令会等待到超时，不会伪造成功。
 *
 * 浏览器每次拉取都会捎带当前画布摘要，"当前画布"因此可以被外部连接读到；
 * 摘要有存活时间，画布页面关掉后不会继续被当成实时状态。
 */
export class CanvasControlQueue {
  private readonly ttlMs: number;
  private readonly waitMs: number;
  private readonly maxPending: number;
  private readonly contextMaxAgeMs: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingEntry>();
  private active: {
    projectId: string;
    context: AgentCanvasContext | null;
    updatedAt: number;
  } | null = null;

  constructor(
    options: {
      ttlMs?: number;
      waitMs?: number;
      maxPendingPerProject?: number;
      contextMaxAgeMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.maxPending = options.maxPendingPerProject ?? DEFAULT_MAX_PENDING;
    this.contextMaxAgeMs = options.contextMaxAgeMs ?? DEFAULT_CONTEXT_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  /** 当前打开的画布项目；没有画布页面在轮询时为 null。 */
  activeProjectId(): string | null {
    return this.active?.projectId ?? null;
  }

  /** 最近上报且未过期的画布摘要。 */
  activeContext(): AgentCanvasContext | null {
    if (!this.active || !this.active.context) return null;
    if (this.now() - this.active.updatedAt > this.contextMaxAgeMs) return null;
    return this.active.context;
  }

  async enqueue(
    input: { projectId: string; actions: AgentAction[]; summary: string; source: AgentConnectorId },
    signal?: AbortSignal,
  ): Promise<CanvasControlEnqueueResult> {
    this.pruneExpired();
    if (signal?.aborted) return { ok: false, error: "已取消" };

    const projectId = input.projectId.trim();
    if (!projectId) return { ok: false, error: "缺少画布项目" };
    if (!input.actions.length) return { ok: false, error: "指令不包含任何画布操作" };
    const pendingForProject = [...this.pending.values()].filter(
      (entry) => entry.command.projectId === projectId,
    ).length;
    if (pendingForProject >= this.maxPending)
      return { ok: false, error: "这个画布还有未完成的指令，请等浏览器处理完" };

    const createdAt = this.now();
    const parsed = canvasControlCommandSchema.safeParse({
      schemaVersion: 1,
      id: randomUUID(),
      projectId,
      source: input.source,
      summary: input.summary.trim().slice(0, 200) || "外部连接请求的画布操作",
      actions: input.actions,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.ttlMs).toISOString(),
    });
    if (!parsed.success) return { ok: false, error: "画布指令不符合契约" };
    const command = parsed.data;

    return new Promise<CanvasControlEnqueueResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        resolve({ ok: false, error: "画布没有在等待时间内处理这条指令（画布页面可能没有打开）" });
      }, this.waitMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(command.id);
        resolve({ ok: false, error: "已取消" });
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(command.id, {
        command,
        timer,
        resolve: (settlement) => {
          signal?.removeEventListener("abort", abort);
          resolve({ ok: true, command, receipt: settlement });
        },
      });
    });
  }

  /**
   * 浏览器拉取：返回当前项目尚未完成、未过期的指令。重复拉取会返回同一条，
   * 浏览器侧按 commandId 去重，因此刷新页面不会重复执行。
   */
  pendingFor(projectId: string, context?: AgentCanvasContext): CanvasControlCommand[] {
    this.pruneExpired();
    this.active = {
      projectId,
      context: context ?? (this.active?.projectId === projectId ? this.active.context : null),
      updatedAt: this.now(),
    };
    const commands: CanvasControlCommand[] = [];
    for (const entry of this.pending.values()) {
      if (entry.command.projectId !== projectId) continue;
      if (commands.some((command) => command.id === entry.command.id)) continue;
      commands.push(entry.command);
      if (commands.length >= 16) break;
    }
    return commands;
  }

  settle(receipt: CanvasControlReceiptRequest): boolean {
    const entry = this.pending.get(receipt.commandId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(receipt.commandId);
    entry.resolve({
      commandId: receipt.commandId,
      status: receipt.status,
      appliedActions: receipt.appliedActions,
      skippedActions: receipt.skippedActions,
      reason: receipt.reason,
    });
    return true;
  }

  size() {
    return this.pending.size;
  }

  private pruneExpired() {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (Date.parse(entry.command.expiresAt) > now) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({
        commandId: id,
        status: "rejected",
        appliedActions: 0,
        skippedActions: [],
        reason: "指令已过期",
      });
    }
  }
}
