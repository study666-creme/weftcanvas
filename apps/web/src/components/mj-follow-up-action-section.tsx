import type { ModelParameter, PublicModel } from "@kachang/contracts";
import { MousePointerClick } from "lucide-react";
import { useEffect, useRef } from "react";

import {
  MJ_ACTION_OPTIONS,
  type MjActionMeta,
} from "../lib/generation-parameter-hints";
import { GenerationParameterField, generationParameterOptionLabel } from "./generation-parameter-field";
import { CanvasSelect } from "./canvas-select";

const UNSET = "__unset__";

/**
 * Midjourney「后续动作」分组。
 *
 * action/task_id/index/custom_id/direction/zoom_ratio/dimensions 是对**已完成
 * 任务**的二次操作（放大/变体/扩图/平移/融图……），单独计费，与直接生成互斥；
 * 此前它们和生成参数平铺在一张表单里，还会被默认预选成 upscale/left/SQUARE
 * 一起提交。这里改成显式分组：
 *  - 默认「不使用（直接生成）」，全部配套字段隐藏；
 *  - 选中动作后只出现该动作需要的字段，并给出该动作的说明；
 *  - 缺父任务 ID / 参考图片不够时给出内联报错并阻断提交（invalidParameters）。
 */
export function FollowUpActionSection({
  model,
  actionParameter,
  dependentParameters,
  values,
  disabled,
  referenceImageCount,
  onChange,
  onValidityChange,
}: {
  model: PublicModel;
  actionParameter: ModelParameter;
  dependentParameters: ModelParameter[];
  values: Record<string, unknown>;
  disabled: boolean;
  /** 已连接的参考图片数（blend/describe 需要图片素材）。 */
  referenceImageCount: number;
  onChange: (name: string, value: unknown) => void;
  onValidityChange: (name: string, valid: boolean) => void;
}) {
  const selectedAction = typeof values[actionParameter.name] === "string" ? values[actionParameter.name] as string : undefined;
  const meta = selectedAction ? MJ_ACTION_OPTIONS[selectedAction] ?? null : null;
  const missingTaskId = Boolean(meta?.needsTaskId) && !String(values.task_id ?? "").trim();
  const missingImages = Boolean(meta && referenceImageCount < meta.needsImages);
  const valid = !meta || (!missingTaskId && !missingImages);

  // onValidityChange 每次渲染都是新引用，用 ref 固定，避免 effect 循环。
  const reportValidity = useRef(onValidityChange);
  reportValidity.current = onValidityChange;
  useEffect(() => {
    reportValidity.current(actionParameter.name, valid);
  }, [actionParameter.name, valid]);

  // 切换/取消动作时清掉不再需要的配套参数，避免「生成 + 残留 task_id」这类
  // 拼凑组合被一起提交。
  const changeAction = (next: string | undefined) => {
    const nextMeta = next ? MJ_ACTION_OPTIONS[next] ?? null : null;
    for (const parameter of dependentParameters) {
      const keep = nextMeta ? nextMeta.fields.includes(parameter.name) : false;
      if (!keep && values[parameter.name] !== undefined) onChange(parameter.name, undefined);
    }
    onChange(actionParameter.name, next);
  };

  const visibleDependents = meta
    ? dependentParameters.filter((parameter) => meta.fields.includes(parameter.name))
    : [];
  const customIdFilled = String(values.custom_id ?? "").trim().length > 0;

  return (
    <section className="kc-generation-action-group" aria-label="后续操作">
      <header className="kc-generation-action-header">
        <MousePointerClick aria-hidden="true" />
        <div>
          <strong>后续操作（对已完成的任务）</strong>
          <small>放大、变体、扩图、融图等是单独计费的二次操作；直接生成新图时保持「不使用」</small>
        </div>
      </header>
      <div className="kc-generation-field">
        <span title="选择要对上一次任务执行的操作">{actionParameter.label}</span>
        <CanvasSelect
          value={selectedAction === undefined ? UNSET : JSON.stringify(selectedAction)}
          options={[
            { value: UNSET, label: "不使用（直接生成）" },
            ...(actionParameter.options ?? []).map((option) => ({
              value: JSON.stringify(option),
              label: generationParameterOptionLabel(actionParameter, option),
            })),
          ]}
          disabled={disabled}
          ariaLabel={actionParameter.label}
          onChange={(next) => changeAction(next === UNSET ? undefined : JSON.parse(next))}
        />
      </div>
      {meta ? (
        <p className="kc-generation-action-hint">
          {meta.hint}
          {customIdFilled ? "（已填按钮 ID：以其为准）" : ""}
        </p>
      ) : null}
      {missingTaskId ? (
        <p className="kc-generation-action-error" role="alert">还差「父任务 ID」：在最近任务里复制上一次生成任务的 ID。</p>
      ) : null}
      {missingImages ? (
        <p className="kc-generation-action-error" role="alert">
          还差参考图片：需要先连接 {meta!.needsImages - referenceImageCount} 张图片素材（当前 {referenceImageCount} 张）。
        </p>
      ) : null}
      {visibleDependents.length ? (
        <div className="kc-generation-action-fields">
          {visibleDependents.map((parameter) => (
            <GenerationParameterField
              key={`${model.id}:${parameter.name}`}
              parameter={parameter}
              value={values[parameter.name]}
              disabled={disabled}
              showHint
              onChange={(value) => onChange(parameter.name, value)}
              onValidityChange={(fieldValid) => onValidityChange(parameter.name, fieldValid)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** 保留导出：动作元数据在别处（提示文案）也会用到。 */
export type { MjActionMeta };
