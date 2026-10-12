/**
 * Browser-only face grid processing.
 *
 * The MediaPipe runtime is intentionally loaded on first use. The detector,
 * model, and wasm files stay on the Canvas origin; image pixels never leave
 * the browser. The rendering half is kept independent from MediaPipe so it is
 * also useful with a caller-supplied face box or a future detector.
 */

import {
  blazeFaceModelUrl,
  loadMediapipeVision,
  mediapipeAssetUrl,
  normalizeMediapipeBaseUrl,
  resolveMediapipeFileset,
} from "./mediapipe-assets";

export type FaceGridInput =
  Blob | HTMLImageElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export type FaceKeypoint = {
  x: number;
  y: number;
  label?: string;
  score?: number;
};

export type FaceBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FaceGridManualSelection = FaceBox;

export type FaceDetection = {
  box: FaceBox;
  confidence: number;
  keypoints: FaceKeypoint[];
  region: FaceRegion;
};

export type FacePadding = {
  x?: number;
  y?: number;
};

export type FaceRegion = FaceBox & {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  circleRadius: number;
  rotationRadians: number;
};

export type GridLine = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type FaceGridOptions = {
  /** Public paths can be overridden when the app is mounted below a prefix. */
  modelAssetUrl?: string;
  wasmBaseUrl?: string;
  minDetectionConfidence?: number;
  minSuppressionThreshold?: number;
  maxFaces?: number;
  /** Reuse a previous detection result and avoid a second inference pass. */
  detections?: FaceDetection[];
  /** User-drawn face boxes normalized to the source image: 0-1 x/y/width/height. */
  manualSelections?: FaceGridManualSelection[];
  facePadding?: number | FacePadding;
  circleScale?: number;
  gridSpacing?: number;
  gridLineWidth?: number;
  gridAngleDegrees?: number;
  gridColor?: string;
  chipGridColor?: string;
  holeGridColor?: string;
  chipBackground?: string;
  holeFill?: string;
  outputBackground?: string;
  recomposeGap?: number;
  recomposePadding?: number;
};

export type FaceGridArtifacts = {
  detections: FaceDetection[];
  /** Original image with a clipped grid over every detected face. */
  overlayBlob: Blob;
  /** One circular/elliptical face chip per detection. */
  faceChipBlobs: Blob[];
  /** Original image with the face circles filled by `holeFill`. */
  holeBlob: Blob;
  /** Face chips above the holed original, similar to the desktop utility. */
  recomposedBlob: Blob;
};

export type FaceGridDetectorOptions = Pick<
  FaceGridOptions,
  | "modelAssetUrl"
  | "wasmBaseUrl"
  | "minDetectionConfidence"
  | "minSuppressionThreshold"
  | "maxFaces"
  | "facePadding"
  | "circleScale"
>;

const DEFAULT_FACE_PADDING = { x: 0.1, y: 0.08 };
const DEFAULT_CIRCLE_SCALE = 1.08;
const DEFAULT_GRID_ANGLE = 45;
const DEFAULT_GRID_COLOR = "rgba(248, 250, 252, 0.86)";
const DEFAULT_CHIP_GRID_COLOR = "rgba(220, 38, 38, 0.82)";
const DEFAULT_HOLE_GRID_COLOR = "rgba(248, 250, 252, 0.86)";
const DEFAULT_CHIP_BACKGROUND = "#ffffff";
const DEFAULT_HOLE_FILL = "#ffffff";
const DEFAULT_OUTPUT_BACKGROUND = "#ffffff";
const DEFAULT_RECOMPOSE_GAP = 20;
const DEFAULT_RECOMPOSE_PADDING = 0;

type VisionDetection = {
  categories?: Array<{ score?: number }>;
  boundingBox?: {
    originX: number;
    originY: number;
    width: number;
    height: number;
  };
  keypoints?: Array<{
    x: number;
    y: number;
    label?: string;
    score?: number;
  }>;
};

type VisionDetector = {
  detect(image: unknown): { detections?: VisionDetection[] };
  close(): void;
};

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
};

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;
type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const detectorCache = new Map<string, Promise<VisionDetector>>();

/**
 * Detect faces using the local MediaPipe BlazeFace model. The dynamic import
 * keeps the roughly 140KB JS runtime out of the initial canvas chunk.
 */
