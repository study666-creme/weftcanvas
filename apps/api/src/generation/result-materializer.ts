import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { MediaKind } from "@weftcanvas/contracts";

import { MediaInspectionError, type InspectedMedia, type MediaInspector } from "../media/types.js";
import type { StagedGenerationResult } from "./result-staging.js";

type ImageSource = Extract<StagedGenerationResult, { kind: "image" }>["items"][number];
type RemoteSource = { source: "url"; url: string };

export type MaterializedGenerationMedia = {
  path: string;
  size: number;
  sha256: string;
  inspected: InspectedMedia;
  open(): AsyncIterable<Uint8Array>;
  remove(): Promise<void>;
};

type ResultMaterializerOptions = {
  directory: string;
  inspector: MediaInspector;
  allowedHosts: readonly string[];
  fetch?: typeof globalThis.fetch;
  createId?: () => string;
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  limits?: Partial<Record<MediaKind, number>>;
};

const DEFAULT_LIMITS: Record<MediaKind, number> = {
  image: 25 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
};

export class GenerationMediaMaterializationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GenerationMediaMaterializationError";
  }
}

export class GenerationResultMaterializer {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly createId: () => string;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly limits: Record<MediaKind, number>;
  private readonly allowedHosts: readonly string[];

  constructor(private readonly options: ResultMaterializerOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.createId = options.createId ?? randomUUID;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 2 * 60_000, "timeoutMs");
    this.maxRedirects = nonNegativeInteger(options.maxRedirects ?? 2, "maxRedirects");
    this.limits = {
      image: positiveInteger(options.limits?.image ?? DEFAULT_LIMITS.image, "image limit"),
      video: positiveInteger(options.limits?.video ?? DEFAULT_LIMITS.video, "video limit"),
      audio: positiveInteger(options.limits?.audio ?? DEFAULT_LIMITS.audio, "audio limit"),
    };
    this.allowedHosts = options.allowedHosts.map(normalizeHostRule);
  }

  async materialize(
    source: ImageSource | RemoteSource,
    kind: MediaKind,
  ): Promise<MaterializedGenerationMedia> {
    const id = this.createId();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error("Generated material id is invalid");
    const target = resolve(this.options.directory, `${id}.media`);
    await mkdir(dirname(target), { recursive: true });
    try {
      const written =
        source.source === "base64"
          ? await this.writeBase64(target, source.data, this.limits[kind])
          : await this.download(target, source.url, this.limits[kind]);
      let inspected: InspectedMedia;
      try {
        inspected = await this.options.inspector.inspect(target, kind);
      } catch (error) {
        if (error instanceof MediaInspectionError) {
          throw new GenerationMediaMaterializationError(error.code, error.message, false);
        }
        throw error;
      }
      if (inspected.kind !== kind || inspected.size !== written.size) {
        throw new GenerationMediaMaterializationError(
          "RESULT_MEDIA_MISMATCH",
          "生成结果校验不一致",
          false,
        );
      }
      return {
        path: target,
        size: written.size,
        sha256: written.sha256,
        inspected,
        open: () => createReadStream(target),
        remove: () => removeFile(target),
      };
    } catch (error) {
      await removeFile(target);
      if (error instanceof GenerationMediaMaterializationError) throw error;
      throw new GenerationMediaMaterializationError(
        "RESULT_MEDIA_UNAVAILABLE",
        "生成结果暂时无法保存",
        true,
      );
    }
  }

  private async writeBase64(target: string, value: string, maxBytes: number) {
    const normalized = normalizeBase64(value);
    const estimatedBytes = Buffer.byteLength(normalized, "base64");
    if (estimatedBytes > maxBytes) throw tooLarge();
    const bytes = Buffer.from(normalized, "base64");
    if (!bytes.length || bytes.length > maxBytes) throw tooLarge();
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  private async download(target: string, value: string, maxBytes: number) {
    let url = this.safeUrl(value);
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          headers: {
            Accept: "image/*, video/*, audio/*",
            "Accept-Encoding": "identity",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new GenerationMediaMaterializationError(
          "RESULT_DOWNLOAD_UNAVAILABLE",
          "暂时无法下载生成结果",
          true,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirect === this.maxRedirects) {
          throw new GenerationMediaMaterializationError(
            "RESULT_REDIRECT_INVALID",
            "生成结果下载地址无效",
            false,
          );
        }
        url = this.safeUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        await response.body?.cancel().catch(() => undefined);
        throw new GenerationMediaMaterializationError(
          retryable ? "RESULT_DOWNLOAD_UNAVAILABLE" : "RESULT_DOWNLOAD_REJECTED",
          retryable ? "暂时无法下载生成结果" : "生成结果下载失败",
          retryable,
        );
      }
      const declaredLength = response.headers.get("Content-Length");
      if (declaredLength) {
        if (!/^\d+$/.test(declaredLength)) {
          throw new GenerationMediaMaterializationError(
            "RESULT_LENGTH_INVALID",
            "生成结果大小信息无效",
            false,
          );
        }
        const parsedLength = Number(declaredLength);
        if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) throw tooLarge();
      }
      if (!response.body)
        throw new GenerationMediaMaterializationError(
          "RESULT_BODY_EMPTY",
          "生成结果内容为空",
          false,
        );
      return writeStream(
        target,
        response.body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
        maxBytes,
      );
    }
    throw new GenerationMediaMaterializationError(
      "RESULT_REDIRECT_INVALID",
      "生成结果下载地址无效",
      false,
    );
  }

  private safeUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new GenerationMediaMaterializationError(
        "RESULT_URL_INVALID",
        "生成结果地址无效",
        false,
      );
    }
    if (url.username || url.password)
      throw new GenerationMediaMaterializationError(
        "RESULT_URL_INVALID",
        "生成结果地址无效",
        false,
      );
    const localHttp =
      this.options.allowInsecureLocalhost &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) {
      throw new GenerationMediaMaterializationError(
        "RESULT_URL_INSECURE",
        "生成结果地址不安全",
        false,
      );
    }
    if (url.port && url.port !== "443" && !localHttp) {
      throw new GenerationMediaMaterializationError(
        "RESULT_URL_INVALID",
        "生成结果地址端口无效",
        false,
      );
    }
    if (!this.allowedHosts.some((rule) => hostMatches(url.hostname, rule))) {
      throw new GenerationMediaMaterializationError(
        "RESULT_HOST_NOT_ALLOWED",
        "生成结果地址未通过安全校验",
        false,
      );
    }
    url.hash = "";
    return url;
  }
}

