import type { MediaKind } from "@weftcanvas/contracts";

import { MediaService, MediaServiceError } from "../media/service.js";
import { SignedMediaAccess } from "../media/signed-access.js";
import type {
  GenerationReferenceKind,
  GenerationReferenceResolver,
} from "./weftcanvas-provider.js";
import { GenerationProviderError } from "./types.js";

type StoredReferenceResolverOptions = {
  signedAccess?: Pick<SignedMediaAccess, "createUrl">;
  maxInlineImageBytes?: number;
};

export class StoredGenerationReferenceResolver implements GenerationReferenceResolver {
  private readonly maxInlineImageBytes: number;

  constructor(
    private readonly media: Pick<MediaService, "get" | "readReference">,
    private readonly options: StoredReferenceResolverOptions = {},
  ) {
    this.maxInlineImageBytes = options.maxInlineImageBytes ?? 20 * 1024 * 1024;
  }

  async resolve(input: {
    ownerId: string;
    projectId: string;
    mediaId: string;
    kind: GenerationReferenceKind;
    format?: string;
  }) {
    const kind = input.kind as MediaKind;
    let metadata;
    try {
      metadata = await this.getForGeneration(input.ownerId, input.projectId, input.mediaId);
    } catch (error) {
      throw referenceError(error);
    }
    if (metadata.status !== "ready" || metadata.kind !== kind) {
      throw rejected("REFERENCE_NOT_READY", "参考素材尚未准备完成");
    }

    if (kind === "image" && input.format === "uri-or-data-image") {
      try {
        const reference = await this.readForGeneration(
          input.ownerId,
          input.projectId,
          input.mediaId,
          kind,
        );
        return `data:${reference.media.mimeType};base64,${reference.bytes.toString("base64")}`;
      } catch (error) {
        throw referenceError(error);
      }
    }

    if (this.options.signedAccess) return this.options.signedAccess.createUrl(input.mediaId, kind);
    if (kind === "image" && input.format !== "public-http-url") {
      try {
        const reference = await this.readForGeneration(
          input.ownerId,
          input.projectId,
          input.mediaId,
          kind,
        );
        return `data:${reference.media.mimeType};base64,${reference.bytes.toString("base64")}`;
      } catch (error) {
        throw referenceError(error);
      }
    }
    throw rejected("REFERENCE_PUBLIC_URL_UNAVAILABLE", "参考素材暂时无法用于当前模型");
  }

  private async getForGeneration(ownerId: string, projectId: string, mediaId: string) {
    try {
      return await this.media.get(ownerId, mediaId, projectId);
    } catch (error) {
      if (!(error instanceof MediaServiceError) || error.code !== "MEDIA_NOT_FOUND") throw error;
      return this.media.get(ownerId, mediaId);
    }
  }

  private async readForGeneration(
    ownerId: string,
    projectId: string,
    mediaId: string,
    kind: MediaKind,
  ) {
    try {
      return await this.media.readReference(
        ownerId,
        mediaId,
        kind,
        this.maxInlineImageBytes,
        projectId,
      );
    } catch (error) {
      if (!(error instanceof MediaServiceError) || error.code !== "MEDIA_NOT_FOUND") throw error;
      return this.media.readReference(ownerId, mediaId, kind, this.maxInlineImageBytes);
    }
  }
}

function referenceError(error: unknown) {
  if (error instanceof GenerationProviderError) return error;
  if (error instanceof MediaServiceError) return rejected(error.code, error.message);
  return rejected("REFERENCE_UNAVAILABLE", "参考素材暂时无法读取");
}

function rejected(code: string, message: string) {
  return new GenerationProviderError(code, message, "rejected");
}