export async function detectFaces(
  input: FaceGridInput,
  options: FaceGridDetectorOptions = {},
): Promise<FaceDetection[]> {
  const decoded = await decodeInput(input);
  try {
    return detectFacesFromSource(decoded, options);
  } finally {
    decoded.dispose();
  }
}

/**
 * Create all artifacts used by the face-grid workflow in one decode/inference
 * pass. A caller can provide `options.detections` when it already called
 * `detectFaces`; this is useful while scrubbing or changing only grid styling.
 */
export async function createFaceGridArtifacts(
  input: FaceGridInput,
  options: FaceGridOptions = {},
): Promise<FaceGridArtifacts> {
  const decoded = await decodeInput(input);
  try {
    const detections = options.detections
      ? normalizeProvidedDetections(options.detections, decoded.width, decoded.height, options)
      : options.manualSelections?.length
        ? normalizeManualSelections(
            options.manualSelections,
            decoded.width,
            decoded.height,
            options,
          )
        : await detectFacesFromSource(decoded, options);
    return renderArtifacts(decoded, detections, options);
  } finally {
    decoded.dispose();
  }
}

/** Release cached WASM detector instances, for tests and explicit memory cleanup. */
export async function disposeFaceGridDetector() {
  const pending = [...detectorCache.values()];
  detectorCache.clear();
  await Promise.all(
    pending.map(async (detectorPromise) => {
      try {
        (await detectorPromise).close();
      } catch {
        // A failed initialization has no instance to close.
      }
    }),
  );
}

/** Expand and clamp a detector box using ratios of its original dimensions. */
export function expandFaceBox(
  box: FaceBox,
  imageWidth: number,
  imageHeight: number,
  padding: number | FacePadding = DEFAULT_FACE_PADDING,
): FaceBox {
  const safeWidth = Math.max(0, finite(box.width));
  const safeHeight = Math.max(0, finite(box.height));
  const paddingX = typeof padding === "number" ? padding : (padding.x ?? DEFAULT_FACE_PADDING.x);
  const paddingY = typeof padding === "number" ? padding : (padding.y ?? DEFAULT_FACE_PADDING.y);
  const extraX = safeWidth * Math.max(0, finite(paddingX));
  const extraY = safeHeight * Math.max(0, finite(paddingY));
  const left = finite(box.x) - extraX;
  const top = finite(box.y) - extraY;
  const right = finite(box.x) + safeWidth + extraX;
  const bottom = finite(box.y) + safeHeight + extraY;
  const width = Math.max(0, finite(imageWidth));
  const height = Math.max(0, finite(imageHeight));
  const x = clamp(left, 0, width);
  const y = clamp(top, 0, height);
  return {
    x,
    y,
    width: Math.max(0, Math.min(width, right) - x),
    height: Math.max(0, Math.min(height, bottom) - y),
  };
}

/** Build the ellipse and circular cutout geometry used by the renderer. */
export function buildFaceRegion(
  box: FaceBox,
  imageWidth: number,
  imageHeight: number,
  options: {
    facePadding?: number | FacePadding;
    circleScale?: number;
    rotationRadians?: number;
  } = {},
): FaceRegion {
  const expanded = expandFaceBox(
    box,
    imageWidth,
    imageHeight,
    options.facePadding ?? DEFAULT_FACE_PADDING,
  );
  const centerX = expanded.x + expanded.width / 2;
  const centerY = expanded.y + expanded.height / 2;
  const circleScale = Math.max(0.1, finite(options.circleScale ?? DEFAULT_CIRCLE_SCALE));
  const circleRadius = Math.max(expanded.width, expanded.height) * 0.5 * circleScale;
  return {
    ...expanded,
    centerX,
    centerY,
    radiusX: expanded.width / 2,
    radiusY: expanded.height / 2,
    circleRadius,
    rotationRadians: finite(options.rotationRadians ?? 0),
  };
}

