import { randomUUID } from "node:crypto";

import { canvasControlCommandSchema, type AgentAction, type AgentCanvasContext, type CanvasControlCommand, type CanvasControlReceiptRequest } from "@kachang/contracts";

/**
 * 托管站点上"外部连接操作画布"的服务端一半。
 *
 * Codex 之类的外部客户端通过 MCP 下单，命令**必须由浏览器执行**（画布状态在浏览器里），
 * 所以这里只做队列与投递：浏览器照旧轮询 /api/v1/agent/canvas-control/*，执行完回执。
 * 队列按用户隔离，令牌只能影响自己名下的画布。
 */

const COMMAND_TTL_MS = 5 * 60_000;
const MAX_PENDING_PER_OWNER = 32;
const DEFAULT_WAIT_MS = 60_000;
const CONTEXT_MAX_AGE_MS = 90_000;

export type CanvasCommandOutcome = {
  commandId: string;
  status: CanvasControlReceiptRequest["status"];
  appliedActions: number;
  skippedActions: CanvasControlReceiptRequest["skippedActions"];
  reason: string | null;
};

type PendingEntry = {
  command: CanvasControlCommand;
  ownerId: string;
  resolve: (outcome: CanvasCommandOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CanvasCommandBrokerOptions = {
  now?: () => number;
  waitMs?: number;
};

export class CanvasCommandBroker {
  private readonly now: () => number;
  private readonly waitMs: number;
  private readonly pending = new Map<string, PendingEntry>();
  /** ownerId -> 浏览器最近上报的画布摘要与项目 */
  private readonly contexts = new Map<string, { projectId: string; context: AgentCanvasContext | null; at: number }>();

  constructor(options: CanvasCommandBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  }

  /** 浏览器轮询时上报当前画布，外部连接据此读到真实的节点 id。 */
  rememberContext(ownerId: string, projectId: string, context?: AgentCanvasContext) {
    const current = this.contexts.get(ownerId);
    this.contexts.set(ownerId, {
      projectId,
      context: context ?? (current?.projectId === projectId ? current.context : null),
      at: this.now(),
    });
  }

  readContext(ownerId: string): { projectId: string; context: AgentCanvasContext | null } | null {
    const current = this.contexts.get(ownerId);
    if (!current) return null;
    const fresh = this.now() - current.at <= CONTEXT_MAX_AGE_MS;
    return { projectId: current.projectId, context: fresh ? current.context : null };
  }

  /** 浏览器拉取待执行指令；浏览器侧按 commandId 去重，重复拉取不会重复执行。 */
  pendingFor(ownerId: string): CanvasControlCommand[] {
    this.pruneExpired();
    const commands: CanvasControlCommand[] = [];
    for (const entry of this.pending.values()) {
      if (entry.ownerId !== ownerId) continue;
      commands.push(entry.command);
      if (commands.length >= 16) break;
    }
    return commands;
  }

  /** 浏览器回执。返回 false 表示这条指令不属于本队列（调用方应转交其它来源）。 */
  submitReceipt(ownerId: string, receipt: CanvasControlReceiptRequest): boolean {
    const entry = this.pending.get(receipt.commandId);
    if (!entry || entry.ownerId !== ownerId) return false;
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

  /** 外部连接下单并等浏览器回执。画布页面没打开时会超时，不伪造成功。 */
  enqueue(
    ownerId: string,
    input: { actions: AgentAction[]; summary: string; projectId?: string },
    signal?: AbortSignal,
  ): Promise<CanvasCommandOutcome | null> {
    this.pruneExpired();
    if (signal?.aborted) return Promise.resolve(null);
    const projectId = input.projectId?.trim() || this.readContext(ownerId)?.projectId;
    if (!projectId) return Promise.resolve(null);
    if (!input.actions.length) return Promise.resolve(null);
    if ([...this.pending.values()].filter((entry) => entry.ownerId === ownerId).length >= MAX_PENDING_PER_OWNER) {
      return Promise.resolve(null);
    }

    const createdAt = this.now();
    const parsed = canvasControlCommandSchema.safeParse({
      schemaVersion: 1,
      id: randomUUID(),
      projectId,
      source: "codex",
      summary: input.summary.trim().slice(0, 200) || "外部连接请求的画布操作",
      actions: input.actions,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + COMMAND_TTL_MS).toISOString(),
    });
    if (!parsed.success) return Promise.resolve(null);
    const command = parsed.data;

    return new Promise<CanvasCommandOutcome | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        resolve({ commandId: command.id, status: "rejected", appliedActions: 0, skippedActions: [], reason: "画布没有在等待时间内处理这条指令" });
      }, this.waitMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(command.id);
        resolve(null);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(command.id, {
        command,
        ownerId,
        timer,
        resolve: (outcome) => {
          signal?.removeEventListener("abort", abort);
          resolve(outcome);
        },
      });
    });
  }

  private pruneExpired() {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (Date.parse(entry.command.expiresAt) > now) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ commandId: id, status: "rejected", appliedActions: 0, skippedActions: [], reason: "指令已过期" });
    }
  }
}
