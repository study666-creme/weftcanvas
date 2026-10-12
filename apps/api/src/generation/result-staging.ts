import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

const providerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

const stagedImageSourceSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("url"),
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://") || value.startsWith("http://")),
    revisedPrompt: z.string().optional(),
  }),
  z.object({
    source: z.literal("base64"),
    data: z.string().min(1).max(100_000_000),
    mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i),
    revisedPrompt: z.string().optional(),
  }),
]);

export const stagedGenerationResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1),
    usage: providerUsageSchema.optional(),
  }),
  z.object({
    kind: z.literal("image"),
    items: z.array(stagedImageSourceSchema).min(1).max(8),
    usage: providerUsageSchema.optional(),
  }),
  z.object({
    kind: z.literal("video"),
    taskId: z.string().min(1),
    url: z
      .string()
      .url()
      .max(4096)
      .refine((value) => value.startsWith("https://") || value.startsWith("http://")),
  }),
]);
export type StagedGenerationResult = z.infer<typeof stagedGenerationResultSchema>;

const stagedGenerationRecordSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  jobId: z.string().min(1),
  result: stagedGenerationResultSchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type StagedGenerationRecord = z.infer<typeof stagedGenerationRecordSchema>;

export interface GenerationResultStagingStore {
  write(jobId: string, result: StagedGenerationResult): Promise<string>;
  read(reference: string): Promise<StagedGenerationRecord>;
  remove(reference: string): Promise<void>;
}

export class JsonGenerationResultStagingStore implements GenerationResultStagingStore {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxRecordBytes: number;

  constructor(
    private readonly directory: string,
    options: { now?: () => number; createId?: () => string; maxRecordBytes?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.maxRecordBytes = options.maxRecordBytes ?? 110 * 1024 * 1024;
  }

  async write(jobId: string, value: StagedGenerationResult) {
    const id = safeId(this.createId());
    const record = stagedGenerationRecordSchema.parse({
      version: 1,
      id,
      jobId,
      result: value,
      createdAt: new Date(this.now()).toISOString(),
    });
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > this.maxRecordBytes)
      throw new Error("Staged generation result is too large");
    await mkdir(this.directory, { recursive: true });
    const target = this.filePath(id);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return `generation-result:${id}`;
  }

  async read(reference: string) {
    const id = parseReference(reference);
    const target = this.filePath(id);
    const metadata = await stat(target);
    if (metadata.size > this.maxRecordBytes)
      throw new Error("Staged generation result is too large");
    return stagedGenerationRecordSchema.parse(JSON.parse(await readFile(target, "utf8")));
  }

  async remove(reference: string) {
    await unlink(this.filePath(parseReference(reference))).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private filePath(id: string) {
    return resolve(this.directory, `${safeId(id)}.json`);
  }
}

function parseReference(reference: string) {
  const match = /^generation-result:([A-Za-z0-9_-]{8,128})$/.exec(reference);
  if (!match?.[1]) throw new Error("Invalid generation result reference");
  return safeId(match[1]);
}

function safeId(value: string) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error("Invalid generation result id");
  return value;
}