/** Convert a user-drawn normalized box into the same shape as detector output. */
export function buildManualFaceDetection(
  selection: FaceGridManualSelection,
  imageWidth: number,
  imageHeight: number,
  options: { facePadding?: number | FacePadding; circleScale?: number } = {},
): FaceDetection | undefined {
  const imageW = Math.max(0, finite(imageWidth));
  const imageH = Math.max(0, finite(imageHeight));
  if (!imageW || !imageH) return undefined;
  const left = clamp(finite(selection.x), 0, 1);
  const top = clamp(finite(selection.y), 0, 1);
  const right = clamp(left + finite(selection.width), left, 1);
  const bottom = clamp(top + finite(selection.height), top, 1);
  const box = clampFaceBox(
    {
      x: left * imageW,
      y: top * imageH,
      width: (right - left) * imageW,
      height: (bottom - top) * imageH,
    },
    imageW,
    imageH,
  );
  if (box.width < 2 || box.height < 2) return undefined;
  const centerX = box.x + box.width / 2;
  const keypoints = [
    { x: box.x + box.width * 0.34, y: box.y + box.height * 0.42, label: "leftEye", score: 1 },
    { x: box.x + box.width * 0.66, y: box.y + box.height * 0.42, label: "rightEye", score: 1 },
    { x: centerX, y: box.y + box.height * 0.56, label: "noseTip", score: 1 },
    { x: centerX, y: box.y + box.height * 0.74, label: "mouthCenter", score: 1 },
  ];
  return {
    box,
    confidence: 1,
    keypoints,
    region: buildFaceRegion(box, imageW, imageH, {
      facePadding: options.facePadding,
      circleScale: options.circleScale,
      rotationRadians: 0,
    }),
  };
}

/**
 * Generate finite diagonal lines covering a rectangle. The canvas renderer
 * clips these lines to the face ellipse; returning the lines separately keeps
 * the geometry deterministic and straightforward to unit-test.
 */
export function buildGridLines(
  bounds: FaceBox,
  spacing: number,
  angleDegrees = DEFAULT_GRID_ANGLE,
): GridLine[] {
  const step = Math.max(1, finite(spacing));
  const angle = (finite(angleDegrees) * Math.PI) / 180;
  const tangent = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -tangent.y, y: tangent.x };
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
  const tangentValues = corners.map((point) => point.x * tangent.x + point.y * tangent.y);
  const normalValues = corners.map((point) => point.x * normal.x + point.y * normal.y);
  const tangentMin = Math.min(...tangentValues) - step * 2;
  const tangentMax = Math.max(...tangentValues) + step * 2;
  const normalMin = Math.min(...normalValues) - step * 2;
  const normalMax = Math.max(...normalValues) + step * 2;
  const lines: GridLine[] = [];
  for (let normalValue = normalMin; normalValue <= normalMax + step * 0.5; normalValue += step) {
    const start = {
      x: tangent.x * tangentMin + normal.x * normalValue,
      y: tangent.y * tangentMin + normal.y * normalValue,
    };
    const end = {
      x: tangent.x * tangentMax + normal.x * normalValue,
      y: tangent.y * tangentMax + normal.y * normalValue,
    };
    lines.push({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
  }
  return lines;
}

function detectFacesFromSource(
  source: DecodedImage,
  options: FaceGridDetectorOptions,
): Promise<FaceDetection[]> {
  return getDetector(options).then((detector) => {
    const result = detector.detect(source.source);
    const raw = result.detections ?? [];
    const detections = raw
      .map((detection) => toFaceDetection(detection, source.width, source.height, options))
      .filter((detection): detection is FaceDetection => detection !== undefined)
      .sort((left, right) => right.confidence - left.confidence);
    const maxFaces =
      options.maxFaces === undefined
        ? detections.length
        : Math.max(0, Math.floor(options.maxFaces));
    return detections.slice(0, maxFaces);
  });
}

function normalizeProvidedDetections(
  detections: FaceDetection[],
  imageWidth: number,
  imageHeight: number,
  options: FaceGridOptions,
) {
  return detections
    .map((detection) => {
      const box = clampFaceBox(detection.box, imageWidth, imageHeight);
      const keypoints = detection.keypoints.map((point) => ({ ...point }));
      const rotationRadians = detection.region?.rotationRadians ?? estimateRotation(keypoints);
      return {
        box,
        confidence: clamp(finite(detection.confidence), 0, 1),
        keypoints,
        region: buildFaceRegion(box, imageWidth, imageHeight, {
          facePadding: options.facePadding,
          circleScale: options.circleScale,
          rotationRadians,
        }),
      } satisfies FaceDetection;
    })
    .filter((detection) => detection.box.width > 0 && detection.box.height > 0)
    .slice(
      0,
      options.maxFaces === undefined ? undefined : Math.max(0, Math.floor(options.maxFaces)),
    );
}

function normalizeManualSelections(
  selections: FaceGridManualSelection[],
  imageWidth: number,
  imageHeight: number,
  options: FaceGridOptions,
) {
  return selections
    .map((selection) => buildManualFaceDetection(selection, imageWidth, imageHeight, options))
    .filter((detection): detection is FaceDetection => detection !== undefined)
    .slice(
      0,
      options.maxFaces === undefined ? undefined : Math.max(0, Math.floor(options.maxFaces)),
    );
}

function toFaceDetection(
  detection: VisionDetection,
  imageWidth: number,
  imageHeight: number,
  options: FaceGridDetectorOptions,
): FaceDetection | undefined {
  const keypoints = (detection.keypoints ?? [])
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: clamp(point.x, 0, 1) * imageWidth,
      y: clamp(point.y, 0, 1) * imageHeight,
      ...(point.label ? { label: point.label } : {}),
      ...(point.score === undefined ? {} : { score: clamp(point.score, 0, 1) }),
    }));
  const rawBox = detection.boundingBox;
  const fallbackBox = boundsFromKeypoints(keypoints, imageWidth, imageHeight);
  if (!rawBox && !fallbackBox) return undefined;
  const box = clampFaceBox(
    rawBox
      ? { x: rawBox.originX, y: rawBox.originY, width: rawBox.width, height: rawBox.height }
      : fallbackBox!,
    imageWidth,
    imageHeight,
  );
  if (!box.width || !box.height) return undefined;
  const confidence = clamp(
    finite(
      detection.categories?.[0]?.score ??
        keypoints.reduce((max, point) => Math.max(max, point.score ?? 0), 0.5),
    ),
    0,
    1,
  );
  const region = buildFaceRegion(box, imageWidth, imageHeight, {
    facePadding: options.facePadding,
    circleScale: options.circleScale,
    rotationRadians: estimateRotation(keypoints),
  });
  return { box, confidence, keypoints, region };
}

