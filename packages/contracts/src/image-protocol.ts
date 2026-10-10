import { z } from "zod";

/** Versioned, provider-neutral image generation intent. */
export const IMAGE_PROTOCOL_VERSION = "image.v1" as const;

export const imageOperationSchema = z.enum([
  "text_to_image",
  "image_to_image",
  "image_edit",
]);
export type ImageOperation = z.infer<typeof imageOperationSchema>;

export const imageMediaRoleSchema = z.enum([
  "reference",
  "style_reference",
  "element_reference",
  "mask",
]);
export type ImageMediaRole = z.infer<typeof imageMediaRoleSchema>;

export const imageMediaInputSchema = z.object({
  kind: z.literal("image"),
  role: imageMediaRoleSchema,
  url: z.string().trim().min(1).max(16 * 1024 * 1024),
});
export type ImageMediaInput = z.infer<typeof imageMediaInputSchema>;

export const imageProtocolRequestSchema = z.object({
  version: z.literal(IMAGE_PROTOCOL_VERSION),
  model: z.string().trim().min(1).max(256),
  operation: imageOperationSchema,
  prompt: z.string().trim().min(1).max(100_000),
  resolution: z.string().trim().min(1).max(64).optional(),
  aspect_ratio: z.string().trim().min(1).max(32).optional(),
  quality: z.string().trim().min(1).max(64).optional(),
  count: z.number().int().min(1).max(8).optional(),
  media_inputs: z.array(imageMediaInputSchema).max(32).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type ImageProtocolRequest = z.infer<typeof imageProtocolRequestSchema>;

export const imageProtocolOutputSchema = z.object({
  type: z.literal("image"),
  content_url: z.string().min(1),
  download_url: z.string().min(1).optional(),
  mime_type: z.string().min(1).optional(),
});
export type ImageProtocolOutput = z.infer<typeof imageProtocolOutputSchema>;

export const imageProtocolResponseSchema = z.object({
  type: z.literal("image"),
  outputs: z.array(imageProtocolOutputSchema).min(1).max(8),
});
export type ImageProtocolResponse = z.infer<typeof imageProtocolResponseSchema>;

export function inferImageOperation(mediaInputs: ImageMediaInput[]): ImageOperation {
  if (mediaInputs.some((input) => input.role === "mask")) return "image_edit";
  if (mediaInputs.length) return "image_to_image";
  return "text_to_image";
}

export function buildImageProtocolRequest(input: {
  model: string;
  prompt: string;
  resolution?: string;
  aspectRatio?: string;
  quality?: string;
  count?: number;
  mediaInputs?: ImageMediaInput[];
  options?: Record<string, unknown>;
}): ImageProtocolRequest {
  const mediaInputs = input.mediaInputs ?? [];
  return imageProtocolRequestSchema.parse({
    version: IMAGE_PROTOCOL_VERSION,
    model: input.model,
    operation: inferImageOperation(mediaInputs),
    prompt: input.prompt,
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.count !== undefined ? { count: input.count } : {}),
    ...(mediaInputs.length ? { media_inputs: mediaInputs } : {}),
    options: { ...(input.options ?? {}) },
  });
}
