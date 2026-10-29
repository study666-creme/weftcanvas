import type { CanvasMedia } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import {
  DATE_BUCKET_LABELS,
  dateBucket,
  digestProject,
  filterWorks,
  formatBytes,
  formatDuration,
  formatRelativeTime,
  greetingFor,
  groupWorksByDate,
  looseMedia,
  mediaKindOf,
  mergeWorks,
  sortProjects,
  worksFromLibraryItems,
  worksFromWorkbenchJobs,
  type HomeWork,
  type LibraryItemLike,
  type WorkbenchJobLike,
} from "./home-data";

// 时间都用本地时区构造：dateBucket / greetingFor 按本地日界与钟点判定。
const NOW = new Date(2026, 9, 25, 15, 30).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function media(id: string, mimeType = "image/png", extra: Partial<CanvasMedia> = {}): CanvasMedia {
  return {
    id,
    name: `${id}.bin`,
    mimeType,
    size: 1_024,
    source: "local",
    serverId: null,
    width: null,
    height: null,
    durationMs: null,
    ...extra,
  };
}

function work(key: string, overrides: Partial<HomeWork> = {}): HomeWork {
  return {
    key,
    kind: "image",
    media: media(key),
    prompt: "",
    model: null,
    createdAt: NOW,
    origin: { type: "library", assetId: `asset-${key}` },
    ...overrides,
  };
}

function mediaNode(
  id: string,
  mediaValue: unknown,
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, data: { kind: "image", media: mediaValue, ...data } };
}

describe("mediaKindOf", () => {
  it("maps mime families onto work kinds, case-insensitively", () => {
    expect(mediaKindOf({ mimeType: "image/webp" })).toBe("image");
    expect(mediaKindOf({ mimeType: "VIDEO/MP4" })).toBe("video");
    expect(mediaKindOf({ mimeType: "audio/mpeg" })).toBe("audio");
    expect(mediaKindOf({ mimeType: "application/json" })).toBeNull();
  });
});

describe("looseMedia", () => {
  it("rejects values without an id or mime type", () => {
    expect(looseMedia(null)).toBeNull();
    expect(looseMedia([])).toBeNull();
    expect(looseMedia({ mimeType: "image/png" })).toBeNull();
    expect(looseMedia({ id: "", mimeType: "image/png" })).toBeNull();
    expect(looseMedia({ id: "m1" })).toBeNull();
  });

  it("fills defaults and drops malformed optional fields", () => {
    expect(
      looseMedia({
        id: "m1",
        mimeType: "image/png",
        size: Number.NaN,
        source: "remote",
        serverId: "",
        width: 1023.6,
        height: -4,
        durationMs: "12",
      }),
    ).toEqual({
      id: "m1",
      name: "未命名素材",
      mimeType: "image/png",
      size: 0,
      source: "local",
      serverId: null,
      width: 1024,
      height: null,
      durationMs: null,
    });
  });

  it("keeps server-backed media intact", () => {
    expect(
      looseMedia({
        id: "m2",
        name: "clip.mp4",
        mimeType: "video/mp4",
        size: 2_048,
        source: "server",
        serverId: "srv-2",
        width: 1280,
        height: 720,
        durationMs: 5_000,
      }),
    ).toEqual(
      media("m2", "video/mp4", {
        name: "clip.mp4",
        size: 2_048,
        source: "server",
        serverId: "srv-2",
        width: 1280,
        height: 720,
        durationMs: 5_000,
      }),
    );
  });
});

