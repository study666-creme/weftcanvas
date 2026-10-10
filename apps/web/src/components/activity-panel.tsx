import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Coins,
  Copy,
  LoaderCircle,
  Receipt,
  RefreshCw,
  X,
} from "lucide-react";
import type { PublicGenerationJob, WalletLedgerItem } from "@kachang/contracts";

import { fetchGenerationJob, listGenerationJobs } from "../lib/api-client";
import { useIdentityStore } from "../state/identity-store";
import { useWalletStore } from "../state/wallet-store";

type TabId = "jobs" | "credits";

export function ActivityPanel({
  onClose,
  projectId,
  defaultTab = "jobs",
  surface = "entry",
}: {
  onClose: () => void;
  projectId: string;
  defaultTab?: TabId;
  surface?: "entry" | "canvas";
}) {
  const [tab, setTab] = useState<TabId>(defaultTab);
  const identityStatus = useIdentityStore((state) => state.status);
  const ledger = useWalletStore((state) => state.ledger);
  const ledgerStatus = useWalletStore((state) => state.ledgerStatus);
  const loadLedger = useWalletStore((state) => state.loadLedger);
  const summary = useWalletStore((state) => state.summary);

  const [jobs, setJobs] = useState<PublicGenerationJob[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);

  const loadJobs = async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      const list = await listGenerationJobs(projectId, 50);
      setJobs(list);
    } catch (cause) {
      setJobsError(cause instanceof Error ? cause.message : "任务列表读取失败");
    } finally {
      setJobsLoading(false);
    }
  };

  useEffect(() => {
    if (identityStatus !== "authenticated") return;
    void loadJobs();
    void loadLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityStatus, projectId]);

  return (
    <aside className={`kc-activity-panel kc-activity-panel--${surface}`} aria-label="任务记录与积分">
      <header className="kc-activity-header">
        <span className="kc-activity-title">
          <ClipboardList aria-hidden="true" />
          <strong>任务记录</strong>
        </span>
        <div className="kc-activity-tabs" role="tablist" aria-label="切换视图">
          <button type="button" role="tab" aria-selected={tab === "jobs"} className={tab === "jobs" ? "is-active" : undefined} onClick={() => setTab("jobs")}>
            任务日志
          </button>
          <button type="button" role="tab" aria-selected={tab === "credits"} className={tab === "credits" ? "is-active" : undefined} onClick={() => setTab("credits")}>
            积分明细
          </button>
        </div>
        <button type="button" className="kc-activity-close" aria-label="关闭" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>

      {identityStatus !== "authenticated" ? (
        <div className="kc-activity-empty">
          <p>登录后可查看任务日志与积分明细。</p>
        </div>
      ) : tab === "jobs" ? (
        <div className="kc-activity-body">
          <div className="kc-activity-toolbar">
            <span>{jobs ? `${jobs.length} 个任务` : "读取中"}</span>
            <button type="button" onClick={() => void loadJobs()} disabled={jobsLoading} aria-label="刷新任务">
              <RefreshCw aria-hidden="true" className={jobsLoading ? "is-spinning" : undefined} />
            </button>
          </div>
          {jobsError ? <p className="kc-activity-error"><CircleAlert aria-hidden="true" />{jobsError}</p> : null}
          {jobsLoading && !jobs ? <p className="kc-activity-loading"><LoaderCircle aria-hidden="true" className="is-spinning" />正在读取任务…</p> : null}
          {jobs && !jobs.length ? <div className="kc-activity-empty"><p>还没有生成任务。</p></div> : null}
          {jobs?.map((job) => <JobRow key={job.id} job={job} />)}
        </div>
      ) : (
        <div className="kc-activity-body">
          {summary ? (
            <div className="kc-activity-balance">
              <Coins aria-hidden="true" />
              <span>当前余额</span>
              <strong>{formatCredits(summary.credits)}</strong>
            </div>
          ) : null}
          {ledgerStatus === "loading" && !ledger.length ? <p className="kc-activity-loading"><LoaderCircle aria-hidden="true" className="is-spinning" />正在读取积分明细…</p> : null}
          {ledgerStatus === "ready" && !ledger.length ? <div className="kc-activity-empty"><p>还没有积分变动。</p></div> : null}
          {ledger.map((item) => (
            <LedgerRow
              key={item.id}
              item={item}
              job={item.refId ? jobs?.find((job) => job.id === item.refId) ?? null : null}
              onOpenJob={() => setTab("jobs")}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function JobRow({ job }: { job: PublicGenerationJob }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<PublicGenerationJob | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const status = jobStatusLabel(job);
  const referenceCount = countReferences(job);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail && !detailLoading) {
      setDetailLoading(true);
      try {
        setDetail(await fetchGenerationJob(job.id));
      } catch {
        setDetail(job);
      } finally {
        setDetailLoading(false);
      }
    }
  };

  const requestBody = useMemo(() => {
    const source = detail ?? job;
    const parameters = source.parameters ?? {};
    const inputs = source.inputs;
    return {
      modelId: source.modelId,
      modality: source.modality,
      parameters,
      inputs: inputs ?? null,
    };
  }, [detail, job]);

  return (
    <article className={`kc-activity-job is-${status.tone}`}>
      <button type="button" className="kc-activity-job-main" onClick={() => void toggle()} aria-expanded={open}>
        <span className="kc-activity-job-caret">{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</span>
        <span className="kc-activity-job-copy">
          <strong>{job.modelLabel}</strong>
          <small>{formatTime(job.createdAt)} · {status.text}{referenceCount ? ` · ${referenceCount} 个参考` : ""}</small>
        </span>
        <span className={`kc-activity-job-status is-${status.tone}`}>{status.badge}</span>
      </button>
      {job.error ? (
        <p className="kc-activity-job-error">
          <CircleAlert aria-hidden="true" />
          <span>{job.error.message}{job.error.retryable ? "（可重试）" : ""}</span>
        </p>
      ) : null}
      {open ? (
        <div className="kc-activity-job-detail">
          {detailLoading ? <p className="kc-activity-loading"><LoaderCircle aria-hidden="true" className="is-spinning" />读取请求体…</p> : null}
          <div className="kc-activity-request">
            <div className="kc-activity-request-head">
              <span><Receipt aria-hidden="true" />请求体</span>
              <CopyButton value={JSON.stringify(requestBody, null, 2)} />
            </div>
            <pre>{JSON.stringify(requestBody, null, 2)}</pre>
          </div>
          {referenceCount === 0 && hasReferenceIntent(job) ? (
            <p className="kc-activity-warn">提示词里提到了参考素材，但请求体没有带入任何参考图 —— 参考图可能在上传或提交时丢失。</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function LedgerRow({
  item,
  job,
  onOpenJob,
}: {
  item: WalletLedgerItem;
  job?: PublicGenerationJob | null;
  onOpenJob?: () => void;
}) {
  const positive = item.delta >= 0;
  // 生成类扣费的模型名/时长/分辨率：与任务日志一一对应，不再"各记各的"
  const meta = (item.meta ?? {}) as Record<string, unknown>;
  const model = typeof meta.model === "string" && meta.model ? meta.model : null;
  const duration = typeof meta.duration === "number" && meta.duration > 0 ? meta.duration : null;
  const resolution = typeof meta.resolution === "string" && meta.resolution ? meta.resolution : null;
  const spec = [model, duration ? `${duration}s` : null, resolution].filter(Boolean).join(" · ");
  return (
    <article className="kc-activity-ledger">
      <span className={`kc-activity-ledger-delta ${positive ? "is-positive" : "is-negative"}`}>
        {positive ? "+" : ""}{formatCredits(item.delta)}
      </span>
      <span className="kc-activity-ledger-copy">
        <strong>{item.reasonLabel}</strong>
        {spec ? <small className="kc-activity-ledger-spec">{spec}</small> : null}
        <small>{formatTime(item.createdAt)}{item.refId ? ` · ${item.refId.slice(0, 8)}` : ""}</small>
      </span>
      <span className="kc-activity-ledger-balance">余 {formatCredits(item.balanceAfter)}</span>
      {job && onOpenJob ? (
        <button type="button" className="kc-activity-ledger-link" onClick={onOpenJob} title="在任务日志中查看这笔扣费对应的任务">
          查看任务
        </button>
      ) : null}
    </article>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="kc-activity-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch { /* clipboard unavailable */ }
      }}
      aria-label="复制请求体"
    >
      <Copy aria-hidden="true" />
      <span>{copied ? "已复制" : "复制"}</span>
    </button>
  );
}

function countReferences(job: PublicGenerationJob) {
  const inputs = job.inputs;
  if (!inputs) return 0;
  return (inputs.images?.length ?? 0) + (inputs.styleImages?.length ?? 0) + (inputs.elementImages?.length ?? 0) + (inputs.videos?.length ?? 0) + (inputs.audios?.length ?? 0);
}

function hasReferenceIntent(job: PublicGenerationJob) {
  const parameters = job.parameters ?? {};
  const prompt = typeof parameters.prompt === "string" ? parameters.prompt : "";
  return /参考|素材|这张图|这张图|reference/i.test(prompt);
}

function jobStatusLabel(job: PublicGenerationJob): { tone: "ok" | "warn" | "err" | "run"; text: string; badge: string } {
  switch (job.status) {
    case "completed": return { tone: "ok", text: "已完成", badge: "成功" };
    case "failed": return { tone: "err", text: "已失败", badge: "失败" };
    case "submission_unknown": return { tone: "warn", text: "提交状态未知", badge: "待确认" };
    case "queued": return { tone: "run", text: "排队中", badge: "排队" };
    default: return { tone: "run", text: `进行中 ${job.progress}%`, badge: `${job.progress}%` };
  }
}

function formatCredits(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatTime(value: string) {
  const date = new Date(value);
  const now = Date.now();
  const elapsed = now - date.getTime();
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
