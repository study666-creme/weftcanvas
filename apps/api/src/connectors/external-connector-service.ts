import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  AgentConnectorId,
  ConnectorClientStatus,
  ExternalTask,
  ExternalTaskMethod,
  ExternalTaskResultRequest,
} from "@kachang/contracts";

/**
 * 用户侧反向连接的服务端一半：配对令牌、在线状态、以及"在用户机器上跑一条任务"的投递队列。
 *
 * 方向：用户的 Blender / Codex 跑在**用户自己的机器**上，主动轮询这里领取任务并回传结果。
 * 服务端从不试图在服务器上找 Blender、写 Codex 配置；配对令牌只允许领取/回传**本用户自己**
 * 的任务，画布写入仍然只走浏览器侧的会话 API。
 *
 * 状态放在进程内存里：单实例部署下够用，重启后用户需要重新配对（面板会如实显示"未配对"）。
 * 持久化（Postgres 表或状态文件）是明确的后续项，见 docs/AGENT-CONNECTORS.md。
 */

const TOKEN_BYTES = 32;
const MAX_OUTSTANDING_PER_CONNECTOR = 8;
const MAX_TASK_PARAM_CHARS = 24_000;
const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_POLL_AFTER_MS = 3_000;
/** 超过这个时长没轮询过就视为离线。 */
export const CONNECTOR_ONLINE_WINDOW_MS = 30_000;

type Pairing = {
  ownerId: string;
  connectorId: AgentConnectorId;
  createdAt: number;
  lastUsedAt: number | null;
};