describe("digestProject", () => {
  const fallback = { id: "fallback-id", name: "备用名" };

  it("returns an empty digest for snapshots it cannot read", () => {
    const empty = { cover: [], works: [], counts: { image: 0, video: 0, audio: 0, text: 0 } };
    expect(digestProject(null, fallback)).toEqual(empty);
    expect(digestProject({ nodes: "broken" }, fallback)).toEqual(empty);
    expect(digestProject({ nodes: [null, 3, { data: null }] }, fallback)).toEqual(empty);
  });

  it("counts nodes by kind, treating notes as text", () => {
    const digest = digestProject(
      {
        nodes: [
          { id: "t1", data: { kind: "text" } },
          { id: "n1", data: { kind: "note" } },
          mediaNode("i1", { id: "img-1", mimeType: "image/png" }),
          mediaNode("v1", { id: "vid-1", mimeType: "video/mp4" }, { kind: "video" }),
          mediaNode("a1", { id: "aud-1", mimeType: "audio/mpeg" }, { kind: "music" }),
          mediaNode("x1", { id: "doc-1", mimeType: "application/pdf" }),
        ],
      },
      fallback,
    );
    expect(digest.counts).toEqual({ image: 1, video: 1, audio: 1, text: 2 });
  });

  it("prefers images for the cover, newest first, deduplicated and capped at four", () => {
    const digest = digestProject(
      {
        nodes: [
          mediaNode("v1", { id: "vid-new", mimeType: "video/mp4" }, { updatedAt: 900 }),
          mediaNode("i1", { id: "img-old", mimeType: "image/png" }, { updatedAt: 100 }),
          mediaNode("i2", { id: "img-new", mimeType: "image/png" }, { updatedAt: 500 }),
          mediaNode("i2b", { id: "img-new", mimeType: "image/png" }, { updatedAt: 800 }),
          mediaNode("i3", { id: "img-mid", mimeType: "image/png" }, { createdAt: 300 }),
          mediaNode("i4", { id: "img-oldest", mimeType: "image/png" }, { updatedAt: 50 }),
          mediaNode("a1", { id: "aud", mimeType: "audio/mpeg" }, { updatedAt: 999 }),
        ],
      },
      fallback,
    );
    expect(digest.cover.map((item) => item.media.id)).toEqual([
      "img-new",
      "img-mid",
      "img-old",
      "img-oldest",
    ]);
    expect(digest.cover.every((item) => item.kind === "image")).toBe(true);
  });

  it("falls back to videos when there are not enough images", () => {
    const digest = digestProject(
      {
        nodes: [
          mediaNode("v1", { id: "vid-1", mimeType: "video/mp4" }, { updatedAt: 10 }),
          mediaNode("i1", { id: "img-1", mimeType: "image/png" }, { updatedAt: 1 }),
        ],
      },
      fallback,
    );
    expect(digest.cover).toEqual([
      { media: expect.objectContaining({ id: "img-1" }), kind: "image" },
      { media: expect.objectContaining({ id: "vid-1" }), kind: "video" },
    ]);
  });

  it("collects only generated media as works, with job metadata", () => {
    const digest = digestProject(
      {
        id: "project-1",
        name: "海报项目",
        nodes: [
          mediaNode("uploaded", { id: "img-upload", mimeType: "image/png" }, { updatedAt: 10 }),
          mediaNode(
            "generated",
            { id: "img-gen", mimeType: "image/png" },
            {
              body: "  雨夜霓虹街道  ",
              updatedAt: 10,
              generation: {
                jobId: "job-1",
                modelId: "model-a",
                jobCreatedAt: "2026-10-25T01:00:00.000Z",
              },
            },
          ),
          mediaNode(
            "no-date",
            { id: "vid-gen", mimeType: "video/mp4" },
            { updatedAt: 42, generation: { jobId: "job-2", modelId: "", jobCreatedAt: null } },
          ),
        ],
      },
      fallback,
    );
    expect(digest.works).toEqual([
      {
        key: "img-gen",
        kind: "image",
        media: expect.objectContaining({ id: "img-gen" }),
        prompt: "雨夜霓虹街道",
        model: "model-a",
        createdAt: Date.parse("2026-10-25T01:00:00.000Z"),
        origin: {
          type: "project",
          projectId: "project-1",
          projectName: "海报项目",
          nodeId: "generated",
        },
      },
      {
        key: "vid-gen",
        kind: "video",
        media: expect.objectContaining({ id: "vid-gen" }),
        prompt: "",
        model: null,
        createdAt: 42,
        origin: {
          type: "project",
          projectId: "project-1",
          projectName: "海报项目",
          nodeId: "no-date",
        },
      },
    ]);
  });

  it("uses the summary id and name when the snapshot omits them", () => {
    const digest = digestProject(
      {
        nodes: [
          mediaNode("n1", { id: "img", mimeType: "image/png" }, { generation: { jobId: "job" } }),
        ],
      },
      fallback,
    );
    expect(digest.works[0]?.origin).toEqual({
      type: "project",
      projectId: "fallback-id",
      projectName: "备用名",
      nodeId: "n1",
    });
  });

  it("caps works per project", () => {
    const nodes = Array.from({ length: 130 }, (_, index) =>
      mediaNode(
        `n${index}`,
        { id: `img-${index}`, mimeType: "image/png" },
        { generation: { jobId: `job-${index}` } },
      ),
    );
    const digest = digestProject({ nodes }, fallback);
    expect(digest.works).toHaveLength(120);
    // 封面与计数不受作品上限影响。
    expect(digest.counts.image).toBe(130);
  });
});

