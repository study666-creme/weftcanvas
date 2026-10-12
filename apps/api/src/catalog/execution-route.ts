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
});
export type PrivateModelRoute = z.infer<typeof privateModelRouteSchema>;

export type ResolvedGenerationRoute = {
  route: PrivateModelRoute;
  pricing: ModelPricing;
  catalogVersion: string;
  capabilityVersion: string;
  pricingVersion: string;
};
