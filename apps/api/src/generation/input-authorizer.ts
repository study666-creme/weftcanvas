import type { GenerationJobInput } from "@kachang/contracts";

import { MediaService, MediaServiceError } from "../media/service.js";
import type { GenerationInputAuthorizer, GenerationInputAuthorizationResult } from "./service.js";

export class MediaGenerationInputAuthorizer implements GenerationInputAuthorizer {
  constructor(private readonly media: Pick<MediaService, "get">) {}

  async authorize(
    ownerId: string,
    projectIdOrInputs: string | GenerationJobInput,
    scopedInputs?: GenerationJobInput,
  ): Promise<GenerationInputAuthorizationResult> {
    const projectId = typeof projectIdOrInputs === "string" ? projectIdOrInputs : undefined;
    const inputs = typeof projectIdOrInputs === "string" ? scopedInputs! : projectIdOrInputs;
    for (const [kind, ids] of [
      ["image", inputs.images],
      ["image", inputs.styleImages ?? []],
      ["image", inputs.elementImages ?? []],
      ["video", inputs.videos],
      ["audio", inputs.audios],
    ] as const) {
      for (const mediaId of ids) {
        try {
          const media = await this.getForGeneration(ownerId, projectId, mediaId);
          if (media.status !== "ready" || media.kind !== kind) {
            return { ok: false, code: "REFERENCE_NOT_READY", message: "参考素材尚未准备完成" };
          }
        } catch (error) {
          if (error instanceof MediaServiceError) {
            return { ok: false, code: "REFERENCE_NOT_FOUND", message: "没有找到可用的参考素材" };
          }
          throw error;
        }
      }
    }
    return { ok: true };
  }

  private async getForGeneration(ownerId: string, projectId: string | undefined, mediaId: string) {
    if (!projectId) return this.media.get(ownerId, mediaId);
    try {
      return await this.media.get(ownerId, mediaId, projectId);
    } catch (error) {
      if (!(error instanceof MediaServiceError) || error.code !== "MEDIA_NOT_FOUND") throw error;
      // Local-only generation predates cloud project creation and therefore
      // legitimately uses personal media. Never fall through to another
      // project's binding.
      return this.media.get(ownerId, mediaId);
    }
  }
}
