import { describe, expect, it } from "vitest";

import { customApiCatalogModelSchema, customApiCatalogParameterSchema } from "./custom-api";

describe("custom API catalog contracts", () => {
  it("preserves an explicitly disabled media array", () => {
    expect(
      customApiCatalogParameterSchema.parse({
        name: "referenceImages",
        path: "images",
        type: "array",
        min_items: 0,
        max_items: 0,
        items: { type: "string", format: "uri-or-data-image" },
      }),
    ).toMatchObject({ min_items: 0, max_items: 0 });
  });

  it("accepts video.v1 protocol metadata from the public catalog", () => {
    const parsed = customApiCatalogModelSchema.parse({
      id: "video-model",
      label: "视频模型",
      modality: "video",
      operation: "generate",
      protocol: {
        version: "video.v1",
        endpoint: { method: "POST", path: "/v1/videos" },
        media_roles: ["reference", "first_frame", "source_video"],
      },
      endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
      output: { type: "video", count: { fixed: 1 } },
      parameters: [],
    });

    expect(parsed.protocol?.media_roles).toEqual(["reference", "first_frame", "source_video"]);
  });

  it("accepts image.v1 protocol metadata from the public catalog", () => {
    const parsed = customApiCatalogModelSchema.parse({
      id: "image-model",
      label: "图片模型",
      modality: "image",
      operation: "generate",
      protocol: {
        version: "image.v1",
        endpoint: { method: "POST", path: "/v1/images/generations" },
        media_roles: ["reference", "style_reference", "element_reference", "mask"],
      },
      endpoint: {
        method: "POST",
        path: "/v1/images/generations",
        content_type: "application/json",
      },
      output: { type: "image", count: { fixed: 1 } },
      parameters: [],
    });

    expect(parsed.protocol?.version).toBe("image.v1");
  });
});
