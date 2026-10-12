import type { CanvasMedia, PublicGenerationJob } from "@weftcanvas/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildGenerationOutputRecords,
  buildGeneratedMediaOutputRecord,
  buildLocalOutputFileName,
  claimLocalOutputRecord,
  completeLocalOutputRecord,
  enqueueGenerationOutputRecords,
  findAvailableLocalOutputFileName,
  migrateLocalOutputSettings,
  migratePendingLocalOutputRecord,
  renewLocalOutputRecord,
  type LocalDirectoryHandle,
  type LocalOutputKind,
  type LocalOutputRecord,
  type LocalOutputSettingsRecord,
} from "./local-output-store";

describe("local output settings migration", () => {
  it("splits the legacy single directory into independent image and video targets", () => {
    const handle = directoryHandle("创作结果");
    const legacy = {
      key: "active",
      enabled: true,
      targetId: "legacy-target",
      selectedAt: 1_000,
      directoryHandle: handle,
    };

    expect(migrateLocalOutputSettings(legacy, "image", () => "unused", 2_000)).toMatchObject({
      key: "image",
      kind: "image",
      enabled: true,
      targetId: "legacy-target:image",
      enabledAt: 1_000,
      directoryName: "创作结果",
      handle,
    });
    expect(migrateLocalOutputSettings(legacy, "video", () => "unused", 2_000)).toMatchObject({
      key: "video",
      kind: "video",
      targetId: "legacy-target:video",
    });
  });

  it("rejects a category record when it is read through the other category", () => {
    const stored = outputSettings("image");
    expect(migrateLocalOutputSettings(stored, "video")).toBeNull();
  });
});

describe("local generation output queue", () => {
  it("routes only new artifacts of the configured media kind", () => {
    const job = completedJob([
      imageArtifact("image-new", "2026-07-23T10:00:01.000Z"),
      imageArtifact("image-old", "2026-07-23T09:59:59.000Z"),
      videoArtifact("video-new", "2026-07-23T10:00:02.000Z"),
      {
        id: "audio",
        kind: "audio",
        mediaId: "audio-media",
        name: "result.mp3",
        mimeType: "audio/mpeg",
        size: 12,
        createdAt: "2026-07-23T10:00:03.000Z",
      },
      { id: "text", kind: "text", text: "done", createdAt: "2026-07-23T10:00:03.000Z" },
    ]);
    const enabledAt = Date.parse("2026-07-23T10:00:00.000Z");

    const images = buildGenerationOutputRecords(job, outputSettings("image", enabledAt));
    const videos = buildGenerationOutputRecords(job, outputSettings("video", enabledAt));

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      kind: "image",
      outputKey: "hosted:job-1:image-new",
      media: { id: "media-image-new", source: "server" },
    });
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      kind: "video",
      outputKey: "hosted:job-1:video-new",
      media: { id: "media-video-new", source: "server" },
    });

    const liveImages = buildGenerationOutputRecords(job, outputSettings("image", enabledAt), false);
    expect(liveImages.map((record) => record.outputKey)).toEqual([
      "hosted:job-1:image-new",
      "hosted:job-1:image-old",
    ]);
  });

  it("uses a stable key so repeated completion delivery only inserts once", async () => {
    const records = new Map<string, LocalOutputRecord>();
    const enqueue = vi.fn(async (record: LocalOutputRecord) => {
      if (records.has(record.key)) return false;
      records.set(record.key, record);
      return true;
    });
    const job = completedJob([imageArtifact("same-artifact", "2026-07-23T10:00:01.000Z")]);
    const settings = outputSettings("image", Date.parse("2026-07-23T10:00:00.000Z"));

    await expect(enqueueGenerationOutputRecords(job, settings, { enqueue })).resolves.toBe(1);
    await expect(enqueueGenerationOutputRecords(job, settings, { enqueue })).resolves.toBe(0);
    expect(records.size).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("routes browser-owned media by MIME type and keeps its output key stable", () => {
    const image = media("image/png");
    expect(
      buildGeneratedMediaOutputRecord(
        { outputKey: "job:media-1", createdAt: 2_000, media: image },
        outputSettings("image", 1_000),
      ),
    ).toMatchObject({
      key: "target-image:browser:job:media-1",
      kind: "image",
      outputKey: "browser:job:media-1",
    });
    expect(
      buildGeneratedMediaOutputRecord(
        { outputKey: "job:media-1", createdAt: 2_000, media: image },
        outputSettings("video", 1_000),
      ),
    ).toBeNull();
    expect(
      buildGeneratedMediaOutputRecord(
        { outputKey: "job:media-1", createdAt: 999, media: image },
        outputSettings("image", 1_000),
      ),
    ).toBeNull();
  });
});

