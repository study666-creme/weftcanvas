import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { publicModelCatalogSchema } from "@kachang/contracts";
import type { Pool } from "pg";
import { z } from "zod";

import { privateModelRouteSchema } from "./execution-route.js";

const storedCatalogSnapshotSchema = z.object({
  catalog: publicModelCatalogSchema,
  sourceModels: z.record(z.string(), z.string().min(1)),
  routes: z.record(z.string(), privateModelRouteSchema).default({}),
  videoAvailability: z.object({
    publicModelIds: z.array(z.string().min(1)),
    disabledModelIds: z.array(z.string().min(1)).default([]),
    validatedAt: z.number().int().nonnegative(),
  }).optional(),
  etag: z.string().min(1).optional(),
  validatedAt: z.number().int().nonnegative(),
  normalizationVersion: z.number().int().positive().optional(),
});

export type StoredCatalogSnapshot = z.infer<typeof storedCatalogSnapshotSchema>;

export interface CatalogSnapshotStore {
  load(): Promise<StoredCatalogSnapshot | null>;
  save(snapshot: StoredCatalogSnapshot): Promise<void>;
}

export class MemoryCatalogSnapshotStore implements CatalogSnapshotStore {
  snapshot: StoredCatalogSnapshot | null = null;

  async load() {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async save(snapshot: StoredCatalogSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }
}

export class JsonCatalogSnapshotStore implements CatalogSnapshotStore {
  constructor(private readonly filePath: string) {}

  async load() {
    try {
      return storedCatalogSnapshotSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      return null;
    }
  }

  async save(snapshot: StoredCatalogSnapshot) {
    const parsed = storedCatalogSnapshotSchema.parse(snapshot);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(parsed), "utf8");
    await rename(temporary, this.filePath);
  }
}

type CatalogSnapshotRow = { snapshot: unknown };

export class PostgresCatalogSnapshotStore implements CatalogSnapshotStore {
  constructor(private readonly pool: Pool) {}

  async load() {
    const result = await this.pool.query<CatalogSnapshotRow>(
      "SELECT snapshot FROM canvas_model_catalog_snapshots WHERE id = $1",
      ["default"],
    );
    const row = result.rows[0];
    return row ? storedCatalogSnapshotSchema.parse(row.snapshot) : null;
  }

  async save(snapshot: StoredCatalogSnapshot) {
    const parsed = storedCatalogSnapshotSchema.parse(snapshot);
    await this.pool.query(
      `INSERT INTO canvas_model_catalog_snapshots (id, snapshot, updated_at)
       VALUES ($1, $2::JSONB, NOW())
       ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
      ["default", JSON.stringify(parsed)],
    );
  }
}

export class ResilientCatalogSnapshotStore implements CatalogSnapshotStore {
  constructor(private readonly stores: readonly CatalogSnapshotStore[]) {}

  async load() {
    for (const store of this.stores) {
      try {
        const snapshot = await store.load();
        if (snapshot) return snapshot;
      } catch (cause) {
        console.error("Catalog snapshot load failed", cause);
      }
    }
    return null;
  }

  async save(snapshot: StoredCatalogSnapshot) {
    const results = await Promise.allSettled(this.stores.map((store) => store.save(snapshot)));
    if (results.some((result) => result.status === "fulfilled")) return;
    throw new AggregateError(
      results.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
      "No catalog snapshot store accepted the update",
    );
  }
}