describe("worksFromWorkbenchJobs", () => {
  const job = (overrides: Partial<WorkbenchJobLike>): WorkbenchJobLike => ({
    id: "job-1",
    status: "completed",
    modality: "image",
    createdAt: "2026-10-25T02:00:00.000Z",
    artifacts: [],
    ...overrides,
  });

  it("turns completed media artifacts into server-backed works", () => {
    const works = worksFromWorkbenchJobs([
      job({
        modelLabel: "画面模型",
        modelId: "model-a",
        parameters: { prompt: "  云海延时  " },
        artifacts: [
          { kind: "text" },
          {
            kind: "video",
            mediaId: "media-1",
            name: "clip.mp4",
            mimeType: "video/mp4",
            size: 4_096,
            width: 1280,
            height: 720,
            duration: 5.2,
          },
        ],
      }),
    ]);
    expect(works).toEqual([
      {
        key: "media-1",
        kind: "video",
        media: {
          id: "media-1",
          name: "clip.mp4",
          mimeType: "video/mp4",
          size: 4_096,
          source: "server",
          serverId: "media-1",
          width: 1280,
          height: 720,
          durationMs: 5_200,
        },
        prompt: "云海延时",
        model: "画面模型",
        createdAt: Date.parse("2026-10-25T02:00:00.000Z"),
        origin: { type: "workbench", jobId: "job-1" },
      },
    ]);
  });

  it("skips unfinished jobs and hidden artifacts", () => {
    const artifact = (mediaId: string) => ({
      kind: "image" as const,
      mediaId,
      name: `${mediaId}.png`,
      mimeType: "image/png",
      size: 1,
    });
    const works = worksFromWorkbenchJobs(
      [
        job({ id: "running", status: "running", artifacts: [artifact("m-running")] }),
        job({ id: "done", artifacts: [artifact("m-keep"), artifact("m-hidden")] }),
      ],
      new Set(["done:m-hidden"]),
    );
    expect(works.map((item) => item.key)).toEqual(["m-keep"]);
  });

  it("falls back on model id, empty prompt, and zero for unparsable dates", () => {
    const [only] = worksFromWorkbenchJobs([
      job({
        modelId: "model-b",
        createdAt: "not a date",
        parameters: { prompt: 42 },
        artifacts: [
          { kind: "audio", mediaId: "a1", name: "a.mp3", mimeType: "audio/mpeg", size: 1 },
        ],
      }),
    ]);
    expect(only).toMatchObject({ model: "model-b", prompt: "", createdAt: 0 });
    expect(only?.media).toMatchObject({ width: null, height: null, durationMs: null });
  });
});

