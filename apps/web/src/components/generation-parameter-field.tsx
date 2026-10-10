import type { ModelParameter } from "@kachang/contracts";
import { useEffect, useRef, useState } from "react";

import { generationParameterHint, generationParameterOptionMetaLabel } from "../lib/generation-parameter-hints";
import { CanvasSelect } from "./canvas-select";

const BOUNDED_DURATION_PARAMETER_NAMES = new Set(["duration_seconds", "duration", "seconds"]);
// 视频/音频时长一律 4 秒起步；目录里未声明范围时也按 4 秒兜底。
const BOUNDED_DURATION_MIN = 4;
// Keep a defensive UI ceiling while allowing the catalog to publish current
// long-form video ranges such as 4-30 seconds.
const BOUNDED_DURATION_MAX = 60;
const QUALITY_OPTION_LABELS: Readonly<Record<string, string>> = {
  low: "低",
  medium: "中",
  standard: "标准",
  high: "高",
  xhigh: "超高",
  max: "最高",
};
// 长文本参数（负向提示词、各类参考图 URL）在弹层里必须是多行输入框：
// 单行 input 既装不下也看不出全貌，用户会以为输入框不存在。
const MULTILINE_TEXT_PARAMETER_NAME_PATTERN = /(?:^|_)(?:negative_?prompt|prompt|description|instruction|url|uri|link)(?:$|_)|(?:url|uri|link)$/iu;
const MULTILINE_TEXT_PARAMETER_LABEL_PATTERN = /负向提示词|提示词|描述|说明|参考图\s*URL|URL|链接/iu;

export function GenerationParameterField({
  parameter,
  value,
  disabled,
  boundedDuration = false,
  showHint = false,
  onChange,
  onValidityChange,
  menuClassName = "",
}: {
  parameter: ModelParameter;
  value: unknown;
  disabled: boolean;
  boundedDuration?: boolean;
  /** 宽松布局（更多参数弹层/生成对话框）下在字段下方展示一句参数说明。 */
  showHint?: boolean;
  onChange: (value: unknown) => void;
  onValidityChange: (valid: boolean) => void;
  menuClassName?: string;
}) {
  const resolvedValue = generationParameterDisplayValue(parameter, value);
  const fieldDisabled = disabled || isGenerationParameterLocked(parameter);
  const hint = showHint ? generationParameterHint(parameter) : null;
  const durationValues = boundedDuration ? boundedDurationOptions(parameter) : null;
  if (durationValues) {
    const selected = normalizeBoundedDurationValue(parameter, resolvedValue);
    const hasSelected = selected !== undefined;
    return (
      <div className="kc-generation-field">
        <FieldLabel parameter={parameter} />
        <CanvasSelect
          value={hasSelected ? JSON.stringify(selected) : "__unset__"}
          options={[
            ...(!hasSelected ? [{ value: "__unset__", label: "请选择" }] : []),
            ...durationValues.map((option) => ({ value: JSON.stringify(option), label: `${option} 秒` })),
          ]}
          disabled={fieldDisabled || durationValues.length === 0}
          ariaLabel={parameter.label}
          menuClassName={menuClassName}
          onChange={(next) => onChange(next === "__unset__" ? undefined : JSON.parse(next))}
        />
        {hint ? <small className="kc-generation-field-hint">{hint}</small> : null}
      </div>
    );
  }
  const scalarOptions = generationParameterScalarOptions(parameter, resolvedValue);
  if (scalarOptions) {
    const selected = resolvedValue;
    return (
      <div className="kc-generation-field">
        <FieldLabel parameter={parameter} />
        <CanvasSelect
          value={selected === undefined ? "__unset__" : JSON.stringify(selected)}
          options={[
            ...(selected === undefined ? [{ value: "__unset__", label: "请选择" }] : []),
            ...scalarOptions.map((option) => ({
              value: JSON.stringify(option),
              label: generationParameterOptionLabel(parameter, option),
            })),
          ]}
          disabled={fieldDisabled}
          ariaLabel={parameter.label}
          menuClassName={menuClassName}
          onChange={(next) => onChange(next === "__unset__" ? undefined : JSON.parse(next))}
        />
        {hint ? <small className="kc-generation-field-hint">{hint}</small> : null}
      </div>
    );
  }
  if (parameter.type === "boolean") {
    return (
      <label className="kc-generation-toggle">
        <span>{parameter.label}</span>
        <input type="checkbox" checked={Boolean(resolvedValue)} disabled={fieldDisabled} onChange={(event) => onChange(event.target.checked)} />
        <i aria-hidden="true" />
      </label>
    );
  }
  if (parameter.type === "integer" || parameter.type === "number") {
    return (
      <label className="kc-generation-field">
        <FieldLabel parameter={parameter} />
        <input
          type="number"
          value={typeof resolvedValue === "number" ? resolvedValue : ""}
          min={parameter.min}
          max={parameter.max}
          step={parameter.step ?? (parameter.type === "integer" ? 1 : "any")}
          required={parameter.required}
          disabled={fieldDisabled}
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        />
        {hint ? <small className="kc-generation-field-hint">{hint}</small> : null}
      </label>
    );
  }
  if (parameter.type === "array" || parameter.type === "object") {
    return <JsonParameterField parameter={parameter} value={resolvedValue} disabled={fieldDisabled} onChange={onChange} onValidityChange={onValidityChange} />;
  }
  if (isMultilineTextParameter(parameter)) {
    return (
      <label className="kc-generation-field kc-generation-textarea">
        <FieldLabel parameter={parameter} />
        <textarea
          rows={multilineTextRows(parameter)}
          value={generationParameterTextInputValue(parameter, resolvedValue)}
          minLength={parameter.minLength}
          maxLength={parameter.maxLength}
          required={parameter.required}
          disabled={fieldDisabled}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
        {hint ? <small className="kc-generation-field-hint">{hint}</small> : null}
      </label>
    );
  }
  return (
    <label className="kc-generation-field">
      <FieldLabel parameter={parameter} />
      <input
        type="text"
        value={generationParameterTextInputValue(parameter, resolvedValue)}
        minLength={parameter.minLength}
        maxLength={parameter.maxLength}
        required={parameter.required}
        disabled={fieldDisabled}
        onChange={(event) => onChange(event.target.value || undefined)}
      />
      {hint ? <small className="kc-generation-field-hint">{hint}</small> : null}
    </label>
  );
}

