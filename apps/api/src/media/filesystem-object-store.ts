import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { MediaObjectWriteError, type MediaObjectStore } from "./types.js";

export class FilesystemMediaObjectStore implements MediaObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async write(
    key: string,
    source: AsyncIterable<Uint8Array>,
    options: { expectedSize: number; maxBytes: number },
  ) {
    const target = this.filePath(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > options.maxBytes) {
          callback(new MediaObjectWriteError("MEDIA_TOO_LARGE", "素材大小超过当前限制", true));
          return;
        }
        hash.update(bytes);
        callback(null, bytes);
      },
    });

    try {
      await pipeline(
        Readable.from(source),
        meter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (size !== options.expectedSize) {
        throw new MediaObjectWriteError("MEDIA_SIZE_MISMATCH", "上传内容大小与文件信息不一致", true);
      }
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rename(temporary, target);
      return { size, sha256: hash.digest("hex") };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (error instanceof MediaObjectWriteError) throw error;
      throw new MediaObjectWriteError("MEDIA_UPLOAD_INTERRUPTED", "素材上传中断，请重试", false);
    }
  }

  async withLocalFile<T>(key: string, action: (path: string) => Promise<T>) {
    const path = this.filePath(key);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("Media object is not a regular file");
    return action(path);
  }

  async open(key: string, range?: { start: number; end: number }, _signal?: AbortSignal) {
    const path = this.filePath(key);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("Media object is not a regular file");
    const totalSize = metadata.size;
    const start = range?.start ?? 0;
    const end = range?.end ?? totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= totalSize) {
      throw new RangeError("Requested media range is invalid");
    }
    return { stream: createReadStream(path, { start, end }), totalSize, start, end };
  }

  async remove(key: string) {
    await unlink(this.filePath(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private filePath(key: string) {
    const segments = key.split("/");
    if (!segments.length || segments.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment))) {
      throw new Error("Invalid media object key");
    }
    const target = resolve(this.root, ...segments);
    if (!target.startsWith(`${this.root}${sep}`)) throw new Error("Media object key escaped the storage root");
    return target;
  }
}
