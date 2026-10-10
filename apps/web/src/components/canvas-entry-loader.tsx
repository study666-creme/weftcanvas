import { LoaderCircle, Network } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  CANVAS_BOOT_MIN_VISIBLE_MS,
  getCanvasBootSnapshot,
  type CanvasBootCatalogStatus,
  type CanvasBootIdentityStatus,
} from "../lib/canvas-boot";

const stageCopy = {
  workspace: "构建画布视图",
  identity: "恢复创作现场",
  catalog: "连接生成能力",
  finalizing: "整理项目节点",
} as const;

export function CanvasEntryLoader({
  projectName,
  workspaceReady,
  identityStatus,
  catalogStatuses,
  onFinished,
}: {
  projectName?: string;
  workspaceReady?: boolean;
  identityStatus?: CanvasBootIdentityStatus;
  catalogStatuses?: readonly CanvasBootCatalogStatus[];
  onFinished?: () => void;
}) {
  const resolvedProjectName = projectName ?? "";
  const resolvedWorkspaceReady = workspaceReady ?? false;
  const resolvedIdentityStatus: CanvasBootIdentityStatus = identityStatus ?? "loading";
  const resolvedCatalogStatuses: readonly CanvasBootCatalogStatus[] = catalogStatuses ?? [];
  const resolvedOnFinished = onFinished ?? (() => undefined);
  const startedAtRef = useRef(Date.now());
  const highestTargetRef = useRef(8);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [displayProgress, setDisplayProgress] = useState(8);
  const [leaving, setLeaving] = useState(false);
  const snapshot = getCanvasBootSnapshot({ workspaceReady: resolvedWorkspaceReady, identityStatus: resolvedIdentityStatus, catalogStatuses: resolvedCatalogStatuses, elapsedMs });
  highestTargetRef.current = Math.max(highestTargetRef.current, snapshot.targetProgress);
  const exitReady = snapshot.canFinish && elapsedMs >= CANVAS_BOOT_MIN_VISIBLE_MS;
  const progressGoal = exitReady ? 100 : highestTargetRef.current;

  useEffect(() => {
    if (exitReady) return;
    const updateElapsed = () => setElapsedMs(Date.now() - startedAtRef.current);
    updateElapsed();
    const timerId = window.setInterval(updateElapsed, 40);
    return () => window.clearInterval(timerId);
  }, [exitReady]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setDisplayProgress((current) => {
        if (current >= progressGoal) {
          window.clearInterval(timerId);
          return current;
        }
        return Math.min(progressGoal, current + Math.max(1, Math.ceil((progressGoal - current) / 5)));
      });
    }, 32);
    return () => window.clearInterval(timerId);
  }, [progressGoal]);

  useEffect(() => {
    if (!exitReady) return;
    setDisplayProgress(100);
    const leaveTimerId = window.setTimeout(() => setLeaving(true), 180);
    const finishTimerId = window.setTimeout(resolvedOnFinished, 520);
    return () => {
      window.clearTimeout(leaveTimerId);
      window.clearTimeout(finishTimerId);
    };
  }, [exitReady, resolvedOnFinished]);

  const projectLabel = resolvedProjectName.trim() || "当前项目";
  const statusLabel = exitReady ? "画布已就绪" : stageCopy[snapshot.stage];
  const detailLabel = snapshot.timedOut
    ? "画布已可用，后台能力继续同步"
    : snapshot.catalogsReady
      ? "项目数据与创作能力已连接"
      : `${snapshot.settledCatalogCount}/${resolvedCatalogStatuses.length} 项创作能力已连接`;

  return (
    <section
      className={`kc-canvas-entry-loader ${leaving ? "is-leaving" : ""}`}
      aria-label="正在进入画布"
      aria-busy={!exitReady}
      data-stage={snapshot.stage}
    >
      <div className="kc-canvas-entry-loader-grid" aria-hidden="true">
        <span className="kc-canvas-entry-loader-gridline is-horizontal" />
        <span className="kc-canvas-entry-loader-gridline is-vertical" />
        <span className="kc-canvas-entry-loader-node is-origin" />
        <span className="kc-canvas-entry-loader-node is-upper" />
        <span className="kc-canvas-entry-loader-node is-lower" />
        <span className="kc-canvas-entry-loader-link is-upper" />
        <span className="kc-canvas-entry-loader-link is-lower" />
      </div>

      <header className="kc-canvas-entry-loader-brand">
        <span className="kc-canvas-entry-loader-mark"><img src="/kachang-logo-ui.webp" alt="" aria-hidden="true" /></span>
        <span><strong>卡藏画布</strong><small>Kachang Canvas</small></span>
      </header>

      <div className="kc-canvas-entry-loader-content">
        <span className="kc-canvas-entry-loader-eyebrow">工作区 / {projectLabel}</span>
        <div className="kc-canvas-entry-loader-title-row">
          <h1>正在打开画布</h1>
          <strong>{displayProgress}%</strong>
        </div>
        <div
          className="kc-canvas-entry-loader-progress"
          role="progressbar"
          aria-label="画布进入进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={displayProgress}
        >
          <i><span style={{ width: `${displayProgress}%` }} /></i>
        </div>
        <div className="kc-canvas-entry-loader-status" aria-live="polite">
          <span className="kc-canvas-entry-loader-status-icon">
            {exitReady ? <Network aria-hidden="true" /> : <LoaderCircle aria-hidden="true" className="is-spinning" />}
          </span>
          <span><strong>{statusLabel}</strong><small>{detailLabel}</small></span>
        </div>
      </div>

      <footer className="kc-canvas-entry-loader-meta">
        <span>本地项目已恢复</span>
        <span aria-hidden="true" />
        <span>准备进入工作区</span>
      </footer>
    </section>
  );
}
