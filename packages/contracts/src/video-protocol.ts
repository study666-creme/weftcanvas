import { z } from "zod";

export const VIDEO_PROTOCOL_VERSION = "video.v1" as const;

export const videoOperationSchema = z.enum(["text_to_video", "image_to_video", "video_to_video"]);
export type VideoOperation = z.infer<typeof videoOperationSchema>;

export const videoMediaKindSchema = z.enum(["image", "video", "audio"]);
export type VideoMediaKind = z.infer<typeof videoMediaKindSchema>;

export const videoMediaRoleSchema = z.enum([
  "reference",
  "first_frame",
  "last_frame",
  "source_video",
  "audio_reference",
  "style_reference",
  "element_reference",
]);
export type VideoMediaRole = z.infer<typeof videoMediaRoleSchema>;

export const videoMediaInputSchema = z
  .object({
    kind: videoMediaKindSchema,
    role: videoMediaRoleSchema,
    url: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024 * 1024),
  })
  .superRefine((input, context) => {
    const valid =
      input.kind === "image"
        ? [
            "reference",
            "first_frame",
            "last_frame",
            "style_reference",
            "element_reference",
          ].includes(input.role)
        : input.kind === "video"
          ? ["reference", "source_video"].includes(input.role)
          : ["reference", "audio_reference"].includes(input.role);
    if (!valid)
      context.addIssue({
        code: "custom",
        message: `Role ${input.role} is not valid for ${input.kind}`,
      });
  });
export type VideoMediaInput = z.infer<typeof videoMediaInputSchema>;

export const videoProtocolRequestSchema = z.object({
  version: z.literal(VIDEO_PROTOCOL_VERSION),
  model: z.string().trim().min(1).max(256),
  operation: videoOperationSchema,
  prompt: z.string().trim().min(1).max(100_000),
  duration_seconds: z.number().int().min(1).max(3_600).optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  aspect_ratio: z.string().trim().min(1).max(32).optional(),
  media_inputs: z.array(videoMediaInputSchema).max(64).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type VideoProtocolRequest = z.infer<typeof videoProtocolRequestSchema>;

export const videoProtocolOutputSchema = z.object({
  type: z.literal("video"),
  content_url: z.string().min(1),
  download_url: z.string().min(1).optional(),
  mime_type: z.string().min(1).optional(),
});
export type VideoProtocolOutput = z.infer<typeof videoProtocolOutputSchema>;

export function inferVideoOperation(mediaInputs: VideoMediaInput[]): VideoOperation {
  if (mediaInputs.some((input) => input.kind === "video")) return "video_to_video";
  if (mediaInputs.some((input) => input.kind === "image")) return "image_to_video";
  return "text_to_video";
}

export function buildVideoProtocolRequest(input: {
  model: string;
  prompt: string;
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  mediaInputs?: VideoMediaInput[];
  options?: Record<string, unknown>;
}): VideoProtocolRequest {
  const mediaInputs = input.mediaInputs ?? [];
  return videoProtocolRequestSchema.parse({
    version: VIDEO_PROTOCOL_VERSION,
    model: input.model,
    operation: inferVideoOperation(mediaInputs),
    prompt: input.prompt,
    ...(input.durationSeconds !== undefined ? { duration_seconds: input.durationSeconds } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(mediaInputs.length ? { media_inputs: mediaInputs } : {}),
    // These controls belong to the protocol contract and cannot be overridden
    // by a model-specific option or a private execution route.
    options: { ...(input.options ?? {}), async: true, n: 1 },
  });
}
