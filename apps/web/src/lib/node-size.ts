export type DefaultNodeSize = "small" | "standard" | "large";
export type DefaultNodeAspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

export const defaultNodeAspectRatios: readonly DefaultNodeAspectRatio[] = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
];

const nodeSizeScales: Record<DefaultNodeSize, number> = {
  small: 0.8,
  standard: 1,
  large: 1.2,
};

export const mediaAspectRatioParameterNames = [
  "aspect_ratio",
  "aspectRatio",
  "ratio",
  "size",
] as const;

export type MediaAspectRatioParameterName = (typeof mediaAspectRatioParameterNames)[number];

export function nodeSizeScale(size: DefaultNodeSize) {
  return nodeSizeScales[size];
}

export function scaleNodeDimensions(
  dimensions: { width: number; height: number },
  size: DefaultNodeSize | number,
) {
  const scale = typeof size === "number" ? size : nodeSizeScale(size);
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

export function parseMediaAspectRatio(value: unknown): number | null {
  if (typeof value === "number") return validAspectRatio(value);
  if (value && typeof value === "object") {
    const dimensions = value as { width?: unknown; height?: unknown };
    const width = Number(dimensions.width);
    const height = Number(dimensions.height);
    if (Number.isFinite(width) && Number.isFinite(height)) return validAspectRatio(width / height);
  }
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized || normalized === "auto" || normalized === "original") return null;
  if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return validAspectRatio(Number(normalized));

  const parts = normalized.match(/^(\d+(?:\.\d*)?|\.\d+)(?::|\/|x|\u00d7)(\d+(?:\.\d*)?|\.\d+)$/);
  if (!parts) return null;
  return validAspectRatio(Number(parts[1]) / Number(parts[2]));
}

export function isMediaAspectRatioParameterName(
  value: string,
): value is MediaAspectRatioParameterName {
  return mediaAspectRatioParameterNames.includes(value as MediaAspectRatioParameterName);
}

export function generationParametersAspectRatio(
  parameters: Record<string, unknown>,
  preferredParameter?: string,
): number | null {
  const names =
    preferredParameter && isMediaAspectRatioParameterName(preferredParameter)
      ? [
          preferredParameter,
          ...mediaAspectRatioParameterNames.filter((name) => name !== preferredParameter),
        ]
      : mediaAspectRatioParameterNames;
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(parameters, name)) continue;
    const value = parameters[name];
    if (isOriginalAspectRatio(value)) return null;
    if (name === "size" && isBareNumericSize(value)) continue;
    const ratio = parseMediaAspectRatio(value);
    if (ratio !== null) return ratio;
  }
  return null;
}

function isBareNumericSize(value: unknown) {
  return (
    typeof value === "number" ||
    (typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))
  );
}

function isOriginalAspectRatio(value: unknown) {
  return typeof value === "string" && value.trim().toLowerCase() === "original";
}

function validAspectRatio(value: number) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isDefaultNodeAspectRatio(value: unknown): value is DefaultNodeAspectRatio {
  return (
    typeof value === "string" && defaultNodeAspectRatios.includes(value as DefaultNodeAspectRatio)
  );
}

export function nodeAspectRatioValue(value: DefaultNodeAspectRatio) {
  const [width, height] = value.split(":").map(Number);
  return width! / height!;
}
