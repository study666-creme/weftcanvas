import { describe, expect, it } from "vitest";

import { FilesystemMediaObjectStore } from "./filesystem-object-store.js";
import { createMediaObjectStore } from "./object-store-factory.js";
import { S3MediaObjectStore } from "./s3-object-store.js";

describe("media object store factory", () => {
  it("uses the filesystem adapter by default", () => {
    expect(createMediaObjectStore({ MEDIA_STORAGE_PATH: ".data/test-media" }))
      .toBeInstanceOf(FilesystemMediaObjectStore);
  });

  it("constructs an S3-compatible adapter only from complete server configuration", () => {
    expect(createMediaObjectStore({
      MEDIA_STORAGE_DRIVER: "s3",
      S3_BUCKET: "canvas-private",
      S3_REGION: "auto",
      S3_ENDPOINT: "https://objects.example.test",
      S3_ACCESS_KEY_ID: "server-only-key",
      S3_SECRET_ACCESS_KEY: "server-only-secret",
      S3_FORCE_PATH_STYLE: "true",
      S3_KEY_PREFIX: "canvas/production",
      S3_KEY_DERIVATION_SECRET: "test-key-derivation-secret-at-least-32-bytes",
    })).toBeInstanceOf(S3MediaObjectStore);
  });

  it("fails fast for incomplete or unsafe configuration", () => {
    expect(() => createMediaObjectStore({ MEDIA_STORAGE_DRIVER: "unknown" }))
      .toThrow("MEDIA_STORAGE_DRIVER");
    expect(() => createMediaObjectStore({ MEDIA_STORAGE_DRIVER: "s3", S3_BUCKET: "canvas-private" }))
      .toThrow("S3_REGION");
    expect(() => createMediaObjectStore({
      MEDIA_STORAGE_DRIVER: "s3",
      S3_BUCKET: "canvas-private",
      S3_REGION: "auto",
      S3_ENDPOINT: "http://objects.example.test",
      S3_KEY_DERIVATION_SECRET: "test-key-derivation-secret-at-least-32-bytes",
    })).toThrow("HTTPS");
    expect(() => createMediaObjectStore({
      MEDIA_STORAGE_DRIVER: "s3",
      S3_BUCKET: "canvas-private",
      S3_REGION: "auto",
      S3_FORCE_PATH_STYLE: "sometimes",
      S3_KEY_DERIVATION_SECRET: "test-key-derivation-secret-at-least-32-bytes",
    })).toThrow("true or false");
  });
});
