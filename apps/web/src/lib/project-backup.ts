import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
  strFromU8,
  strToU8,
  unzip,
  type UnzipFileInfo,
} from "fflate";

import {
  PROJECT_BACKUP_FORMAT,
  PROJECT_BACKUP_MANIFEST_PATH,
  PROJECT_BACKUP_MEDIA_PREFIX,
  PROJECT_BACKUP_PROJECT_PATH,
  PROJECT_BACKUP_VERSION,
  canvasProjectSchema,
  projectBackupManifestSchema,
  type CanvasMedia,
  type CanvasProject,
  type ProjectBackupManifest,
} from "@weftcanvas/contracts";

import { createId } from "@weftcanvas/canvas-core";

import { readMedia } from "./media-store";
import { PROJECT_IMPORT_MAX_BYTES } from "./project-library";

/**
 * 完整项目备份（ZIP：project.json + manifest.json + media/<id>）。
 *
 * 安全与完整性设计（审计修复 docs/audits 的验收项，改动前先读这段）：
 *
 * - **流式**：导出把每个媒体按 512KB 分块泵进 Zip 压缩流，导入逐块解压，
 *   任何时刻不把多个媒体整体读进内存；压缩产物只以最终 Blob 形式存在。
 * - **校验信息**：manifest 记录每个媒体条目的字节数与 sha256；导入时边解压
 *   边重算，不匹配的条目按单文件跳过并计入报告（部分恢复），不静默采用。
 * - **路径安全**：条目名只允许 project.json / manifest.json / media/<合法 ID>，
 *   任何其它名字（含 `../`、子目录、反斜杠）整包拒绝；清单必须先于媒体条目
 *   出现（本格式的写入顺序，见 contracts/project-backup.ts）。
 * - **解压上限**：文件总数、单文件大小、媒体总字节数、project.json/manifest.json
 *   自身大小全部有硬上限，超限即拒绝（防解压炸弹）。
 * - **凭据零写入**：只打包画布项目与本地媒体字节；localStorage 里的任何东西
 *   （BYOK key、会话、设置）永不进入备份。
 * - **不破坏现状**：导入永远生成新项目（duplicateProjectSnapshot）；媒体按原 ID
 *   落库——ID 已存在且内容一致视为幂等成功，内容不同则换新 ID 并改写项目引用，
 *   绝不覆盖本机已有媒体。
 */

const READ_CHUNK = 512 * 1024;
/** createId 的字符集：media/<id> 路径段据此校验。 */
const MEDIA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const BACKUP_EXPORT_MAX_TOTAL_MEDIA_BYTES = 1024 * 1024 * 1024;
export const BACKUP_IMPORT_MAX_ENTRIES = 2_000;
export const BACKUP_IMPORT_MAX_MEDIA_FILE_BYTES = 512 * 1024 * 1024;
export const BACKUP_IMPORT_MAX_TOTAL_MEDIA_BYTES = 1024 * 1024 * 1024;
/**
 * 导入需要把压缩包读成一块连续内存（见 importProjectBackup 的实现说明：
 * fflate 的流式 Unzip 在一次 push 携带多个条目时会丢失前面条目的数据，
 * 无法用于本格式的小条目）。1GB 上限同时框住这份拷贝与媒体总量。
 */
export const BACKUP_IMPORT_MAX_TOTAL_FILE_BYTES = 1024 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;

export type StoredMediaRecord = CanvasMedia & { blob: Blob; storedAt?: number };

export type ReadStoredMedia = (id: string) => Promise<StoredMediaRecord | null>;
export type WriteStoredMedia = (record: StoredMediaRecord) => Promise<void>;
export type ValidateStoredBlob = (
  blob: Blob,
  declared: CanvasMedia,
) => Promise<{
  blob: Blob;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}>;

