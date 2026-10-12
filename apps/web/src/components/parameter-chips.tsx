import type { ModelParameter } from "@weftcanvas/contracts";

import {
  generationParameterDisplayValue,
  generationParameterOptionLabel,
  generationParameterScalarOptions,
  isGenerationParameterLocked,
} from "./generation-parameter-field";

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
    <div className="wc-param-chips" role="group" aria-label={parameter.label}>
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