/**
 * 字段标签：目录参数只有「角色权重」这类冷名称，宽布局下补一句站内解释
 * （title 悬停兜底 + 小字说明由 showHint 控制）。
 */
function FieldLabel({ parameter }: { parameter: ModelParameter }) {
  const hint = generationParameterHint(parameter);
  return (
    <span title={hint ?? undefined}>{parameter.label}</span>
  );
}

export function isGenerationParameterLocked(parameter: ModelParameter) {
  return parameter.fixed !== undefined || parameter.options?.length === 1;
}

/**
 * 目录里的长文本参数（负向提示词、角色/风格/深度参考图 URL）用多行文本域呈现。
 * 只对自由文本生效：带选项的字段仍走下拉，锁定字段仍只读展示。
 */
export function isMultilineTextParameter(parameter: ModelParameter) {
  if (parameter.type !== "string") return false;
  if (parameter.options?.length) return false;
  if (isGenerationParameterLocked(parameter)) return false;
  if (MULTILINE_TEXT_PARAMETER_NAME_PATTERN.test(parameter.name.trim())) return true;
  return MULTILINE_TEXT_PARAMETER_LABEL_PATTERN.test(parameter.label ?? "");
}

function multilineTextRows(parameter: ModelParameter) {
  return parameter.maxLength !== undefined && parameter.maxLength <= 120 ? 2 : 3;
}

export function generationParameterDisplayValue(parameter: ModelParameter, configured: unknown) {
  if (parameter.fixed !== undefined) return parameter.fixed;
  if (configured !== undefined && (!parameter.options?.length || parameter.options.some((option) => Object.is(option, configured)))) {
    return configured;
  }
  if (parameter.default !== undefined && (!parameter.options?.length || parameter.options.some((option) => Object.is(option, parameter.default)))) {
    return parameter.default;
  }
  return parameter.options?.[0];
}

export function generationParameterScalarOptions(
  parameter: ModelParameter,
  selected: unknown,
): Array<string | number | boolean> | null {
  const declared: Array<string | number | boolean> | null = parameter.options?.length
    ? parameter.options
    : parameter.fixed !== undefined && (parameter.type === "string" || parameter.type === "integer" || parameter.type === "number")
      ? [parameter.fixed as string | number]
      : null;
  if (!declared) return null;
  return selected !== undefined && !declared.some((option) => Object.is(option, selected))
    ? [selected as string | number | boolean, ...declared]
    : declared;
}

/**
 * Returns the legal second values for video and audio duration parameters, or
 * null for unrelated parameters. Keeping this as a pure helper makes the
 * model-bound range easy to verify without mounting the portal-backed select.
 */
export type BoundedDurationOption = string | number;