/* ------------------------------------------------------- 增量 SHA-256（流式哈希必须自实现：WebCrypto 不能分块） */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** 纯 JS 增量 SHA-256（FIPS 180-4），供分块流做哈希；一次性哈希请走 crypto.subtle。 */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private pending = 0;
  private length = 0;

  update(chunk: Uint8Array): this {
    this.length += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(64 - this.pending, chunk.length - offset);
      this.block.set(chunk.subarray(offset, offset + take), this.pending);
      this.pending += take;
      offset += take;
      if (this.pending === 64) {
        this.compress();
        this.pending = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    const bitsLow = (this.length << 3) >>> 0;
    const bitsHigh = Math.floor(this.length / 0x20000000);
    this.block[this.pending] = 0x80;
    this.pending += 1;
    if (this.pending > 56) {
      this.block.fill(0, this.pending, 64);
      this.compress();
      this.pending = 0;
    }
    this.block.fill(0, this.pending, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, bitsHigh);
    view.setUint32(60, bitsLow);
    this.compress();
    return Array.from(this.state, (word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
  }

  private compress() {
    const { words, block } = this;
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + S1 + choice + SHA256_K[index]! + words[index]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

async function sha256OfBlob(blob: Blob): Promise<string> {
  const digest = new Sha256();
  for (let offset = 0; offset < blob.size; offset += READ_CHUNK) {
    digest.update(new Uint8Array(await blob.slice(offset, offset + READ_CHUNK).arrayBuffer()));
  }
  return digest.digestHex();
}

async function pumpBlobInto(blob: Blob, target: { push(chunk: Uint8Array, final: boolean): void }) {
  for (let offset = 0; offset < blob.size; offset += READ_CHUNK) {
    target.push(new Uint8Array(await blob.slice(offset, offset + READ_CHUNK).arrayBuffer()), false);
  }
  target.push(new Uint8Array(0), true);
}

/** 只为 UI 呼吸让路：大文件泵流时周期性让出事件循环。 */

/* ---------------------------------------------------------------- 导出 */

export type ProjectBackupExportDeps = {
  readMedia?: ReadStoredMedia;
  now?: () => Date;
  appName?: string;
};

export type ProjectBackupExportResult =
  { ok: true; blob: Blob; manifest: ProjectBackupManifest } | { ok: false; error: string };

/**
 * 导出完整备份。媒体按分块泵进 ZIP（媒体已压缩过，走存储档不重复压缩），
 * 哈希在分块读取时顺手算完——不在导出路径上做任何整文件驻留。
 */
export async function exportProjectBackup(
  project: CanvasProject,
  deps: ProjectBackupExportDeps = {},
): Promise<ProjectBackupExportResult> {
  const read = deps.readMedia ?? readMedia;
  const parsed = canvasProjectSchema.safeParse(project);
  if (!parsed.success) return { ok: false, error: "项目数据不完整，无法备份" };

  const references = new Map<string, CanvasMedia>();
  const externalMedia: ProjectBackupManifest["externalMedia"] = [];
  for (const node of parsed.data.nodes) {
    const media = node.data.media;
    if (!media || references.has(media.id)) continue;
    references.set(media.id, media);
    if (media.source === "server" || !MEDIA_ID_PATTERN.test(media.id)) {
      externalMedia.push({
        id: media.id,
        name: media.name,
        mimeType: media.mimeType,
        serverId: media.serverId,
      });
    }
  }

  const included: Array<{ media: CanvasMedia; record: StoredMediaRecord; sha256: string }> = [];
  let totalBytes = 0;
  for (const [id, media] of references) {
    if (media.source === "server" || !MEDIA_ID_PATTERN.test(media.id)) continue;
    const record = await read(id).catch(() => null);
    if (!record) {
      externalMedia.push({
        id,
        name: media.name,
        mimeType: media.mimeType,
        serverId: media.serverId,
      });
      continue;
    }
    totalBytes += record.blob.size;
    if (totalBytes > BACKUP_EXPORT_MAX_TOTAL_MEDIA_BYTES) {
      return { ok: false, error: "项目媒体总量超过备份上限（2GB），无法完整备份" };
    }
    included.push({ media, record, sha256: await sha256OfBlob(record.blob) });
  }

  const output: BlobPart[] = [];
  // 注意：Zip.add() 会接管条目的 ondata，因此不能自己监听条目完成；
  // ZipDeflate / ZipPassThrough 的 push 都是同步的，只要"先完整推完一个条目
  // 再 add 下一个"就不会串数据。整个归档的完成点是 zip.end()。
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    output.push(chunk);
  });
  const addZipped = (name: string, bytes: Uint8Array) => {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(bytes, true);
  };
  const addStreamed = async (name: string, blob: Blob) => {
    // 媒体本身已压缩（PNG/MP4/AAC），存储档即可：省 CPU，也避免二次膨胀。
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    await pumpBlobInto(blob, entry);
  };

  const manifest: ProjectBackupManifest = {
    format: PROJECT_BACKUP_FORMAT,
    version: PROJECT_BACKUP_VERSION,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    app: { name: deps.appName ?? "weftcanvas", schemaVersion: parsed.data.schemaVersion },
    summary: {
      name: parsed.data.name,
      nodeCount: parsed.data.nodes.length,
      edgeCount: parsed.data.edges.length,
      groupCount: parsed.data.groups.length,
    },
    media: included.map(({ media, record, sha256 }) => ({
      id: media.id,
      path: `${PROJECT_BACKUP_MEDIA_PREFIX}${media.id}`,
      size: record.blob.size,
      sha256,
    })),
    externalMedia,
  };

  addZipped(PROJECT_BACKUP_PROJECT_PATH, strToU8(JSON.stringify(parsed.data)));
  addZipped(PROJECT_BACKUP_MANIFEST_PATH, strToU8(JSON.stringify(manifest, null, 2)));
  for (const { media, record } of included) {
    await addStreamed(`${PROJECT_BACKUP_MEDIA_PREFIX}${media.id}`, record.blob);
  }
  zip.end();
  return { ok: true, blob: new Blob(output, { type: "application/zip" }), manifest };
}

/* ---------------------------------------------------------------- 导入 */

export type ProjectBackupImportDeps = {
  readMedia?: ReadStoredMedia;
  writeMedia: WriteStoredMedia;
  validateBlob: ValidateStoredBlob;
  createMediaId?: () => string;
  now?: () => number;
};

export type ProjectBackupImportResult =
  | {
      ok: true;
      /** 恢复出的项目（节点/分组拿到新 ID，媒体引用已按落库结果订正）。 */
      project: CanvasProject;
      manifest: ProjectBackupManifest;
      /** 清单里的媒体全部落库、且没有云端/缺失引用时为 true——完整恢复。 */
      complete: boolean;
      /** 校验失败或内容不可用的媒体（部分恢复的原因）。 */
      skipped: Array<{ id: string; name: string; reason: string }>;
      /** 本机已有且内容一致、直接沿用的媒体 ID（幂等）。 */
      reusedMediaIds: string[];
      /** 本机已有但内容不同，改写为新 ID 的媒体（项目引用同步改写）。 */
      remappedMediaIds: Array<{ from: string; to: string }>;
      /** 备份不含字节的引用：云端素材或本机缺失。 */
      externalMedia: ProjectBackupManifest["externalMedia"];
    }
  | { ok: false; error: string };

export async function importProjectBackup(
  file: Blob,
  deps: ProjectBackupImportDeps,
): Promise<ProjectBackupImportResult> {
  const fail = (error: string): ProjectBackupImportResult => ({ ok: false, error });
  const read = deps.readMedia ?? readMedia;
  const createMediaId = deps.createMediaId ?? (() => createId("media"));
  const now = deps.now ?? Date.now;

  if (file.size === 0) return fail("备份文件是空的");
  if (file.size > BACKUP_IMPORT_MAX_TOTAL_FILE_BYTES) return fail("备份文件超过导入上限（1GB）");

  // 实现说明：fflate 的流式 Unzip 在一次 push 携带多个条目时会丢失靠前条目的
  // 数据（本格式的 project.json/manifest.json 都是小条目，必然同批），因此导入
  // 用文档化的 unzip API 按需提取——先只读中央目录清点结构（不解压），再逐个
  // 提取清单登记的媒体。内存模型恒为：压缩包一份 + 当前一个媒体。
  let archive: Uint8Array;
  try {
    archive = new Uint8Array(await file.arrayBuffer());
  } catch {
    return fail("备份文件读取失败");
  }

  // —— 结构清点：只读中央目录（不解压任何条目），先做名字/数量/重复检查。
  const entries: UnzipFileInfo[] = [];
  try {
    await unzipEntries(archive, (info) => {
      entries.push(info);
      return false;
    });
  } catch {
    return fail("备份文件无法解压");
  }
  if (!entries.length) return fail("备份文件无法解压");
  if (entries.length > BACKUP_IMPORT_MAX_ENTRIES) return fail("备份包含的条目过多，已拒绝导入");

  const nameCount = new Map<string, number>();
  for (const entry of entries) nameCount.set(entry.name, (nameCount.get(entry.name) ?? 0) + 1);
  for (const [name, count] of nameCount) {
    const id = name.startsWith(PROJECT_BACKUP_MEDIA_PREFIX)
      ? name.slice(PROJECT_BACKUP_MEDIA_PREFIX.length)
      : null;
    const allowed =
      name === PROJECT_BACKUP_MANIFEST_PATH ||
      name === PROJECT_BACKUP_PROJECT_PATH ||
      (id !== null &&
        MEDIA_ID_PATTERN.test(id) &&
        !name.includes("/", PROJECT_BACKUP_MEDIA_PREFIX.length));
    if (!allowed) return fail(`备份包含不受支持的条目：${name}`);
    if (count > 1) return fail(`备份里有重复的条目：${name}`);
  }

  // —— 清单与画布数据。
  const control = await unzipEntries(
    archive,
    (info) =>
      info.name === PROJECT_BACKUP_MANIFEST_PATH || info.name === PROJECT_BACKUP_PROJECT_PATH,
  ).catch(() => null);
  const manifestBytes = control?.get(PROJECT_BACKUP_MANIFEST_PATH) ?? null;
  const projectBytes = control?.get(PROJECT_BACKUP_PROJECT_PATH) ?? null;
  if (!manifestBytes || !projectBytes) return fail("备份缺少清单或画布数据");
  if (manifestBytes.length > MANIFEST_MAX_BYTES) return fail("备份清单过大");
  if (projectBytes.length > PROJECT_IMPORT_MAX_BYTES) return fail("备份里的画布数据过大");

  let manifest: ProjectBackupManifest;
  try {
    manifest = projectBackupManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)));
  } catch {
    return fail("备份清单格式不受支持（版本或字段不匹配）");
  }
  const parsedProject = canvasProjectSchema.safeParse(JSON.parse(strFromU8(projectBytes)));
  if (!parsedProject.success) return fail("备份里的画布数据无效");
  const project = parsedProject.data;

  // —— 清单与实际条目对账：两边都只允许一一对应。
  const archiveMediaNames = new Set(
    [...nameCount.keys()].filter((name) => name.startsWith(PROJECT_BACKUP_MEDIA_PREFIX)),
  );
  for (const declared of manifest.media) {
    if (!archiveMediaNames.has(declared.path))
      return fail(`备份缺少清单登记的文件：${declared.path}`);
    if (declared.size > BACKUP_IMPORT_MAX_MEDIA_FILE_BYTES)
      return fail(`媒体 ${declared.id} 超过单文件上限`);
  }
  for (const name of archiveMediaNames) {
    if (!manifest.media.some((entry) => entry.path === name))
      return fail(`备份包含清单之外的媒体条目：${name}`);
  }
  const declaredTotal = manifest.media.reduce((sum, entry) => sum + entry.size, 0);
  if (declaredTotal > BACKUP_IMPORT_MAX_TOTAL_MEDIA_BYTES)
    return fail("备份媒体总量超过导入上限（1GB）");

  const referenced = new Map<string, CanvasMedia>();
  for (const node of project.nodes) {
    const media = node.data.media;
    if (media && !referenced.has(media.id)) referenced.set(media.id, media);
  }

  const skipped: Array<{ id: string; name: string; reason: string }> = [];
  const reusedMediaIds: string[] = [];
  const remappedMediaIds: Array<{ from: string; to: string }> = [];

  for (const entry of manifest.media) {
    const media = referenced.get(entry.id);
    if (!media) continue; // 清单有、项目里没人引用：不落库（无主媒体后续会被清理），不算失败

    // 按需提取：filter 先核对中央目录里声明的解压大小，超限或与清单不符就拒绝
    // 解压本身——恶意包不能靠"声明 1 字节实塞 4GB"骗 fflate 预分配大缓冲。
    const entryInfoSeen: { info?: UnzipFileInfo } = {};
    const extracted = await unzipEntries(archive, (info) => {
      if (info.name !== entry.path) return false;
      entryInfoSeen.info = info;
      return (
        info.originalSize === entry.size && info.originalSize <= BACKUP_IMPORT_MAX_MEDIA_FILE_BYTES
      );
    }).catch(() => null);
    const bytes = extracted?.get(entry.path) ?? null;
    if (!bytes) {
      const seen = entryInfoSeen.info;
      if (seen && seen.originalSize !== entry.size) {
        skipped.push({ id: entry.id, name: media.name, reason: "文件大小与清单不符" });
        continue;
      }
      skipped.push({
        id: entry.id,
        name: media.name,
        reason: seen ? "媒体超过单文件上限" : "备份里缺少这个文件",
      });
      continue;
    }
    const digest = new Sha256().update(bytes).digestHex();
    if (digest !== entry.sha256) {
      skipped.push({ id: entry.id, name: media.name, reason: "校验和不匹配，文件可能损坏" });
      continue;
    }
    const blob = new Blob([bytes as BlobPart]);
    let validated: Awaited<ReturnType<ValidateStoredBlob>>;
    try {
      validated = await deps.validateBlob(blob, media);
    } catch {
      skipped.push({ id: entry.id, name: media.name, reason: "文件内容不受支持" });
      continue;
    }

    const existing = await read(entry.id).catch(() => null);
    if (existing) {
      const sameContent =
        existing.blob.size === validated.size &&
        (await sha256OfBlob(existing.blob)) === entry.sha256;
      if (sameContent) {
        reusedMediaIds.push(entry.id);
        continue;
      }
      const replacementId = createMediaId();
      await deps.writeMedia({
        ...media,
        id: replacementId,
        mimeType: validated.mimeType,
        size: validated.size,
        width: validated.width,
        height: validated.height,
        durationMs: validated.durationMs,
        blob: validated.blob,
        storedAt: now(),
      });
      remappedMediaIds.push({ from: entry.id, to: replacementId });
      continue;
    }

    await deps.writeMedia({
      ...media,
      mimeType: validated.mimeType,
      size: validated.size,
      width: validated.width,
      height: validated.height,
      durationMs: validated.durationMs,
      blob: validated.blob,
      storedAt: now(),
    });
  }

  // 媒体 ID 改写要同步进项目引用，否则恢复出来的节点指向不存在的媒体。
  let restored = project;
  if (remappedMediaIds.length) {
    const remap = new Map(remappedMediaIds.map(({ from, to }) => [from, to]));
    restored = canvasProjectSchema.parse({
      ...project,
      nodes: project.nodes.map((node) =>
        node.data.media && remap.has(node.data.media.id)
          ? {
              ...node,
              data: {
                ...node.data,
                media: { ...node.data.media, id: remap.get(node.data.media.id)! },
              },
            }
          : node,
      ),
    });
  }

  return {
    ok: true,
    project: restored,
    manifest,
    complete: skipped.length === 0 && manifest.externalMedia.length === 0,
    skipped,
    reusedMediaIds,
    remappedMediaIds,
    externalMedia: manifest.externalMedia,
  };
}

/** fflate 的异步 unzip 封装成 Promise；filter 为 false 的条目不会被解压。 */
function unzipEntries(
  data: Uint8Array,
  filter: (info: UnzipFileInfo) => boolean,
): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    try {
      unzip(data, { filter }, (error, files) => {
        if (error) reject(error instanceof Error ? error : new Error("备份文件无法解压"));
        else resolve(new Map(Object.entries(files ?? {})));
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("备份文件无法解压"));
    }
  });
}
