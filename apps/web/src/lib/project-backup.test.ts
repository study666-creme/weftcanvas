import {
  PROJECT_BACKUP_FORMAT,
  PROJECT_BACKUP_MANIFEST_PATH,
  PROJECT_BACKUP_PROJECT_PATH,
  PROJECT_BACKUP_VERSION,
  CANVAS_SCHEMA_VERSION,
  canvasProjectSchema,
  type CanvasProject,
} from "@weftcanvas/contracts";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  Sha256,
  exportProjectBackup,
  importProjectBackup,
  type StoredMediaRecord,
} from "./project-backup";

const IMAGE_MEDIA_ID = "media-11111111-1111-4111-8111-111111111111";
const VIDEO_MEDIA_ID = "media-22222222-2222-4222-8222-222222222222";

function bytesOf(text: string) {
  return strToU8(text);
}

/** 假图片字节：本测试只关心字节流转与校验，不关心真实解码（validateBlob 由注入实现）。 */
function mediaRecord(id: string, body: string, mimeType = "image/png"): StoredMediaRecord {
  const blob = new Blob([bytesOf(body)], { type: mimeType });
  return {
    id,
    name: `${id}.png`,
    mimeType,
    size: blob.size,
    source: "local",
    serverId: null,
    width: 32,
    height: 32,
    durationMs: null,
    blob,
    storedAt: 1,
  };
}

function createStore(initial: StoredMediaRecord[] = []) {
  const records = new Map(initial.map((record) => [record.id, record]));
  const writes: string[] = [];
  return {
    records,
    writes,
    read: async (id: string) => records.get(id) ?? null,
    write: async (record: StoredMediaRecord) => {
      writes.push(record.id);
      records.set(record.id, record);
    },
  };
}

const validateBlob = async (blob: Blob, declared: { mimeType: string }) => ({
  blob,
  mimeType: declared.mimeType,
  size: blob.size,
  width: 32,
  height: 32,
  durationMs: null,
});

function projectWithMedia(): CanvasProject {
  const nodeData = (media: CanvasProject["nodes"][number]["data"]["media"], title: string) => ({
    kind: "image" as const,
    title,
    body: "",
    accent: "jade",
    status: "success" as const,
    progress: null,
    media,
    directorCapture: null,
    config: null,
    edit: null,
    music: null,
    generation: {
      modelId: null,
      parameters: {},
      referenceImagePurposes: {},
      maxOutputTokens: null,
      referenceNodeIds: [],
      jobId: null,
      jobVersion: null,
      jobCreatedAt: null,
      jobStatus: null,
      error: null,
    },
    createdAt: 1,
    updatedAt: 1,
  });
  return canvasProjectSchema.parse({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id: "project-backup-test",
    name: "备份实验项目",
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 1,
    updatedAt: 1,
    edges: [
      { id: "edge-1", source: "node-1", target: "node-2", sourceHandle: null, targetHandle: null },
    ],
    groups: [],
    nodes: [
      {
        id: "node-1",
        type: "weftcanvas",
        position: { x: 0, y: 0 },
        data: nodeData({ ...mediaRecord(IMAGE_MEDIA_ID, "local-image-bytes"), size: 18 }, "本地图"),
      },
      {
        id: "node-2",
        type: "weftcanvas",
        position: { x: 120, y: 0 },
        data: nodeData(
          {
            id: VIDEO_MEDIA_ID,
            name: "cloud.mp4",
            mimeType: "video/mp4",
            size: 12_000,
            source: "server",
            serverId: "server-media-9",
            width: null,
            height: null,
            durationMs: null,
          },
          "云端图",
        ),
      },
    ],
  });
}

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    format: PROJECT_BACKUP_FORMAT,
    version: PROJECT_BACKUP_VERSION,
    createdAt: "2026-10-16T00:00:00.000Z",
    app: { name: "weftcanvas", schemaVersion: CANVAS_SCHEMA_VERSION },
    summary: { name: "备份实验项目", nodeCount: 2, edgeCount: 1, groupCount: 0 },
    media: [],
    externalMedia: [],
    ...overrides,
  };
}

