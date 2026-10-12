import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemMediaObjectStore } from "./filesystem-object-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("filesystem media object store", () => {
  it("streams an exact-size object atomically and returns its digest", async () => {
    const directory = await temporaryDirectory();
    const store = new FilesystemMediaObjectStore(directory);
    const bytes = Buffer.from("reference-media");

    const result = await store.write("media/aa/item", chunks(bytes, 3), {
      expectedSize: bytes.length,
      maxBytes: 1024,
    });

    expect(result).toEqual({
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await expect(
      store.withLocalFile("media/aa/item", (path) => readFile(path, "utf8")),
    ).resolves.toBe("reference-media");
  });

  it("supports bounded reads and rejects traversal keys", async () => {
    const directory = await temporaryDirectory();
    const store = new FilesystemMediaObjectStore(directory);
    await store.write("media/bb/item", chunks(Buffer.from("0123456789")), {
      expectedSize: 10,
      maxBytes: 10,
    });

    const opened = await store.open("media/bb/item", { start: 2, end: 5 });
    expect(await collect(opened.stream)).toEqual(Buffer.from("2345"));
    expect(opened).toMatchObject({ totalSize: 10, start: 2, end: 5 });
    await expect(store.open("media/bb/item", { start: 5, end: 20 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(store.withLocalFile("../outside", async () => undefined)).rejects.toThrow(
      "Invalid media object key",
    );
  });

  it("removes temporary data when size limits or expected length fail", async () => {
    const directory = await temporaryDirectory();
    const store = new FilesystemMediaObjectStore(directory);

    await expect(
      store.write("media/cc/large", chunks(Buffer.alloc(20)), {
        expectedSize: 20,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE", definitive: true });
    await expect(
      store.write("media/cc/short", chunks(Buffer.alloc(5)), {
        expectedSize: 6,
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_SIZE_MISMATCH", definitive: true });
    await expect(store.open("media/cc/large")).rejects.toThrow();
    await expect(store.open("media/cc/short")).rejects.toThrow();
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "weftcanvas-media-store-"));
  directories.push(directory);
  return directory;
}

async function* chunks(bytes: Buffer, size = bytes.length) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}

async function collect(stream: NodeJS.ReadableStream) {
  const values: Buffer[] = [];
  for await (const chunk of stream) values.push(Buffer.from(chunk));
  return Buffer.concat(values);
}
