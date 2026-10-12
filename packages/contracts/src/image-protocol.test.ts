import { describe, expect, it } from "vitest";

import {
  IMAGE_PROTOCOL_VERSION,
  buildImageProtocolRequest,
  imageProtocolRequestSchema,
  imageProtocolResponseSchema,
} from "./image-protocol";

describe("image.v1 protocol", () => {
  it("infers text-to-image without media", () => {
    const request = buildImageProtocolRequest({
      model: "image-model",
      prompt: "a quiet studio portrait",
      resolution: "1k",
      aspectRatio: "1:1",
      quality: "standard",
    });
    expect(request).toMatchObject({
      version: IMAGE_PROTOCOL_VERSION,
      operation: "text_to_image",
      resolution: "1k",
      aspect_ratio: "1:1",
    });
    expect(imageProtocolRequestSchema.parse(request)).toEqual(request);
  });

  it("keeps semantic reference and mask roles", () => {
    const request = buildImageProtocolRequest({
      model: "image-model",
      prompt: "edit the background",
      mediaInputs: [
        { kind: "image", role: "reference", url: "https://example.test/reference.png" },
        { kind: "image", role: "mask", url: "https://example.test/mask.png" },
      ],
    });
    expect(request.operation).toBe("image_edit");
    expect(request.media_inputs).toHaveLength(2);
  });

  it("accepts a stable canonical image output", () => {
    expect(
      imageProtocolResponseSchema.parse({
        type: "image",
        outputs: [
          {
            type: "image",
            content_url: "https://media.example/result.png",
            mime_type: "image/png",
          },
        ],
      }).outputs[0]?.content_url,
    ).toBe("https://media.example/result.png");
  });
});