describe("worksFromLibraryItems", () => {
  it("keeps only generated canvas media with a known kind", () => {
    const item = (id: string, overrides: Partial<LibraryItemLike> = {}): LibraryItemLike => ({
      id,
      kind: "image",
      name: id,
      prompt: "  提示词  ",
      media: media(`media-${id}`),
      source: "canvas",
      createdAt: 7,
      updatedAt: 9,
      ...overrides,
    });
    const works = worksFromLibraryItems([
      item("generated"),
      item("uploaded", { source: "upload" }),
      item("empty", { media: null }),
      item("document", { media: media("media-doc", "application/pdf") }),
    ]);
    expect(works).toEqual([
      {
        key: "media-generated",
        kind: "image",
        media: media("media-generated"),
        prompt: "提示词",
        model: null,
        createdAt: 7,
        origin: { type: "library", assetId: "generated" },
      },
    ]);
  });
});

describe("mergeWorks", () => {
  it("deduplicates by media, keeping the richest origin and filling gaps", () => {
    const fromProject = work("m1", {
      prompt: "",
      model: null,
      createdAt: 100,
      origin: { type: "project", projectId: "p1", projectName: "项目", nodeId: "n1" },
    });
    const fromWorkbench = work("m1", {
      prompt: "工作台提示词",
      model: "model-a",
      createdAt: 200,
      origin: { type: "workbench", jobId: "job-1" },
    });
    const fromLibrary = work("m1", { prompt: "资产库提示词", createdAt: 50 });

    const [merged, ...rest] = mergeWorks([fromLibrary], [fromWorkbench], [fromProject]);
    expect(rest).toEqual([]);
    expect(merged).toEqual({
      ...fromProject,
      prompt: "工作台提示词",
      model: "model-a",
      createdAt: 200,
    });
  });

  it("backfills the prompt from a lower-ranked duplicate", () => {
    const [merged] = mergeWorks(
      [work("m1", { prompt: "", origin: { type: "workbench", jobId: "job-1" } })],
      [work("m1", { prompt: "资产库提示词" })],
    );
    expect(merged).toMatchObject({
      origin: { type: "workbench", jobId: "job-1" },
      prompt: "资产库提示词",
    });
  });

  it("sorts newest first with a stable tie-break on the key", () => {
    const merged = mergeWorks(
      [work("b", { createdAt: 10 }), work("a", { createdAt: 10 })],
      [work("c", { createdAt: 30 })],
    );
    expect(merged.map((item) => item.key)).toEqual(["c", "a", "b"]);
  });
});

describe("filterWorks", () => {
  const works = [
    work("img", { prompt: "Cyberpunk 城市", kind: "image" }),
    work("vid", {
      kind: "video",
      media: media("vid", "video/mp4", { name: "云海.mp4" }),
      model: "Seedance",
    }),
    work("aud", {
      kind: "audio",
      origin: { type: "project", projectId: "p", projectName: "配乐项目", nodeId: "n" },
    }),
  ];

  it("filters by kind", () => {
    expect(filterWorks(works, "all").map((item) => item.key)).toEqual(["img", "vid", "aud"]);
    expect(filterWorks(works, "video").map((item) => item.key)).toEqual(["vid"]);
  });

  it("matches prompt, file name, model and project name case-insensitively", () => {
    expect(filterWorks(works, "all", "  cyberPUNK ").map((item) => item.key)).toEqual(["img"]);
    expect(filterWorks(works, "all", "云海").map((item) => item.key)).toEqual(["vid"]);
    expect(filterWorks(works, "all", "seedance").map((item) => item.key)).toEqual(["vid"]);
    expect(filterWorks(works, "all", "配乐").map((item) => item.key)).toEqual(["aud"]);
    expect(filterWorks(works, "image", "配乐")).toEqual([]);
  });
});