export function generationParameterOptionLabel(parameter: ModelParameter, option: string | number | boolean) {
  if (typeof option === "string") {
    const metaLabel = generationParameterOptionMetaLabel(parameter, option);
    if (metaLabel) return metaLabel;
    const ratio = pixelSizeToRatio(option);
    if (ratio) return ratio;
  }
  if (parameter.name.trim().toLowerCase() !== "quality" || typeof option !== "string") return String(option);
  return QUALITY_OPTION_LABELS[option.trim().toLowerCase()] ?? option;
}

/**
 * Present a raw WxH pixel option as an aspect ratio (1024x1024 → 1:1). The
 * stored/submitted value stays the original pixel string; this is display-only.
 */
const RATIO_NAMES: Record<number, string> = {
  [1]: "1:1",
  [16 / 9]: "16:9",
  [9 / 16]: "9:16",
  [4 / 3]: "4:3",
  [3 / 4]: "3:4",
  [3 / 2]: "3:2",
  [2 / 3]: "2:3",
  [21 / 9]: "21:9",
  [5 / 4]: "5:4",
  [4 / 5]: "4:5",
};

export function pixelSizeToRatio(value: string): string | null {
  const match = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  const ratio = width / height;
  for (const [known, label] of Object.entries(RATIO_NAMES)) {
    if (Math.abs(ratio - Number(known)) < 0.01) return label;
  }
  // Fall back to a reduced fraction for non-standard sizes (e.g. 3360x1440 → 21:9).
  const gcd = greatestCommonDivisor(width, height);
  const w = width / gcd;
  const h = height / gcd;
  return w <= 99 && h <= 99 ? `${w}:${h}` : null;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export function generationParameterTextInputValue(parameter: ModelParameter, value: unknown) {
  if (typeof value !== "string") return "";
  return isGenerationParameterLocked(parameter)
    ? generationParameterOptionLabel(parameter, value)
    : value;
}

export function boundedDurationOptions(parameter: ModelParameter): BoundedDurationOption[] | null {
  if (!BOUNDED_DURATION_PARAMETER_NAMES.has(parameter.name.toLowerCase())) return null;

  const lowerBound = Math.max(BOUNDED_DURATION_MIN, parameter.min ?? BOUNDED_DURATION_MIN);
  const upperBound = Math.min(BOUNDED_DURATION_MAX, parameter.max ?? BOUNDED_DURATION_MAX);
  const min = parameter.type === "integer" ? Math.ceil(lowerBound) : lowerBound;
  const max = parameter.type === "integer" ? Math.floor(upperBound) : upperBound;
  if (parameter.options?.length) {
    const values: BoundedDurationOption[] = [];
    const seen = new Set<string>();
    for (const option of parameter.options) {
      const seconds = durationOptionSeconds(option);
      if (seconds === null || seconds < min || seconds > max) continue;
      if (typeof option !== "number" && typeof option !== "string") continue;
      const key = JSON.stringify(option);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(option);
    }
    return values;
  }
  if (max < min) return [];

  const step = parameter.step && parameter.step > 0 ? parameter.step : 1;
  const values: number[] = [];
  for (let value = min; value <= max + Number.EPSILON; value += step) {
    const normalized = Number(value.toFixed(10));
    if (normalized < min || normalized > max) continue;
    const duration = parameter.type === "integer" ? Math.round(normalized) : normalized;
    values.push(duration);
  }
  const unique = [...new Set(values)];
  return parameter.type === "string" ? unique.map(String) : unique;
}

export function normalizeBoundedDurationValue(parameter: ModelParameter, value: unknown) {
  const options = boundedDurationOptions(parameter);
  if (options === null) return value;
  if (!options.length) return undefined;
  return options.some((option) => Object.is(option, value)) ? value : options[0];
}

function durationOptionSeconds(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function JsonParameterField({
  parameter,
  value,
  disabled,
  onChange,
  onValidityChange,
}: {
  parameter: ModelParameter;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [text, setText] = useState(() => value === undefined ? "" : JSON.stringify(value, null, 2));
  const emittedValue = useRef(value);
  useEffect(() => {
    if (JSON.stringify(value) === JSON.stringify(emittedValue.current)) return;
    emittedValue.current = value;
    setText(value === undefined ? "" : JSON.stringify(value, null, 2));
  }, [value]);
  return (
    <label className="kc-generation-field kc-generation-json">
      <span>{parameter.label}</span>
      <textarea
        rows={3}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (!next.trim() && !parameter.required) {
            onValidityChange(true);
            emittedValue.current = undefined;
            onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(next);
            const validType = parameter.type === "array" ? Array.isArray(parsed) : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
            onValidityChange(validType);
            if (validType) {
              emittedValue.current = parsed;
              onChange(parsed);
            }
          } catch {
            onValidityChange(false);
          }
        }}
      />
    </label>
  );
}