async function writeStream(target: string, source: AsyncIterable<Uint8Array>, maxBytes: number) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        callback(tooLarge());
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
    if (!size)
      throw new GenerationMediaMaterializationError("RESULT_BODY_EMPTY", "生成结果内容为空", false);
    await rename(temporary, target);
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    await removeFile(temporary);
    throw error;
  }
}

function normalizeBase64(value: string) {
  const unpadded = value.replace(/=+$/, "");
  if (!unpadded || !/^[A-Za-z0-9+/]+$/.test(unpadded)) {
    throw new GenerationMediaMaterializationError(
      "RESULT_BASE64_INVALID",
      "生成图片内容无效",
      false,
    );
  }
  const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  const decoded = Buffer.from(padded, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new GenerationMediaMaterializationError(
      "RESULT_BASE64_INVALID",
      "生成图片内容无效",
      false,
    );
  }
  return padded;
}

function normalizeHostRule(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?:\*\.)?[a-z0-9.-]+$/.test(normalized) || normalized.includes("..")) {
    throw new Error(`Invalid generation media host rule: ${value}`);
  }
  return normalized;
}

function hostMatches(hostname: string, rule: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!rule.startsWith("*.")) return host === rule;
  const suffix = rule.slice(1);
  return host.endsWith(suffix) && host.length > suffix.length;
}

function tooLarge() {
  return new GenerationMediaMaterializationError(
    "RESULT_MEDIA_TOO_LARGE",
    "生成结果大小超过当前限制",
    false,
  );
}

async function removeFile(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
