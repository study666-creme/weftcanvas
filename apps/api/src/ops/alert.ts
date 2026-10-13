import { OPS_STALE_INFLIGHT_MS, type CanvasOpsService, type OpsOverview } from "./service.js";

export type OpsAlert = {
  key: string;
  level: "warning" | "critical";
  message: string;
};

export type OpsAlertSink = (alert: OpsAlert) => Promise<void>;

export type OpsAlertWatchdogDeps = {
  ops: Pick<CanvasOpsService, "overview">;
  sink: OpsAlertSink;
  /** 检查周期与同一告警的冷却时长。 */
  intervalMs?: number;
  cooldownMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;
/** 失败率告警的最小样本量：样本太少不结论。 */
const FAILURE_RATE_MIN_SAMPLES = 20;
const FAILURE_RATE_THRESHOLD = 0.3;
/** 目录过期前的预警窗口。 */
const CATALOG_EXPIRING_MS = 15 * 60_000;

/**
 * 运营告警看门狗：周期性拉后台总览，按规则产出去重告警（同一 key 冷却期内
 * 只发一次，条件恢复后重新武装）。sink 抛错只记日志，绝不让周期停摆——
 * 这是 operations-launch-review 第 13 条「有端点缺通道」的通道侧。
 */
export class OpsAlertWatchdog {
  private readonly intervalMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private lastAlertAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly deps: OpsAlertWatchdogDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = deps.now ?? Date.now;
  }

  start() {
    if (this.timer) return;
    void this.checkOnce();
    this.timer = setInterval(() => void this.checkOnce(), this.intervalMs);
    // 看门狗不阻止进程退出。
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 单飞：上一轮没跑完就跳过本轮，不排队堆积。 */
  checkOnce(): Promise<void> {
    if (this.checking) return this.checking;
    const run = (async () => {
      try {
        const overview = await this.deps.ops.overview();
        const alerts = this.evaluate(overview);
        const activeKeys = new Set(alerts.map((alert) => alert.key));
        // 已恢复的告警解除冷却，下次发生立刻能再报。
        for (const key of [...this.lastAlertAt.keys()]) {
          if (!activeKeys.has(key)) this.lastAlertAt.delete(key);
        }
        const now = this.now();
        for (const alert of alerts) {
          const last = this.lastAlertAt.get(alert.key);
          if (last !== undefined && now - last < this.cooldownMs) continue;
          this.lastAlertAt.set(alert.key, now);
          try {
            await this.deps.sink(alert);
          } catch (error) {
            this.deps.onError?.(error);
          }
        }
      } catch (error) {
        // 总览拉取失败本身就是信号：静默重试，不打断周期。
        this.deps.onError?.(error);
      } finally {
        this.checking = null;
      }
    })();
    this.checking = run;
    return run;
  }

  evaluate(overview: OpsOverview): OpsAlert[] {
    const alerts: OpsAlert[] = [];
    const now = this.now();

    if (!overview.catalog.version || !overview.catalog.quoteAvailable) {
      alerts.push({
        key: "catalog-unavailable",
        level: "critical",
        message: "画布模型目录不可用或报价 fail-closed：用户将无法提交生成。",
      });
    } else if (
      overview.catalog.expiresAt &&
      new Date(overview.catalog.expiresAt).getTime() - now < CATALOG_EXPIRING_MS
    ) {
      alerts.push({
        key: "catalog-expiring",
        level: "warning",
        message: "模型目录即将过期（15 分钟内）且刷新可能停滞，请检查上游目录拉取。",
      });
    }

    const terminal = overview.jobs.completed + overview.jobs.failed;
    if (
      terminal >= FAILURE_RATE_MIN_SAMPLES &&
      overview.jobs.failed / terminal > FAILURE_RATE_THRESHOLD
    ) {
      alerts.push({
        key: "failure-rate",
        level: "warning",
        message: `近 ${overview.windowHours} 小时生成任务失败率 ${(
          (overview.jobs.failed / terminal) *
          100
        ).toFixed(0)}%（${overview.jobs.failed}/${terminal}），超过 30% 阈值。`,
      });
    }

    if (overview.jobs.staleInFlight > 0) {
      alerts.push({
        key: "queue-backlog",
        level: "warning",
        message: `${overview.jobs.staleInFlight} 个生成任务超过 ${
          OPS_STALE_INFLIGHT_MS / 60_000
        } 分钟未推进（在途 ${overview.jobs.inFlight} 个），请检查 worker 与上游通道。`,
      });
    }

    return alerts;
  }
}

/** 通用 webhook sink：POST {text, key, level}，兼容 Slack/DingTalk 文本转发格式。 */
export function createWebhookAlertSink(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): OpsAlertSink {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return async (alert) => {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `【画布运营】${alert.message}`, ...alert }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`ops alert webhook responded ${response.status}`);
  };
}
