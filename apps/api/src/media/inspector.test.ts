import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import { DefaultMediaInspector } from "./inspector.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/e2e");
let directory: string;
let imagePath: string;
let invalidPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "weftcanvas-media-inspector-"));
  imagePath = join(directory, "valid.png");
  invalidPath = join(directory, "invalid.png");
  await sharp({
    create: { width: 32, height: 18, channels: 4, background: { r: 20, g: 140, b: 100, alpha: 1 } },
  })
    .png()
    .toFile(imagePath);
  await writeFile(invalidPath, '{"error":"not an image"}');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("server media inspector", () => {
  const inspector = new DefaultMediaInspector();

  it("fully decodes image pixels and returns trusted dimensions", async () => {
    await expect(inspector.inspect(imagePath, "image")).resolves.toMatchObject({
      kind: "image",
      mimeType: "image/png",
      width: 32,
      height: 18,
      durationMs: null,
    });
    await expect(inspector.inspect(invalidPath, "image")).rejects.toMatchObject({
      code: "MEDIA_INVALID",
    });
  });

  it("parses real video container, track, duration, and dimensions", async () => {
    await expect(
      inspector.inspect(join(fixtures, "video-frame.mp4"), "video"),
    ).resolves.toMatchObject({
      kind: "video",
      mimeType: "video/mp4",
      width: 96,
      height: 54,
      durationMs: 667,
    });
  });

  it("parses real audio and rejects it when video is expected", async () => {
    await expect(
      inspector.inspect(join(fixtures, "audio-tone.mp3"), "audio"),
    ).resolves.toMatchObject({
      kind: "audio",
      mimeType: "audio/mpeg",
      width: null,
      height: null,
      durationMs: 653,
    });
    await expect(
      inspector.inspect(join(fixtures, "audio-tone.mp3"), "video"),
    ).rejects.toMatchObject({ code: "MEDIA_TYPE_MISMATCH" });
  });
});
