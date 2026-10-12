import type { GenerationJobStatus } from "@weftcanvas/contracts";
import type { CSSProperties } from "react";

import type { GenerationEffectStyle } from "../state/ui-preferences-store";

type NodeLoadingActivity = "generation" | "loading";
type ActiveGenerationStage =
  "submitting" | "submission_unknown" | "queued" | "running" | "validating";

type NodeLoadingStateProps = {
  variant?: "image" | "video" | "default";
  activity?: NodeLoadingActivity;
  status?: GenerationJobStatus | null;
  progress?: number;
  label?: string;
  /** Read-only stalled marker for a running job that stopped advancing. */
  stalled?: boolean;
  /** The observation budget was exhausted; status cannot be refreshed now. */
  observationExhausted?: boolean;
  /** The selected generation effect drives which motion language renders. */
  generationEffectStyle?: GenerationEffectStyle;
};

function activeGenerationStage(
  status: GenerationJobStatus | null | undefined,
): ActiveGenerationStage {
  if (status === "reserved" || status === "submitting") return "submitting";
  if (status === "submission_unknown") return "submission_unknown";
  if (status === "queued") return "queued";
  if (status === "validating") return "validating";
  return "running";
}

function generationLabel(stage: ActiveGenerationStage, variant: NodeLoadingStateProps["variant"]) {
  const subject = variant === "video" ? "视频" : variant === "image" ? "图片" : "生成";
  if (stage === "submitting")
    return variant === "default" ? "正在准备并提交任务" : `正在准备素材并提交${subject}`;
  if (stage === "submission_unknown") return "正在确认任务提交";
  if (stage === "queued") return variant === "default" ? "任务排队中" : `${subject}任务排队中`;
  if (stage === "validating")
    return variant === "video"
      ? "正在整理成片"
      : variant === "image"
        ? "正在校验图片"
        : "正在校验结果";
  return variant === "default" ? "生成中" : `正在生成${subject}`;
}

export function NodeLoadingState({
  variant = "default",
  activity = "generation",
  status,
  progress,
  label,
  stalled = false,
  observationExhausted = false,
  generationEffectStyle = "beam",
}: NodeLoadingStateProps) {
  const value =
    typeof progress === "number" && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Math.round(progress)))
      : null;
  const generationStage = activeGenerationStage(status);
  const stage =
    label ||
    (activity === "loading"
      ? "加载中"
      : observationExhausted
        ? "暂时无法更新"
        : stalled
          ? "生成长时间未推进"
          : generationLabel(generationStage, variant));
  const pendingConfirmation = activity === "generation" && generationStage === "submission_unknown";
  const mediaGeneration = activity === "generation" && (variant === "image" || variant === "video");
  const quietGeneration =
    mediaGeneration && generationEffectStyle === "quiet" && !stalled && !observationExhausted;
  const cinematicGeneration =
    mediaGeneration && generationEffectStyle !== "quiet" && !stalled && !observationExhausted;
  const indeterminate =
    pendingConfirmation || value === null || (activity === "generation" && value === 0);
  const valueLabel = observationExhausted
    ? "请稍后重试"
    : pendingConfirmation
      ? "待确认"
      : value === null
        ? activity === "loading"
          ? "载入中"
          : "准备中"
        : `${value}%`;
  const progressScale = (value ?? 36) / 100;
  // Progress controls timing information only. Keeping the material exposure
  // stable avoids a false "result is slowly appearing" phase near completion.
  const cinematicFieldOpacity = 0.68;
  const cinematicSweepOpacity = 0.86;
  const cinematicGlintOpacity = 0.72;

  return (
    <div
      className={`wc-node-loading wc-node-loading--${variant} wc-node-loading--activity-${activity} ${quietGeneration ? "wc-node-loading--quiet" : ""} ${cinematicGeneration ? "wc-node-loading--cinematic" : ""} ${stalled ? "wc-node-loading--stalled" : ""} ${observationExhausted ? "wc-node-loading--observation-exhausted" : ""}`}
      style={
        {
          "--wc-generation-progress": `${value ?? 36}%`,
          "--wc-generation-progress-scale": progressScale,
          "--wc-video-generation-field-opacity": cinematicGeneration
            ? cinematicFieldOpacity
            : undefined,
          "--wc-video-generation-sweep-opacity": cinematicGeneration
            ? cinematicSweepOpacity
            : undefined,
          "--wc-video-generation-glint-opacity": cinematicGeneration
            ? cinematicGlintOpacity
            : undefined,
        } as CSSProperties
      }
      role="status"
      aria-label={
        observationExhausted
          ? "暂时无法更新，请稍后重试"
          : cinematicGeneration
            ? pendingConfirmation || value === null
              ? stage
              : `${stage} ${value}%`
            : pendingConfirmation
              ? `${stage}，${valueLabel}`
              : value === null
                ? stage
                : `${stage} ${value}%`
      }
      aria-atomic="true"
      data-loading-activity={activity}
      data-generation-stage={activity === "generation" ? generationStage : undefined}
      data-generation-effect={generationEffectStyle}
      data-stalled={stalled ? "true" : undefined}
      data-observation-exhausted={observationExhausted ? "true" : undefined}
    >
      {cinematicGeneration ? (
        <>
          <div className="wc-video-generation-scene" aria-hidden="true">
            <span className="wc-video-generation-field" />
            <span className="wc-video-generation-sweep" />
            <span className="wc-video-generation-glint" />
            <span className="wc-video-generation-scan" />
          </div>
          <span
            className={`wc-video-generation-rail ${indeterminate ? "is-indeterminate" : ""}`}
            aria-hidden="true"
          >
            <span />
          </span>
        </>
      ) : quietGeneration ? (
        <>
          <div className="wc-quiet-generation-scene" aria-hidden="true">
            <span className="wc-quiet-generation-sweep" />
          </div>
          <div className="wc-node-loading-content">
            <span className="wc-quiet-ring" aria-hidden="true" />
            <span className="wc-node-loading-copy">
              <span key={stage} className="wc-node-loading-label">
                {stage}
              </span>
              <span className="wc-node-loading-value">{valueLabel}</span>
            </span>
            <span
              className={`wc-node-loading-track ${indeterminate ? "is-indeterminate" : ""}`}
              aria-hidden="true"
            >
              <span />
            </span>
          </div>
        </>
      ) : activity === "generation" && !observationExhausted ? (
        <div className="wc-node-loading-beam" aria-hidden="true" />
      ) : null}
      {!cinematicGeneration && !quietGeneration ? (
        <div className="wc-node-loading-content">
          {!observationExhausted ? (
            <span className="wc-node-loading-spinner" aria-hidden="true" />
          ) : null}
          <span className="wc-node-loading-copy">
            <span key={stage} className="wc-node-loading-label">
              {stage}
            </span>
            <span className="wc-node-loading-value">{valueLabel}</span>
          </span>
          {!observationExhausted ? (
            <span
              className={`wc-node-loading-track ${indeterminate ? "is-indeterminate" : ""}`}
              aria-hidden="true"
            >
              <span />
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
