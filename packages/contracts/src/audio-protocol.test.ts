import { describe, expect, it } from "vitest";

import {
  AUDIO_PROTOCOL_VERSION,
  audioModelProtocolSchema,
  isGeminiNativeAudioPath,
  wrapPcmToWav,
} from "./audio-protocol.js";
import { modelProtocolSchema } from "./model-catalog.js";
import { customApiCatalogModelSchema } from "./custom-api.js";

describe("audio.v1 protocol", () => {
  it("accepts both delivery formats and nothing else", () => {
    expect(
      audioModelProtocolSchema.parse({ version: AUDIO_PROTOCOL_VERSION, outputFormat: "url" }),
    ).toEqual({ version: "audio.v1", outputFormat: "url" });
    expect(
      audioModelProtocolSchema.safeParse({ version: "audio.v1", outputFormat: "stream" }).success,
    ).toBe(false);
  });

  it("joins the public catalog protocol union", () => {
    expect(
      modelProtocolSchema.safeParse({ version: "audio.v1", outputFormat: "inline-data" }).success,
    ).toBe(true);
  });

  it("parses the BYOK catalog protocol with snake_case output_format", () => {
    const parsed = customApiCatalogModelSchema.safeParse({
      id: "suno",
      modality: "audio",
      operation: "generate",
      protocol: { version: "audio.v1", output_format: "url" },
      endpoint: { method: "POST", path: "/v1/chat/completions", content_type: "application/json" },
      parameters: [],
      output: { type: "audio", format: "url", count: { fixed: 2 } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.protocol).toMatchObject({ output_format: "url" });
  });

  it("recognizes Gemini native generateContent endpoints only in strict form", () => {
    expect(isGeminiNativeAudioPath("/v1beta/models/gemini-3.8-flash-tts:generateContent")).toBe(
      true,
    );
    expect(isGeminiNativeAudioPath("/v1beta/models/x:generateContent/../../admin")).toBe(false);
    expect(isGeminiNativeAudioPath("/v1beta/models/:generateContent")).toBe(false);
    expect(isGeminiNativeAudioPath("/v1/chat/completions")).toBe(false);
  });
});

describe("wrapPcmToWav", () => {
  it("produces a canonical 44-byte RIFF/WAVE header around the payload", () => {
    const pcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const wav = wrapPcmToWav(pcm, { sampleRate: 24_000, channels: 1 });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const tag = (offset: number) =>
      String.fromCharCode(...Array.from(wav.subarray(offset, offset + 4)));
    expect(wav.length).toBe(48);
    expect(tag(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(40);
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4);
    expect(Array.from(wav.subarray(44))).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
});
