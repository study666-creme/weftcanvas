import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { DefaultMediaInspector } from "../media/inspector.js";
import {
  GenerationMediaMaterializationError,
  GenerationResultMaterializer,
} from "./result-materializer.js";

let directory: string;
let png: Buffer;
let sequence = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "kachang-result-materializer-"));
  png = await sharp({
    create: { width: 24, height: 16, channels: 4, background: { r: 40, g: 120, b: 180, alpha: 1 } },
  }).png().toBuffer();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("generation result materializer", () => {
  it("strictly decodes base64 and validates the resulting image", async () => {
    const materializer = createMaterializer();
    const result = await materializer.materialize({
      source: "base64",
      data: png.toString("base64"),
      mimeType: "image/png",
    }, "image");

    expect(result).toMatchObject({
      size: png.length,
      inspected: { mimeType: "image/png", width: 24, height: 16 },
    });
    await result.remove();
    await result.remove();
    await expect(materializer.materialize({
      source: "base64",
      data: "not base64!",
      mimeType: "image/png",
    }, "image")).rejects.toMatchObject({ code: "RESULT_BASE64_INVALID", retryable: false });
  });

  it("downloads only configured HTTPS hosts and validates each result", async () => {
    const fetcher = vi.fn(async () => new Response(png, {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": String(png.length) },
    }));
    const materializer = createMaterializer(fetcher as typeof fetch, ["media.example", "*.cdn.example"]);

    const result = await materializer.materialize({ source: "url", url: "https://asset.cdn.example/result.png" }, "image");
    expect(result.inspected).toMatchObject({ kind: "image", width: 24, height: 16 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await result.remove();

    await expect(materializer.materialize({ source: "url", url: "https://untrusted.example/result.png" }, "image"))
      .rejects.toMatchObject({ code: "RESULT_HOST_NOT_ALLOWED", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies temporary download failures separately from invalid media", async () => {
    const unavailable = createMaterializer(async () => new Response(null, { status: 503 }));
    await expect(unavailable.materialize({ source: "url", url: "https://media.example/result.png" }, "image"))
      .rejects.toMatchObject({ code: "RESULT_DOWNLOAD_UNAVAILABLE", retryable: true });

    const invalid = createMaterializer(async () => new Response("{\"error\":true}", { status: 200 }));
    await expect(invalid.materialize({ source: "url", url: "https://media.example/result.png" }, "image"))
      .rejects.toBeInstanceOf(GenerationMediaMaterializationError);
    await expect(invalid.materialize({ source: "url", url: "https://media.example/result.png" }, "image"))
      .rejects.toMatchObject({ code: "MEDIA_INVALID", retryable: false });
  });
});

function createMaterializer(fetcher: typeof fetch = fetch, allowedHosts = ["media.example"]) {
  return new GenerationResultMaterializer({
    directory,
    inspector: new DefaultMediaInspector(),
    allowedHosts,
    fetch: fetcher,
    createId: () => `result_${String(++sequence).padStart(4, "0")}`,
    limits: { image: 1024 * 1024 },
  });
}