describe("Sha256", () => {
  it("matches the published NIST vectors and the whole-buffer digest", async () => {
    expect(new Sha256().digestHex()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(new Sha256().update(bytesOf("abc")).digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const long = bytesOf("a".repeat(1_000_000));
    const chunked = new Sha256();
    for (let offset = 0; offset < long.length; offset += 3_333) {
      chunked.update(long.subarray(offset, offset + 3_333));
    }
    const expected = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", long.buffer as ArrayBuffer)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(chunked.digestHex()).toBe(expected);
  });
});

describe("exportProjectBackup", () => {
  it("packs the canvas, the local media bytes and a verifiable manifest", async () => {
    const store = createStore([mediaRecord(IMAGE_MEDIA_ID, "local-image-bytes")]);
    const result = await exportProjectBackup(projectWithMedia(), {
      readMedia: store.read,
      now: () => new Date("2026-10-16T12:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 云端素材如实标注为"未包含"，不当成完整备份。
    expect(result.manifest.externalMedia).toEqual([
      {
        id: VIDEO_MEDIA_ID,
        name: "cloud.mp4",
        mimeType: "video/mp4",
        serverId: "server-media-9",
      },
    ]);
    expect(result.manifest.media).toHaveLength(1);
    expect(result.manifest.media[0]?.id).toBe(IMAGE_MEDIA_ID);
    expect(result.manifest.media[0]?.path).toBe(`media/${IMAGE_MEDIA_ID}`);
    expect(result.manifest.summary).toMatchObject({ nodeCount: 2, edgeCount: 1 });
    expect(result.manifest.createdAt).toBe("2026-10-16T12:00:00.000Z");

    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const manifestFromZip = JSON.parse(strFromU8(entries[PROJECT_BACKUP_MANIFEST_PATH]!));
    expect(manifestFromZip).toEqual(result.manifest);
    const projectFromZip = JSON.parse(strFromU8(entries[PROJECT_BACKUP_PROJECT_PATH]!));
    expect(projectFromZip.nodes).toHaveLength(2);
    // 备份里只有画布与媒体：没有任何 localStorage 侧的东西（BYOK key / 会话）。
    const serialized =
      JSON.stringify(manifestFromZip) + strFromU8(entries[PROJECT_BACKUP_PROJECT_PATH]!);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("custom-api");
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("weftcanvas_session");
    // 媒体字节与清单哈希一致。
    const digest = new Sha256().update(entries[`media/${IMAGE_MEDIA_ID}`]!).digestHex();
    expect(digest).toBe(result.manifest.media[0]?.sha256);
  });

  it("streams media larger than one read chunk without losing bytes", async () => {
    const big = `big-${"x".repeat(1_400_000)}`;
    const store = createStore([mediaRecord(IMAGE_MEDIA_ID, big)]);
    const result = await exportProjectBackup(projectWithMedia(), { readMedia: store.read });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const stored = entries[`media/${IMAGE_MEDIA_ID}`]!;
    expect(strFromU8(stored)).toBe(big);
    expect(result.manifest.media[0]?.size).toBe(bytesOf(big).length);
  });
});

describe("importProjectBackup", () => {
  async function roundTrip() {
    const store = createStore([mediaRecord(IMAGE_MEDIA_ID, "local-image-bytes")]);
    const exported = await exportProjectBackup(projectWithMedia(), { readMedia: store.read });
    if (!exported.ok) throw new Error(exported.error);
    return exported.blob;
  }

  it("restores a full backup into an empty store and reports completeness", async () => {
    const blob = await roundTrip();
    const target = createStore();
    const result = await importProjectBackup(blob, {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes).toHaveLength(2);
    expect(result.project.edges).toHaveLength(1);
    expect(result.project.id).toBe("project-backup-test");
    // 媒体按原 ID 落库，节点引用还指着它。
    expect(target.records.get(IMAGE_MEDIA_ID)).toBeDefined();
    expect(result.project.nodes[0]?.data.media?.id).toBe(IMAGE_MEDIA_ID);
    expect(result.reusedMediaIds).toEqual([]);
    expect(result.remappedMediaIds).toEqual([]);
    // 云端引用没进备份 → 不是完整恢复，但如实报出来。
    expect(result.externalMedia.map((entry) => entry.id)).toEqual([VIDEO_MEDIA_ID]);
    expect(result.complete).toBe(false);
    expect(result.skipped).toEqual([]);
  });

  it("keeps an existing identical media record (idempotent) and never overwrites", async () => {
    const blob = await roundTrip();
    const existing = mediaRecord(IMAGE_MEDIA_ID, "local-image-bytes");
    const target = createStore([existing]);
    const result = await importProjectBackup(blob, {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reusedMediaIds).toEqual([IMAGE_MEDIA_ID]);
    expect(target.writes).toEqual([]);
    expect(target.records.get(IMAGE_MEDIA_ID)).toBe(existing);
  });

  it("moves a conflicting media id to a fresh id and rewrites the project reference", async () => {
    const blob = await roundTrip();
    const target = createStore([mediaRecord(IMAGE_MEDIA_ID, "different-bytes-entirely")]);
    const result = await importProjectBackup(blob, {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
      createMediaId: () => "media-new-id",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remappedMediaIds).toEqual([{ from: IMAGE_MEDIA_ID, to: "media-new-id" }]);
    expect(result.project.nodes[0]?.data.media?.id).toBe("media-new-id");
    // 原有媒体没有被覆盖。
    expect(
      strFromU8(new Uint8Array(await target.records.get(IMAGE_MEDIA_ID)!.blob.arrayBuffer())),
    ).toBe("different-bytes-entirely");
    expect(target.records.get("media-new-id")).toBeDefined();
  });

  it("skips a media whose bytes do not match the manifest checksum", async () => {
    // 长度与清单一致、内容不同：只有哈希校验能发现（大小预检放行）。
    const tampered = zipSync({
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(
        JSON.stringify(
          validManifest({
            media: [
              {
                id: IMAGE_MEDIA_ID,
                path: `media/${IMAGE_MEDIA_ID}`,
                size: bytesOf("original-bytes").length,
                sha256: new Sha256().update(bytesOf("original-bytes")).digestHex(),
              },
            ],
          }),
        ),
      ),
      [`media/${IMAGE_MEDIA_ID}`]: strToU8("tampered-bytez"),
    });
    const target = createStore();
    const result = await importProjectBackup(new Blob([tampered]), {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.complete).toBe(false);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("校验和");
    expect(target.records.size).toBe(0);
    // 项目本身仍然恢复（用户拿到画布，坏素材如实标出）。
    expect(result.project.nodes).toHaveLength(2);
  });

  it("skips a media whose size does not match the manifest", async () => {
    const body = bytesOf("short");
    const crafted = zipSync({
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(
        JSON.stringify(
          validManifest({
            media: [
              {
                id: IMAGE_MEDIA_ID,
                path: `media/${IMAGE_MEDIA_ID}`,
                size: 999_999,
                sha256: new Sha256().update(body).digestHex(),
              },
            ],
          }),
        ),
      ),
      [`media/${IMAGE_MEDIA_ID}`]: body,
    });
    const target = createStore();
    const result = await importProjectBackup(new Blob([crafted]), {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped[0]?.reason).toContain("大小");
    expect(result.complete).toBe(false);
  });

  it("skips media whose content fails validation", async () => {
    const blob = await roundTrip();
    const target = createStore();
    const result = await importProjectBackup(blob, {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob: async () => {
        throw new Error("unsupported content");
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped[0]?.reason).toContain("不受支持");
    expect(target.records.size).toBe(0);
  });

  it("rejects archives with path traversal or unlisted entries", async () => {
    const traversal = zipSync({
      "../outside.txt": strToU8("nope"),
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(JSON.stringify(validManifest())),
    });
    const nested = zipSync({
      [`media/${IMAGE_MEDIA_ID}/nested`]: strToU8("nope"),
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(JSON.stringify(validManifest())),
    });
    const unlisted = zipSync({
      "notes.txt": strToU8("nope"),
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(JSON.stringify(validManifest())),
    });
    const undeclaredMedia = zipSync({
      [`media/${IMAGE_MEDIA_ID}`]: bytesOf("sneaky"),
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(JSON.stringify(validManifest())),
    });
    const target = createStore();
    const deps = {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
    };
    const cases: Array<[Uint8Array, RegExp]> = [
      [traversal, /不受支持的条目|清单之外的媒体/],
      [nested, /不受支持的条目|清单之外的媒体/],
      [unlisted, /不受支持的条目|清单之外的媒体/],
      // 清单之外的媒体条目：无论是恶意注入还是清单损坏，一律拒绝。
      [undeclaredMedia, /清单之外的媒体/],
    ];
    for (const [crafted, pattern] of cases) {
      const result = await importProjectBackup(new Blob([crafted as BlobPart]), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(pattern);
    }
    expect(target.records.size).toBe(0);
  });

  it("rejects a manifest with an unsupported version", async () => {
    const crafted = zipSync({
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(JSON.stringify(validManifest({ version: 99 }))),
    });
    const target = createStore();
    const result = await importProjectBackup(new Blob([crafted]), {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("版本或字段");
  });

  it("rejects archives that are missing the manifest or the canvas", async () => {
    const onlyProject = zipSync({
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
    });
    const onlyManifest = zipSync({
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(JSON.stringify(validManifest())),
    });
    const target = createStore();
    const deps = { readMedia: target.read, writeMedia: target.write, validateBlob };
    for (const crafted of [onlyProject, onlyManifest]) {
      const result = await importProjectBackup(new Blob([crafted]), deps);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a non-zip payload instead of throwing", async () => {
    const target = createStore();
    const result = await importProjectBackup(new Blob([bytesOf("definitely not a zip")]), {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
    });
    expect(result.ok).toBe(false);
    expect(target.records.size).toBe(0);
  });

  it("restores regardless of ZIP entry order", async () => {
    // 导入按中央目录清点结构、按需提取，不依赖条目顺序（导出侧仍按
    // project → manifest → media 的约定顺序写）。
    const body = bytesOf("local-image-bytes");
    const reordered = zipSync({
      [`media/${IMAGE_MEDIA_ID}`]: body,
      [PROJECT_BACKUP_MANIFEST_PATH]: strToU8(
        JSON.stringify(
          validManifest({
            media: [
              {
                id: IMAGE_MEDIA_ID,
                path: `media/${IMAGE_MEDIA_ID}`,
                size: body.length,
                sha256: new Sha256().update(body).digestHex(),
              },
            ],
          }),
        ),
      ),
      [PROJECT_BACKUP_PROJECT_PATH]: strToU8(JSON.stringify(projectWithMedia())),
    });
    const target = createStore();
    const result = await importProjectBackup(new Blob([reordered]), {
      readMedia: target.read,
      writeMedia: target.write,
      validateBlob,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toEqual([]);
    expect(target.records.get(IMAGE_MEDIA_ID)).toBeDefined();
  });
});
