import { afterEach, describe, expect, it, vi } from "vitest";

import { isValidMediaBlob, validateImageBlob } from "./media-validation";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media validation", () => {
  it("rejects empty and structured error payloads before browser decoding", async () => {
    await expect(validateImageBlob(new Blob([], { type: "image/png" }))).rejects.toThrow(
      "内容为空",
    );
    await expect(
      validateImageBlob(
        new Blob([JSON.stringify({ error: { message: "request failed" } })], { type: "image/png" }),
      ),
    ).rejects.toThrow("request failed");
  });

  it("reports invalid payloads without leaking exceptions", async () => {
    await expect(
      isValidMediaBlob(new Blob(["<html>not an image</html>"], { type: "image/png" }), "image"),
    ).resolves.toBe(false);
  });

  it("corrects MIME metadata without changing any original image bytes", async () => {
    class TestImage {
      naturalWidth = 3840;
      naturalHeight = 2160;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }

    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("Image", TestImage);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const originalBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x4b, 0x21, 0x9a, 0x7c, 0x01,
      0x00,
    ]);
    const result = await validateImageBlob(
      new Blob([originalBytes], { type: "application/octet-stream" }),
    );

    expect(result).toMatchObject({ mimeType: "image/png", width: 3840, height: 2160 });
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(originalBytes);
  });
});