function boundsFromKeypoints(
  points: FaceKeypoint[],
  width: number,
  height: number,
): FaceBox | undefined {
  if (points.length < 2) return undefined;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return clampFaceBox({ x, y, width: right - x, height: bottom - y }, width, height);
}

function estimateRotation(points: FaceKeypoint[]) {
  if (points.length < 2) return 0;
  const first = points[0]!;
  const second = points[1]!;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  return Math.abs(dx) + Math.abs(dy) > 0.001 ? Math.atan2(dy, dx) : 0;
}

function clampFaceBox(box: FaceBox, width: number, height: number): FaceBox {
  const left = clamp(finite(box.x), 0, Math.max(0, width));
  const top = clamp(finite(box.y), 0, Math.max(0, height));
  const right = clamp(finite(box.x) + Math.max(0, finite(box.width)), left, Math.max(0, width));
  const bottom = clamp(finite(box.y) + Math.max(0, finite(box.height)), top, Math.max(0, height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function renderArtifacts(
  source: DecodedImage,
  detections: FaceDetection[],
  options: FaceGridOptions,
): Promise<FaceGridArtifacts> {
  const overlayCanvas = createCanvas(source.width, source.height);
  const overlayContext = get2dContext(overlayCanvas);
  drawSource(overlayContext, source.source, source.width, source.height);
  for (const detection of detections) {
    drawFaceGrid(overlayContext, detection.region, source.width, source.height, {
      ...options,
      gridColor: options.gridColor ?? DEFAULT_GRID_COLOR,
    });
  }
  const overlayBlob = await canvasToPng(overlayCanvas);

  const chipCanvases: CanvasLike[] = [];
  const faceChipBlobs: Blob[] = [];
  for (const detection of detections) {
    const chipCanvas = renderFaceChip(source, detection.region, options);
    chipCanvases.push(chipCanvas);
    faceChipBlobs.push(await canvasToPng(chipCanvas));
  }

  const holeCanvas = createCanvas(source.width, source.height);
  const holeContext = get2dContext(holeCanvas);
  drawSource(holeContext, source.source, source.width, source.height);
  for (const detection of detections) {
    drawFaceGrid(holeContext, detection.region, source.width, source.height, {
      ...options,
      gridColor: options.holeGridColor ?? DEFAULT_HOLE_GRID_COLOR,
    });
  }
  for (const detection of detections)
    drawHole(holeContext, detection.region, options.holeFill ?? DEFAULT_HOLE_FILL);
  const holeBlob = await canvasToPng(holeCanvas);

  const recomposedCanvas = renderRecomposed(source, chipCanvases, holeCanvas, options);
  const recomposedBlob = await canvasToPng(recomposedCanvas);
  return { detections, overlayBlob, faceChipBlobs, holeBlob, recomposedBlob };
}

function renderFaceChip(
  source: DecodedImage,
  region: FaceRegion,
  options: FaceGridOptions,
): CanvasLike {
  const diameter = Math.max(2, Math.ceil(region.circleRadius * 2));
  const canvas = createCanvas(diameter, diameter);
  const context = get2dContext(canvas);
  context.fillStyle = options.chipBackground ?? DEFAULT_CHIP_BACKGROUND;
  context.fillRect(0, 0, diameter, diameter);
  context.save();
  context.beginPath();
  context.arc(diameter / 2, diameter / 2, diameter / 2, 0, Math.PI * 2);
  context.clip();
  context.translate(diameter / 2 - region.centerX, diameter / 2 - region.centerY);
  drawSource(context, source.source, source.width, source.height);
  drawFaceGrid(context, region, source.width, source.height, {
    ...options,
    gridColor: options.chipGridColor ?? DEFAULT_CHIP_GRID_COLOR,
  });
  context.restore();
  return canvas;
}

function renderRecomposed(
  source: DecodedImage,
  chips: CanvasLike[],
  holeCanvas: CanvasLike,
  options: FaceGridOptions,
): CanvasLike {
  const gap = Math.max(0, finite(options.recomposeGap ?? DEFAULT_RECOMPOSE_GAP));
  const padding = Math.max(0, finite(options.recomposePadding ?? DEFAULT_RECOMPOSE_PADDING));
  const chipWidth = chips.reduce((total, chip) => total + canvasWidth(chip), 0);
  const chipGaps = Math.max(0, chips.length - 1) * gap;
  const width = Math.max(source.width + padding * 2, chipWidth + chipGaps + padding * 2);
  const chipHeight = chips.reduce((height, chip) => Math.max(height, canvasHeight(chip)), 0);
  const height = padding * 2 + chipHeight + (chips.length ? gap : 0) + source.height;
  const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
  const context = get2dContext(canvas);
  context.fillStyle = options.outputBackground ?? DEFAULT_OUTPUT_BACKGROUND;
  context.fillRect(0, 0, canvasWidth(canvas), canvasHeight(canvas));
  let x = (canvasWidth(canvas) - (chipWidth + chipGaps)) / 2;
  for (const chip of chips) {
    const y = padding + (chipHeight - canvasHeight(chip)) / 2;
    context.drawImage(chip, x, y);
    x += canvasWidth(chip) + gap;
  }
  context.drawImage(
    holeCanvas,
    (canvasWidth(canvas) - source.width) / 2,
    padding + chipHeight + (chips.length ? gap : 0),
  );
  return canvas;
}

function drawFaceGrid(
  context: CanvasContext,
  region: FaceRegion,
  imageWidth: number,
  imageHeight: number,
  options: Pick<
    FaceGridOptions,
    "gridSpacing" | "gridLineWidth" | "gridAngleDegrees" | "gridColor"
  >,
) {
  if (region.radiusX <= 0 || region.radiusY <= 0) return;
  const spacing = options.gridSpacing ?? Math.max(12, Math.min(48, region.width / 10));
  const lineWidth = Math.max(0.5, finite(options.gridLineWidth ?? Math.max(1, spacing / 16)));
  const bounds = { x: 0, y: 0, width: imageWidth, height: imageHeight };
  context.save();
  context.beginPath();
  context.ellipse(
    region.centerX,
    region.centerY,
    region.radiusX,
    region.radiusY,
    region.rotationRadians,
    0,
    Math.PI * 2,
  );
  context.clip();
  context.strokeStyle = options.gridColor ?? DEFAULT_GRID_COLOR;
  context.lineWidth = lineWidth;
  context.lineCap = "butt";
  for (const line of buildGridLines(
    bounds,
    spacing,
    options.gridAngleDegrees ?? DEFAULT_GRID_ANGLE,
  )) {
    context.beginPath();
    context.moveTo(line.x1, line.y1);
    context.lineTo(line.x2, line.y2);
    context.stroke();
  }
  context.restore();
}

function drawHole(context: CanvasContext, region: FaceRegion, fill: string) {
  context.save();
  context.fillStyle = fill;
  context.beginPath();
  context.arc(region.centerX, region.centerY, region.circleRadius, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawSource(
  context: CanvasContext,
  source: CanvasImageSource,
  width: number,
  height: number,
) {
  context.drawImage(source, 0, 0, width, height);
}

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("Face grid rendering requires a browser canvas");
}

function get2dContext(canvas: CanvasLike): CanvasContext {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create a 2D canvas context");
  return context as CanvasContext;
}

function canvasWidth(canvas: CanvasLike) {
  return canvas.width;
}

function canvasHeight(canvas: CanvasLike) {
  return canvas.height;
}

function canvasToPng(canvas: CanvasLike): Promise<Blob> {
  if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise((resolve, reject) => {
    if (!(canvas instanceof HTMLCanvasElement)) {
      reject(new Error("Unable to encode face grid PNG"));
      return;
    }
    canvas.toBlob(
      (blob: Blob | null) =>
        blob ? resolve(blob) : reject(new Error("Unable to encode face grid PNG")),
      "image/png",
    );
  });
}

async function decodeInput(input: FaceGridInput): Promise<DecodedImage> {
  if (input instanceof Blob) {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(input);
      const canvas = createSourceCanvas(bitmap.width, bitmap.height);
      const context = get2dContext(canvas);
      context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      return {
        source: canvas,
        width: canvasWidth(canvas),
        height: canvasHeight(canvas),
        dispose: () => undefined,
      };
    }
    if (typeof Image === "undefined" || typeof URL === "undefined") {
      throw new Error("This browser cannot decode image blobs");
    }
    const url = URL.createObjectURL(input);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
      return {
        source: image,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        dispose: () => URL.revokeObjectURL(url),
      };
    } catch (cause) {
      URL.revokeObjectURL(url);
      throw cause;
    }
  }

  const width = sourceWidth(input);
  const height = sourceHeight(input);
  if (!width || !height) throw new Error("The image has no readable dimensions");
  if (input instanceof HTMLImageElement && !input.complete) await input.decode();
  return { source: input, width, height, dispose: () => undefined };
}

function createSourceCanvas(width: number, height: number): CanvasLike {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  throw new Error("Face grid rendering requires a browser canvas");
}

function sourceWidth(input: Exclude<FaceGridInput, Blob>) {
  if (input instanceof HTMLImageElement) return input.naturalWidth || input.width;
  return input.width;
}

function sourceHeight(input: Exclude<FaceGridInput, Blob>) {
  if (input instanceof HTMLImageElement) return input.naturalHeight || input.height;
  return input.height;
}

function getDetector(options: FaceGridDetectorOptions): Promise<VisionDetector> {
  const key = JSON.stringify({
    modelAssetUrl: options.modelAssetUrl ?? blazeFaceModelUrl(),
    wasmBaseUrl: normalizeMediapipeBaseUrl(options.wasmBaseUrl ?? mediapipeWasmBaseUrl()),
    minDetectionConfidence: options.minDetectionConfidence ?? 0.5,
    minSuppressionThreshold: options.minSuppressionThreshold ?? 0.3,
  });
  const existing = detectorCache.get(key);
  if (existing) return existing;
  const promise = createDetector(options).catch((error) => {
    detectorCache.delete(key);
    throw error;
  });
  detectorCache.set(key, promise);
  return promise;
}

async function createDetector(options: FaceGridDetectorOptions): Promise<VisionDetector> {
  const { FaceDetector } = await loadMediapipeVision();
  const fileset = await resolveMediapipeFileset(options.wasmBaseUrl);
  const detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: options.modelAssetUrl ?? blazeFaceModelUrl(),
    },
    runningMode: "IMAGE",
    minDetectionConfidence: options.minDetectionConfidence ?? 0.5,
    minSuppressionThreshold: options.minSuppressionThreshold ?? 0.3,
  });
  return detector as unknown as VisionDetector;
}

function mediapipeWasmBaseUrl() {
  return mediapipeAssetUrl("wasm/");
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
