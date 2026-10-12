import { describe, expect, it } from "vitest";

import { buildVideoProtocolRequest, videoProtocolRequestSchema } from "./video-protocol.js";

describe("video protocol", () => {
  it("infers operation from semantic media and preserves ordered roles", () => {
    expect(
      buildVideoProtocolRequest({
        model: "public-video",
        prompt: "animate",
        durationSeconds: 8,
        resolution: "720p",
        aspectRatio: "16:9",
        mediaInputs: [
          { kind: "image", role: "first_frame", url: "https://asset.test/first.png" },
          { kind: "video", role: "source_video", url: "https://asset.test/source.mp4" },
        ],
        options: { generate_audio: true },
      }),
    ).toEqual({
      version: "video.v1",
      model: "public-video",
      operation: "video_to_video",
      prompt: "animate",
      duration_seconds: 8,
      resolution: "720p",
      aspect_ratio: "16:9",
      media_inputs: [
        { kind: "image", role: "first_frame", url: "https://asset.test/first.png" },
        { kind: "video", role: "source_video", url: "https://asset.test/source.mp4" },
      ],
      options: { async: true, n: 1, generate_audio: true },
    });
  });

  it("rejects roles that do not match the media kind", () => {
    expect(() =>
      videoProtocolRequestSchema.parse({
        version: "video.v1",
        model: "public-video",
        operation: "image_to_video",
        prompt: "animate",
        media_inputs: [{ kind: "audio", role: "first_frame", url: "https://asset.test/audio.mp3" }],
      }),
    ).toThrow();
  });
});
