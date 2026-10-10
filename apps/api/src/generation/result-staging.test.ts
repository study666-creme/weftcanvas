import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonGenerationResultStagingStore } from "./result-staging.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generation result staging", () => {
  it("writes, validates, reads, and removes an opaque result reference", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonGenerationResultStagingStore(directory, {
      now: () => Date.parse("2026-07-15T10:00:00.000Z"),
      createId: () => "result_0001",
    });
    const reference = await store.write("job-1", {
      kind: "image",
      items: [{ source: "url", url: "https://media.example/result.png" }],
    });

    expect(reference).toBe("generation-result:result_0001");
    expect(await store.read(reference)).toMatchObject({
      version: 1,
      id: "result_0001",
      jobId: "job-1",
      result: { kind: "image" },
    });
    await store.remove(reference);
    await store.remove(reference);
    await expect(store.read(reference)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal references and oversized records", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonGenerationResultStagingStore(directory, {
      createId: () => "result_0002",
      maxRecordBytes: 200,
    });

    await expect(store.read("generation-result:../../secret")).rejects.toThrow("Invalid generation result reference");
    await expect(store.write("job-1", {
      kind: "text",
      text: "x".repeat(500),
    })).rejects.toThrow("too large");

    await writeFile(join(directory, "result_0003.json"), "x".repeat(300), "utf8");
    await expect(store.read("generation-result:result_0003")).rejects.toThrow("too large");
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "kachang-generation-results-"));
  directories.push(directory);
  return directory;
}
