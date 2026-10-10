import { describe, expect, it } from "vitest";

import { parseWorkerMode } from "./mode.js";

describe("parseWorkerMode", () => {
  it("selects media-multipart for the media worker contract", () => {
    expect(parseWorkerMode({
      GENERATION_WORKER_ENABLED: "false",
      MEDIA_MULTIPART_WORKER_ENABLED: "true",
    })).toBe("media-multipart");
  });

  it("selects generation for the generation worker contract", () => {
    expect(parseWorkerMode({
      GENERATION_WORKER_ENABLED: "true",
      MEDIA_MULTIPART_WORKER_ENABLED: "false",
    })).toBe("generation");
  });

  it("rejects double-enable with a clear error", () => {
    expect(() => parseWorkerMode({
      GENERATION_WORKER_ENABLED: "true",
      MEDIA_MULTIPART_WORKER_ENABLED: "true",
    })).toThrow(/cannot both be enabled/);
  });

  it("rejects double-disable with a clear error", () => {
    expect(() => parseWorkerMode({
      GENERATION_WORKER_ENABLED: "false",
      MEDIA_MULTIPART_WORKER_ENABLED: "false",
    })).toThrow(/must be enabled/);
  });

  it("rejects missing mode flags", () => {
    expect(() => parseWorkerMode({})).toThrow(/GENERATION_WORKER_ENABLED must be true or false/);
    expect(() => parseWorkerMode({
      GENERATION_WORKER_ENABLED: "false",
    })).toThrow(/MEDIA_MULTIPART_WORKER_ENABLED must be true or false/);
  });

  it("rejects illegal boolean values for either flag", () => {
    for (const bad of ["1", "0", "yes", "TRUE", "enabled", " on "]) {
      expect(() => parseWorkerMode({
        GENERATION_WORKER_ENABLED: bad,
        MEDIA_MULTIPART_WORKER_ENABLED: "false",
      }), `GENERATION_WORKER_ENABLED=${JSON.stringify(bad)}`).toThrow(/must be true or false/);
      expect(() => parseWorkerMode({
        GENERATION_WORKER_ENABLED: "false",
        MEDIA_MULTIPART_WORKER_ENABLED: bad,
      }), `MEDIA_MULTIPART_WORKER_ENABLED=${JSON.stringify(bad)}`).toThrow(/must be true or false/);
    }
  });

  it("trims surrounding whitespace on boolean values", () => {
    expect(parseWorkerMode({
      GENERATION_WORKER_ENABLED: " false ",
      MEDIA_MULTIPART_WORKER_ENABLED: " true ",
    })).toBe("media-multipart");
  });
});