describe("date grouping", () => {
  const startOfToday = new Date(2026, 9, 25).getTime();

  it("buckets timestamps by local calendar day", () => {
    expect(dateBucket(startOfToday, NOW)).toBe("today");
    expect(dateBucket(startOfToday - 1, NOW)).toBe("yesterday");
    expect(dateBucket(startOfToday - DAY, NOW)).toBe("yesterday");
    expect(dateBucket(startOfToday - DAY - 1, NOW)).toBe("week");
    expect(dateBucket(startOfToday - 6 * DAY, NOW)).toBe("week");
    expect(dateBucket(startOfToday - 6 * DAY - 1, NOW)).toBe("month");
    expect(dateBucket(startOfToday - 29 * DAY, NOW)).toBe("month");
    expect(dateBucket(startOfToday - 29 * DAY - 1, NOW)).toBe("earlier");
  });

  it("groups consecutive works and keeps the input order", () => {
    const groups = groupWorksByDate(
      [
        work("t1", { createdAt: NOW }),
        work("t2", { createdAt: startOfToday }),
        work("y1", { createdAt: startOfToday - HOUR }),
        work("e1", { createdAt: startOfToday - 90 * DAY }),
      ],
      NOW,
    );
    expect(
      groups.map((group) => [group.bucket, group.label, group.works.map((item) => item.key)]),
    ).toEqual([
      ["today", DATE_BUCKET_LABELS.today, ["t1", "t2"]],
      ["yesterday", DATE_BUCKET_LABELS.yesterday, ["y1"]],
      ["earlier", DATE_BUCKET_LABELS.earlier, ["e1"]],
    ]);
  });
});

describe("formatRelativeTime", () => {
  it("describes recent moments relatively", () => {
    expect(formatRelativeTime(0, NOW)).toBe("时间未知");
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("刚刚");
    // 时钟偏差导致的"未来时间"按刚刚处理。
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("刚刚");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(formatRelativeTime(NOW - 3 * HOUR, NOW)).toBe("3 小时前");
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe("2 天前");
  });

  it("falls back to a calendar date after a week, adding the year only when it differs", () => {
    expect(formatRelativeTime(new Date(2026, 9, 1, 12).getTime(), NOW)).toBe("10月1日");
    expect(formatRelativeTime(new Date(2025, 11, 31, 12).getTime(), NOW)).toBe("2025年12月31日");
  });
});

describe("formatBytes", () => {
  it("scales through binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1_024)).toBe("150 KB");
    expect(formatBytes(3.25 * 1_024 ** 3)).toBe("3.3 GB");
    expect(formatBytes(2 * 1_024 ** 5)).toBe("2048 TB");
  });
});

describe("formatDuration", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(59_600)).toBe("1:00");
  });
});

describe("greetingFor", () => {
  it("follows the hour of day", () => {
    const at = (hour: number) => greetingFor(new Date(2026, 9, 25, hour, 0));
    expect(at(2)).toBe("夜深了");
    expect(at(5)).toBe("早上好");
    expect(at(11)).toBe("中午好");
    expect(at(13)).toBe("下午好");
    expect(at(18)).toBe("晚上好");
    expect(at(23)).toBe("夜深了");
  });
});

describe("sortProjects", () => {
  const projects = [
    { id: "b", name: "Beta 海报", createdAt: 1, updatedAt: 30, nodeCount: 2 },
    { id: "a", name: "Alpha 分镜", createdAt: 3, updatedAt: 10, nodeCount: 5 },
    { id: "c", name: "Gamma 海报", createdAt: 2, updatedAt: 20, nodeCount: 0 },
  ];

  it("orders by updated, created or name without mutating the input", () => {
    expect(sortProjects(projects, "updated").map((project) => project.id)).toEqual(["b", "c", "a"]);
    expect(sortProjects(projects, "created").map((project) => project.id)).toEqual(["a", "c", "b"]);
    expect(sortProjects(projects, "name").map((project) => project.id)).toEqual(["a", "b", "c"]);
    expect(projects.map((project) => project.id)).toEqual(["b", "a", "c"]);
  });

  it("filters by name before sorting", () => {
    expect(sortProjects(projects, "updated", " 海报 ").map((project) => project.id)).toEqual([
      "b",
      "c",
    ]);
    expect(sortProjects(projects, "name", "alpha").map((project) => project.id)).toEqual(["a"]);
  });
});
