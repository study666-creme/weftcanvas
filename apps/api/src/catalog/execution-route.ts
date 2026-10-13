import { z } from "zod";
import type { ModelPricing } from "@weftcanvas/contracts";

export const privateModelRouteSchema = z.object({
  sourceModelId: z.string().min(1),
  modality: z.enum(["text", "image", "video", "audio"]),
  endpoint: z.object({
    method: z.literal("POST"),
    path: z.string().min(1),
    contentType: z.literal("application/json"),
  }),
  parameters: z.array(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      type: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
      fixed: z.unknown().optional(),
      default: z.unknown().optional(),
      format: z.string().min(1).optional(),
      itemsFormat: z.string().min(1).optional(),
    }),
  ),
  /**
   * 音频输出契约（仅 audio 路由携带）：交付形态决定执行侧解析方式，
   * PCM 参数用于把 Gemini 原生返回的无头音频包成 WAV。
   */
  audioOutput: z
    .object({
      format: z.enum(["url", "inline-data"]),
      sampleRateHz: z.number().int().positive().max(192_000).optional(),
      channels: z.number().int().positive().max(8).optional(),
    })
    .optional(),
});
export type PrivateModelRoute = z.infer<typeof privateModelRouteSchema>;

export type ResolvedGenerationRoute = {
  route: PrivateModelRoute;
  pricing: ModelPricing;
  catalogVersion: string;
  capabilityVersion: string;
  pricingVersion: string;
};