describe("local output write lease", () => {
  it("blocks a concurrent writer and allows recovery after the lease expires", () => {
    const pending = outputRecord();
    const first = claimLocalOutputRecord(pending, "writer-a", 1_000, 100);

    expect(first).toMatchObject({
      state: "writing",
      leaseOwner: "writer-a",
      leaseUntil: 1_100,
      attempts: 1,
    });
    expect(claimLocalOutputRecord(first!, "writer-b", 1_050, 100)).toBeNull();
    expect(claimLocalOutputRecord(first!, "writer-b", 1_101, 100)).toMatchObject({
      state: "writing",
      leaseOwner: "writer-b",
      leaseUntil: 1_201,
      attempts: 2,
    });
    expect(claimLocalOutputRecord({ ...pending, state: "saved" }, "writer-b", 2_000)).toBeNull();
  });

  it("renews and completes a write only while the caller still owns it", () => {
    const writing = claimLocalOutputRecord(outputRecord(), "writer-a", 1_000, 100)!;
    const renewed = renewLocalOutputRecord(writing, "writer-a", 1_050, 100)!;

    expect(renewed.leaseUntil).toBe(1_150);
    expect(renewLocalOutputRecord(renewed, "writer-b", 1_060, 100)).toBeNull();
    expect(completeLocalOutputRecord(renewed, "writer-b", 1_070)).toBeNull();
    expect(completeLocalOutputRecord(renewed, "writer-a", 1_070)).toMatchObject({
      state: "saved",
      leaseOwner: null,
      leaseUntil: null,
      savedAt: 1_070,
    });
  });

  it("moves unfinished work to a replacement directory as pending", () => {
    const writing = claimLocalOutputRecord(outputRecord(), "writer-a", 1_000, 100)!;
    const target = { ...outputSettings("image"), targetId: "replacement-target" };

    expect(migratePendingLocalOutputRecord(writing, target)).toMatchObject({
      key: "replacement-target:hosted:job:artifact",
      targetId: "replacement-target",
      state: "pending",
      leaseOwner: null,
      leaseUntil: null,
    });
    expect(migratePendingLocalOutputRecord({ ...writing, state: "saved" }, target)).toBeNull();
  });
});

describe("local output filenames", () => {
  it("removes path characters, avoids Windows device names, and avoids overwrites", () => {
    const unsafe = buildLocalOutputFileName("../bad:name?.png", "image/png", "job:artifact");
    expect(unsafe).not.toMatch(/[<>:"/\\|?*]/);
    expect(unsafe).toMatch(/^_bad_name_-[a-f0-9]{8}-[a-f0-9]{24}\.png$/);
    expect(buildLocalOutputFileName("CON.png", "image/png", "job:artifact")).toMatch(
      /^_CON-[a-f0-9]{8}-[a-f0-9]{24}\.png$/,
    );
    const first = buildLocalOutputFileName("没有扩展名", "video/mp4", "job:artifact");
    const second = buildLocalOutputFileName("没有扩展名", "video/mp4", "job:artifact");
    expect(first).not.toBe(second);
    expect(first).toMatch(/\.mp4$/);
    expect(second).toMatch(/\.mp4$/);
    expect(buildLocalOutputFileName("wrong.png", "video/webm", "job:video")).toMatch(/\.webm$/);
  });

  it("chooses a fresh persisted name when the first name already exists", async () => {
    const notFound = Object.assign(new Error("missing"), { name: "NotFoundError" });
    const handle: LocalDirectoryHandle = {
      kind: "directory",
      name: "images",
      getFileHandle: vi
        .fn()
        .mockResolvedValueOnce({ createWritable: vi.fn() })
        .mockRejectedValueOnce(notFound),
    };
    const record = outputRecord();

    const available = await findAvailableLocalOutputFileName(handle, record);

    expect(available).not.toBe(record.fileName);
    expect(available).toMatch(/^result-[a-f0-9]{8}-[a-f0-9]{24}\.png$/);
    expect(handle.getFileHandle).toHaveBeenNthCalledWith(1, record.fileName);
    expect(handle.getFileHandle).toHaveBeenNthCalledWith(2, available);
  });
});

function directoryHandle(name: string): LocalDirectoryHandle {
  return {
    kind: "directory",
    name,
    getFileHandle: vi.fn(),
  };
}

function outputSettings(kind: LocalOutputKind, enabledAt = 0): LocalOutputSettingsRecord {
  return {
    key: kind,
    schemaVersion: 1,
    kind,
    enabled: true,
    targetId: `target-${kind}`,
    enabledAt,
    directoryName: kind,
    handle: directoryHandle(kind),
  };
}

function outputRecord(): LocalOutputRecord {
  return {
    key: "target-image:hosted:job:artifact",
    schemaVersion: 1,
    targetId: "target-image",
    kind: "image",
    outputKey: "hosted:job:artifact",
    state: "pending",
    fileName: "result-aabbccdd.png",
    media: media("image/png"),
    artifactCreatedAt: 1_000,
    leaseOwner: null,
    leaseUntil: null,
    savedAt: null,
    attempts: 0,
    lastError: null,
  };
}

function media(mimeType: string): CanvasMedia {
  return {
    id: "media-1",
    name: "result.png",
    mimeType,
    size: 12,
    source: "local",
    serverId: null,
    width: 1,
    height: 1,
    durationMs: null,
  };
}

function completedJob(artifacts: PublicGenerationJob["artifacts"]): PublicGenerationJob {
  return { id: "job-1", status: "completed", artifacts } as unknown as PublicGenerationJob;
}

function imageArtifact(id: string, createdAt: string): PublicGenerationJob["artifacts"][number] {
  return {
    id,
    kind: "image",
    mediaId: `media-${id}`,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 12,
    width: 1,
    height: 1,
    createdAt,
  };
}

function videoArtifact(id: string, createdAt: string): PublicGenerationJob["artifacts"][number] {
  return {
    id,
    kind: "video",
    mediaId: `media-${id}`,
    name: `${id}.mp4`,
    mimeType: "video/mp4",
    size: 12,
    width: 1,
    height: 1,
    duration: 1,
    createdAt,
  };
}
