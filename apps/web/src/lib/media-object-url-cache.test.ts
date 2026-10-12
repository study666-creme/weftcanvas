import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireMediaObjectUrl,
  clearMediaObjectUrlCache,
  invalidateMediaObjectUrl,
  releaseMediaObjectUrl,
} from "./media-object-url-cache";

afterEach(() => {
  clearMediaObjectUrlCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("media object URL cache", () => {
  it("shares one IndexedDB blob load and keeps the URL through a short virtualized unmount", async () => {
    vi.useFakeTimers();
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-media");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const load = vi.fn(async () => new Blob(["image"], { type: "image/png" }));

    await expect(
      Promise.all([acquireMediaObjectUrl("media-1", load), acquireMediaObjectUrl("media-1", load)]),
    ).resolves.toEqual(["blob:shared-media", "blob:shared-media"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);

    releaseMediaObjectUrl("media-1");
    releaseMediaObjectUrl("media-1");
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(acquireMediaObjectUrl("media-1", load)).resolves.toBe("blob:shared-media");
    expect(load).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    releaseMediaObjectUrl("media-1");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:shared-media");
  });

  it("invalidates a removed media URL immediately", async () => {
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:removed-media");

    await acquireMediaObjectUrl("media-2", async () => new Blob(["video"], { type: "video/mp4" }));
    invalidateMediaObjectUrl("media-2");

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:removed-media");
    const reload = vi.fn(async () => null);
    await expect(acquireMediaObjectUrl("media-2", reload)).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    releaseMediaObjectUrl("media-2");
  });
});
