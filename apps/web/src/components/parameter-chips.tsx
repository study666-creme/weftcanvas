import type { ModelParameter } from "@weftcanvas/contracts";

import {
  generationParameterDisplayValue,
  generationParameterOptionLabel,
  generationParameterScalarOptions,
  isGenerationParameterLocked,
} from "./generation-parameter-field";

/**
 * 芯片组只适合「一眼能比完、标签很短」的枚举（比例、分辨率、质量、张数）。
 *
 * 用户口径（2026-10-27）：能直接铺开的参数不要收进下拉框——画面比例这种 16 档
 * 短标签枚举平铺两行也比下拉框好点、好读。所以上限放宽到 20 档，同时要求每个
 * 标签都短（≤ 12 字，足够 "transparent" / "landscape" 这类单词）：30 个预置
 * 音色这类长清单仍然回落成下拉，否则参数区会被一行几十个按钮撑成好几屏。
 */
export const INLINE_CHIP_OPTION_LIMIT = 20;

/** 标签超过这个长度就不再平铺：芯片会变成一行一句，读起来比下拉更糟。 */
const INLINE_CHIP_LABEL_LIMIT = 12;

/** 调用方用它决定走芯片组还是走 GenerationParameterField 的下拉。 */
export function supportsInlineOptionChips(parameter: ModelParameter, value: unknown) {
  const options = generationParameterScalarOptions(
    parameter,
    generationParameterDisplayValue(parameter, value),
  );
  if (!options || options.length === 0 || options.length > INLINE_CHIP_OPTION_LIMIT) return false;
  return options.every(
    (option) =>
      String(generationParameterOptionLabel(parameter, option)).length <= INLINE_CHIP_LABEL_LIMIT,
  );
}

/**
 * Renders an optioned generation parameter as an inline chip group instead of a
 * dropdown, so aspect ratio / resolution / quality / count are all laid out at a
 * glance. Falls back to null for parameters that have no scalar options (those
 * still need a text/number field, rendered by the caller).
 */
export function ParameterChips({
  parameter,
  value,
  disabled,
  onChange,
}: {
  parameter: ModelParameter;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const resolvedValue = generationParameterDisplayValue(parameter, value);
  const options = generationParameterScalarOptions(parameter, resolvedValue);
  if (!options || options.length === 0) return null;

  const locked = disabled || isGenerationParameterLocked(parameter);
  const selected = resolvedValue;

  return (
    <div
      className="wc-param-chips"
      role="group"
      aria-label={parameter.label}
      // 超过一行的芯片组在参数网格里独占整行：16 档比例挤在半栏里会排成五六行。
      data-wide={options.length > 6 ? "" : undefined}
    >
      <span className="wc-param-chips-label">{parameter.label}</span>
      <div className="wc-param-chips-row">
        {options.map((option) => {
          const active = selected !== undefined && Object.is(selected, option);
          return (
            <button
              key={JSON.stringify(option)}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={locked}
              className={active ? "is-active" : undefined}
              onClick={() => onChange(option)}
            >
              {generationParameterOptionLabel(parameter, option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