type TaskEntry = {
  task: ExternalTask;
  ownerId: string;
  /** 已投递给客户端、等待回执。 */
  delivered: boolean;
  resolve: (result: TaskOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type TaskOutcome = {
  taskId: string;
  status: "completed" | "failed" | "timeout" | "disconnected";
  stdout: string;
  error: string | null;
};

export type ConnectorPairing = {
  connectorId: AgentConnectorId;
  token: string;
  createdAt: string;
};

export type ExternalConnectorServiceOptions = {
  now?: () => number;
  /** 令牌可用期；到期后需要重新配对。null 表示不过期。 */
  tokenTtlMs?: number | null;
};

export class ExternalConnectorService {
  private readonly now: () => number;
  private readonly tokenTtlMs: number | null;
  /** tokenHash -> 配对记录（令牌只存 sha256，不存明文） */
  private readonly pairings = new Map<string, Pairing>();
  /** `${ownerId}:${connectorId}` -> tokenHash */
  private readonly pairingsByOwner = new Map<string, string>();
  /** `${ownerId}:${connectorId}` -> 最后一次轮询时间 */
  private readonly presence = new Map<string, number>();
  /** taskId -> 任务；已投递与未投递都记在这里，靠 delivered 区分 */
  private readonly tasks = new Map<string, TaskEntry>();
  /** `${ownerId}:${connectorId}` -> 尚未投递的 taskId */
  private readonly undelivered = new Map<string, string[]>();

  constructor(options: ExternalConnectorServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenTtlMs = options.tokenTtlMs ?? null;
  }

  /** 创建或轮换配对令牌；明文令牌只在这里返回一次。 */
  createPairing(ownerId: string, connectorId: AgentConnectorId): ConnectorPairing {
    this.revokePairing(ownerId, connectorId);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const createdAt = this.now();
    this.pairings.set(hashToken(token), { ownerId, connectorId, createdAt, lastUsedAt: null });
    this.pairingsByOwner.set(scopeKey(ownerId, connectorId), hashToken(token));
    return { connectorId, token, createdAt: new Date(createdAt).toISOString() };
  }

  revokePairing(ownerId: string, connectorId: AgentConnectorId): boolean {
    const key = scopeKey(ownerId, connectorId);
    const tokenHash = this.pairingsByOwner.get(key);
    this.pairingsByOwner.delete(key);
    this.presence.delete(key);
    this.undelivered.delete(key);
    // 还没结算的任务不可能再被领取：以超时收敛并说明原因，不挂起、不伪成功。
    for (const [taskId, entry] of this.tasks) {
      if (scopeKey(entry.ownerId, entry.task.connectorId) !== key) continue;
      clearTimeout(entry.timer);
      this.tasks.delete(taskId);
      entry.resolve({ taskId, status: "timeout", stdout: "", error: "配对已撤销" });
    }
    if (!tokenHash) return false;
    return this.pairings.delete(tokenHash);
  }

  listStatus(ownerId: string, connectorIds: readonly AgentConnectorId[]): ConnectorClientStatus[] {
    return connectorIds.map((connectorId) => {
      const key = scopeKey(ownerId, connectorId);
      const tokenHash = this.pairingsByOwner.get(key);
      const pairing = tokenHash ? this.pairings.get(tokenHash) : undefined;
      const lastSeenAt = this.presence.get(key) ?? null;
      return {
        connectorId,
        paired: Boolean(pairing),
        connected: lastSeenAt !== null && this.now() - lastSeenAt <= CONNECTOR_ONLINE_WINDOW_MS,
        pairedAt: pairing ? new Date(pairing.createdAt).toISOString() : null,
        lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
      };
    });
  }

  /** 令牌鉴权：解析令牌归属。 */
  authenticate(token: string): { ownerId: string; connectorId: AgentConnectorId } | null {
    const pairing = this.resolvePairing(token);
    if (!pairing) return null;
    return { ownerId: pairing.ownerId, connectorId: pairing.connectorId };
  }

  /** 令牌鉴权：领取待办任务。领取后标记为"已投递"，不会重复投递。 */
  poll(input: { token: string; connectorId: AgentConnectorId }, limit = 4): { tasks: ExternalTask[]; ownerId: string } | null {
    const pairing = this.resolvePairing(input.token);
    if (!pairing || pairing.connectorId !== input.connectorId) return null;
    const key = scopeKey(pairing.ownerId, pairing.connectorId);
    this.markSeen(key, pairing);

    const queued = this.undelivered.get(key) ?? [];
    const claimed: ExternalTask[] = [];
    const rest: string[] = [];
    for (const taskId of queued) {
      const entry = this.tasks.get(taskId);
      if (!entry) continue; // 已被结算或超时清理
      if (claimed.length < limit) {
        entry.delivered = true;
        claimed.push(entry.task);
      } else {
        rest.push(taskId);
      }
    }
    if (rest.length) this.undelivered.set(key, rest);
    else this.undelivered.delete(key);
    return { tasks: claimed, ownerId: pairing.ownerId };
  }

  /** 令牌鉴权：回传任务结果。令牌只能结算自己名下、且属于同一连接的任务。 */
  submitResult(token: string, result: ExternalTaskResultRequest): boolean {
    const pairing = this.resolvePairing(token);
    if (!pairing || pairing.connectorId !== result.connectorId) return false;
    const entry = this.tasks.get(result.taskId);
    if (!entry) return false;
    if (entry.ownerId !== pairing.ownerId || entry.task.connectorId !== result.connectorId) return false;
    this.settle(entry, {
      taskId: result.taskId,
      status: result.ok ? "completed" : "failed",
      stdout: result.stdout ?? "",
      error: result.error ?? null,
    });
    return true;
  }

  /**
   * 会话鉴权：在用户自己的机器上跑一条任务并等结果。
   * 面板的「测试连接」用它；Agent 的 blender 工具将来复用同一个方法。
   */
  async runTask(
    ownerId: string,
    input: { connectorId: AgentConnectorId; method: ExternalTaskMethod; params: Record<string, unknown>; waitMs?: number },
  ): Promise<TaskOutcome> {
    const taskId = randomUUID();
    const key = scopeKey(ownerId, input.connectorId);
    if (!this.pairingsByOwner.has(key)) {
      return { taskId, status: "failed", stdout: "", error: "这个连接还没有配对" };
    }
    const lastSeenAt = this.presence.get(key) ?? null;
    if (lastSeenAt === null || this.now() - lastSeenAt > CONNECTOR_ONLINE_WINDOW_MS) {
      return { taskId, status: "disconnected", stdout: "", error: "用户机器上的客户端当前不在线" };
    }
    const params = input.params ?? {};
    if (JSON.stringify(params).length > MAX_TASK_PARAM_CHARS) {
      return { taskId, status: "failed", stdout: "", error: "任务参数过大" };
    }
    if (this.outstandingCount(key) >= MAX_OUTSTANDING_PER_CONNECTOR) {
      return { taskId, status: "failed", stdout: "", error: "待办任务过多，请稍后重试" };
    }

    const createdAt = this.now();
    const task: ExternalTask = {
      schemaVersion: 1,
      id: taskId,
      connectorId: input.connectorId,
      method: input.method,
      params,
      createdAt: new Date(createdAt).toISOString(),
    };
    const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
    return new Promise<TaskOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.tasks.get(taskId);
        if (entry) {
          this.settle(entry, { taskId, status: "timeout", stdout: "", error: "等待用户机器的回执超时" });
        }
      }, waitMs);
      this.tasks.set(taskId, { task, ownerId, delivered: false, resolve, timer });
      this.undelivered.set(key, [...(this.undelivered.get(key) ?? []), taskId]);
    });
  }

  /** 未结算的任务数（未投递 + 已投递待回执）。 */
  pendingCount(ownerId: string): number {
    let total = 0;
    for (const entry of this.tasks.values()) {
      if (entry.ownerId === ownerId) total += 1;
    }
    return total;
  }

  pollAfterMs(): number {
    return DEFAULT_POLL_AFTER_MS;
  }

  private outstandingCount(key: string) {
    let total = 0;
    for (const entry of this.tasks.values()) {
      if (scopeKey(entry.ownerId, entry.task.connectorId) === key) total += 1;
    }
    return total;
  }

  private settle(entry: TaskEntry, outcome: TaskOutcome) {
    clearTimeout(entry.timer);
    this.tasks.delete(outcome.taskId);
    const key = scopeKey(entry.ownerId, entry.task.connectorId);
    const queued = this.undelivered.get(key);
    if (queued) {
      const rest = queued.filter((taskId) => taskId !== outcome.taskId);
      if (rest.length) this.undelivered.set(key, rest);
      else this.undelivered.delete(key);
    }
    entry.resolve(outcome);
  }

  private markSeen(key: string, pairing: Pairing) {
    pairing.lastUsedAt = this.now();
    this.presence.set(key, pairing.lastUsedAt);
  }

  private resolvePairing(token: string): Pairing | null {
    const value = token.trim();
    if (!value) return null;
    const pairing = this.pairings.get(hashToken(value));
    if (!pairing) return null;
    if (this.tokenTtlMs !== null && this.now() - pairing.createdAt > this.tokenTtlMs) {
      this.revokePairing(pairing.ownerId, pairing.connectorId);
      return null;
    }
    return pairing;
  }
}

function scopeKey(ownerId: string, connectorId: AgentConnectorId) {
  return `${ownerId}:${connectorId}`;
}

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
