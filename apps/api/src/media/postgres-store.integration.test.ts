import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../database/migrate.js";
import { PostgresMediaMetadataStore } from "./postgres-store.js";
import type { MediaRecord } from "./types.js";

const databaseUrl = process.env.CANVAS_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("CANVAS_TEST_DATABASE_URL must name a dedicated database containing 'test'");
}
const NOW = "2026-07-15T18:00:00.000Z";
const USER_ID = "99999999-9999-4999-8999-999999999999";

describe.skipIf(!databaseUrl)("PostgreSQL media metadata store", { timeout: 120_000 }, () => {
  let pool: Pool;
  let store: PostgresMediaMetadataStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await runMigrations(pool);
    store = new PostgresMediaMetadataStore(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE canvas_storage_grace, canvas_media, canvas_users CASCADE");
    await seedUser(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists idempotent upload intent and a revisioned ready transition", async () => {
    const record = pendingMedia();
    const [first, second] = await Promise.all([store.create(record), store.create(record)]);
    expect([first.kind, second.kind].sort()).toEqual(["created", "existing"]);

    const claimed = await store.claimUpload(record.id, USER_ID, 0, "2026-07-15T18:00:01.000Z");
    expect(claimed).toMatchObject({ status: "uploading", revision: 1 });
    const ready: MediaRecord = {
      ...claimed!,
      detectedMimeType: "image/png",
      size: 1024,
      sha256: "a".repeat(64),
      width: 64,
      height: 36,
      status: "ready",
      revision: 2,
      updatedAt: "2026-07-15T18:00:02.000Z",
      readyAt: "2026-07-15T18:00:02.000Z",
    };
    expect(await store.markReady(ready, 1)).toMatchObject({ status: "ready", revision: 2 });
    expect(await store.getById(record.id)).toEqual(ready);
  });

  it("allows only one upload claimant and rejects immutable mutations", async () => {
    const record = pendingMedia();
    await store.create(record);
    const claims = await Promise.all([
      store.claimUpload(record.id, USER_ID, 0, "2026-07-15T18:00:01.000Z"),
      store.claimUpload(record.id, USER_ID, 0, "2026-07-15T18:00:01.000Z"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean)!;
    const failed: MediaRecord = {
      ...claimed,
      objectKey: "media/changed/key",
      status: "failed",
      error: { code: "TEST", message: "test" },
      revision: claimed.revision + 1,
      updatedAt: "2026-07-15T18:00:02.000Z",
    };
    await expect(store.markFailed(failed, claimed.revision)).rejects.toThrow(
      "Immutable media fields",
    );
  });

  it("evicts the oldest unbound ready media when the quota would be exceeded", async () => {
    const MIB = 1024 * 1024;
    const ids = await seedReadyMedia(store, 5, 40 * MIB);
    const quota = mediaQuota(150 * MIB);
    const next = {
      ...pendingMedia(),
      id: randomUUID(),
      idempotencyKey: "postgres:media:quota-overflow",
      objectKey: "media/quota/overflow",
      source: "generation" as const,
      expectedSize: 10 * MIB,
    };
    const result = await store.create(next, quota);
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.evicted?.length).toBe(2);
    expect(result.evicted?.map((item) => item.id).sort()).toEqual(ids.slice(0, 2).sort());
    expect(await store.getById(ids[0]!)).toBeNull();
    expect(await store.getById(ids[2]!)).not.toBeNull();
    expect(await store.getById(next.id)).not.toBeNull();
  });

  it("never evicts ready media still bound to a cloud project", async () => {
    const MIB = 1024 * 1024;
    const [boundId, ...rest] = await seedReadyMedia(store, 3, 40 * MIB);
    await seedProject(pool, "test-project");
    await pool.query(
      `INSERT INTO canvas_media_project_bindings (owner_id, project_id, media_id, created_at)
       VALUES ($1, $2, $3, $4)`,
      [USER_ID, "test-project", boundId, NOW],
    );
    const quota = mediaQuota(90 * MIB);
    const next = {
      ...pendingMedia(),
      id: randomUUID(),
      idempotencyKey: "postgres:media:quota-bound",
      objectKey: "media/quota/bound",
      expectedSize: 10 * MIB,
    };
    const result = await store.create(next, quota);
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    // 需要释放 40MB：只淘汰最旧的未绑定素材（boundId 被跳过）。
    expect(result.evicted).toHaveLength(1);
    expect(result.evicted?.[0]?.id).toBe(rest[0]);
    expect(await store.getById(boundId!)).not.toBeNull();
  });

  it("returns storage_limit without evicting when even full eviction cannot fit", async () => {
    const MIB = 1024 * 1024;
    const ids = await seedReadyMedia(store, 2, 40 * MIB);
    const quota = mediaQuota(30 * MIB);
    const next = {
      ...pendingMedia(),
      id: randomUUID(),
      idempotencyKey: "postgres:media:quota-unsatisfiable",
      objectKey: "media/quota/unsat",
      expectedSize: 50 * MIB,
    };
    const result = await store.create(next, quota);
    expect(result.kind).toBe("storage_limit");
    // 失败回滚：既有素材必须原样保留。
    for (const id of ids) expect(await store.getById(id)).not.toBeNull();
    expect(await store.getById(next.id)).toBeNull();
  });

  it("deleteOwned removes unbound media, keeps bound media, and reports missing ids", async () => {
    const ids = await seedReadyMedia(store, 2, 1024);
    const removed = await store.deleteOwned(ids[0]!, USER_ID);
    expect(removed.kind).toBe("deleted");
    expect(await store.getById(ids[0]!)).toBeNull();
    const missing = await store.deleteOwned(randomUUID(), USER_ID);
    expect(missing.kind).toBe("missing");
    await seedProject(pool, "test-project");
    await pool.query(
      `INSERT INTO canvas_media_project_bindings (owner_id, project_id, media_id, created_at)
       VALUES ($1, $2, $3, $4)`,
      [USER_ID, "test-project", ids[1]!, NOW],
    );
    const bound = await store.deleteOwned(ids[1]!, USER_ID);
    expect(bound.kind).toBe("bound");
    expect(await store.getById(ids[1]!)).not.toBeNull();
  });

  it("maintains the storage grace record on overage and clears it on recovery", async () => {
    const MIB = 1024 * 1024;
    const now = Date.parse("2026-07-20T18:00:00.000Z");
    // 超额：建立宽限记录，deadline = now + 7d。
    await store.maintainStorageGrace(
      USER_ID,
      120 * MIB,
      100 * MIB,
      "basic",
      7 * 24 * 60 * 60 * 1000,
      now,
    );
    let grace = await store.readStorageGrace(USER_ID);
    expect(grace).toMatchObject({
      fromTier: "basic",
      quotaBytes: 100 * MIB,
      usageBytes: 120 * MIB,
    });
    expect(Date.parse(grace!.deadline)).toBe(now + 7 * 24 * 60 * 60 * 1000);

    // 再次超额（同窗口内）：deadline 不被顺延，用量快照刷新。
    await store.maintainStorageGrace(
      USER_ID,
      130 * MIB,
      100 * MIB,
      "basic",
      7 * 24 * 60 * 60 * 1000,
      now + 60_000,
    );
    grace = await store.readStorageGrace(USER_ID);
    expect(Date.parse(grace!.deadline)).toBe(now + 7 * 24 * 60 * 60 * 1000);
    expect(grace!.usageBytes).toBe(130 * MIB);

    // 配额恢复（续费）：记录清除。
    await store.maintainStorageGrace(
      USER_ID,
      80 * MIB,
      200 * MIB,
      "pro",
      7 * 24 * 60 * 60 * 1000,
      now + 120_000,
    );
    expect(await store.readStorageGrace(USER_ID)).toBeNull();
  });

  it("sweeps overdue owners oldest-unbound-first, then bound media by oldest project", async () => {
    const MIB = 1024 * 1024;
    const now = Date.parse("2026-07-27T18:00:00.000Z");
    // 4 个素材：oldest-unbound, newest-unbound, oldProject-bound, recentProject-bound
    const [oldUnbound, newUnbound, oldBound, recentBound] = await seedReadyMedia(
      store,
      4,
      40 * MIB,
    );
    await seedProject(pool, "old-project");
    await seedProject(pool, "recent-project");
    await pool.query(
      `INSERT INTO canvas_media_project_bindings (owner_id, project_id, media_id, created_at)
       VALUES ($1, 'old-project', $2, $3), ($1, 'recent-project', $4, $3)`,
      [USER_ID, oldBound, NOW, recentBound],
    );
    // old-project 更早更新、recent-project 更近更新，决定绑定阶段的顺序。
    await pool.query(
      "UPDATE canvas_cloud_projects SET updated_at = '2026-07-01T00:00:00Z' WHERE id = 'old-project'",
    );
    await pool.query(
      "UPDATE canvas_cloud_projects SET updated_at = '2026-07-25T00:00:00Z' WHERE id = 'recent-project'",
    );

    // 宽限已过期。
    await store.maintainStorageGrace(
      USER_ID,
      160 * MIB,
      80 * MIB,
      "basic",
      7 * 24 * 60 * 60 * 1000,
      now - 8 * 24 * 60 * 60 * 1000,
    );
    expect(await store.overdueStorageGrace(now)).toEqual([USER_ID]);

    // 配额 80MB：需要释放 80MB。阶段一清 oldUnbound + newUnbound（80MB）即达标，
    // 绑定素材（含 old-project 的）不动。
    const { evicted, remainingOverage } = await store.enforceQuotaAfterGrace(
      USER_ID,
      80 * MIB,
      now,
    );
    expect(remainingOverage).toBe(0);
    expect(evicted.map((item) => item.id).sort()).toEqual([oldUnbound, newUnbound].sort());
    expect(await store.getById(oldBound)).not.toBeNull();
    expect(await store.getById(recentBound)).not.toBeNull();
    expect(await store.readStorageGrace(USER_ID)).toBeNull();
  });

  it("falls through to bound media when unbound media cannot cover the overage", async () => {
    const MIB = 1024 * 1024;
    const now = Date.parse("2026-07-27T18:00:00.000Z");
    const [unbound, boundOld, boundNew] = await seedReadyMedia(store, 3, 40 * MIB);
    await seedProject(pool, "old-project");
    await pool.query(
      `INSERT INTO canvas_media_project_bindings (owner_id, project_id, media_id, created_at)
       VALUES ($1, 'old-project', $2, $3), ($1, 'old-project', $4, $3)`,
      [USER_ID, boundOld, NOW, boundNew],
    );
    await store.maintainStorageGrace(
      USER_ID,
      120 * MIB,
      40 * MIB,
      "basic",
      7 * 24 * 60 * 60 * 1000,
      now - 8 * 24 * 60 * 60 * 1000,
    );

    // 配额 40MB、需释放 80MB：阶段一清 unbound（40MB），阶段二清最旧绑定 boundOld。
    const { evicted } = await store.enforceQuotaAfterGrace(USER_ID, 40 * MIB, now);
    expect(evicted.map((item) => item.id).sort()).toEqual([unbound, boundOld].sort());
    expect(await store.getById(boundNew)).not.toBeNull();
    expect(await store.readStorageGrace(USER_ID)).toBeNull();
  });
});

function mediaQuota(maxStorageBytes: number) {
  return {
    maxStorageBytes,
    evaluatedAt: "2026-07-16T18:10:00.000Z",
    staleUploadingBefore: "2026-07-16T18:10:00.000Z",
  };
}

async function seedReadyMedia(store: PostgresMediaMetadataStore, count: number, size: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    // 每个种子错开 1 分钟，让“最旧优先”的淘汰顺序可预测（created_at 相同会落到随机的 id 决胜）。
    const seededAt = new Date(Date.parse(NOW) + index * 60_000).toISOString();
    const record = {
      ...pendingMedia(),
      id: randomUUID(),
      idempotencyKey: `postgres:media:seed:${index}`,
      objectKey: `media/seed/${index}`,
      expectedSize: size,
      createdAt: seededAt,
      updatedAt: seededAt,
    };
    await store.create(record);
    const claimed = await store.claimUpload(record.id, USER_ID, 0, "2026-07-15T18:00:01.000Z");
    expect(claimed).not.toBeNull();
    const revision = claimed!.revision + 1;
    const updatedAt = "2026-07-16T18:00:02.000Z";
    await store.markReady(
      {
        ...claimed!,
        detectedMimeType: "image/png",
        size,
        sha256: "a".repeat(64),
        width: 64,
        height: 36,
        status: "ready",
        revision,
        updatedAt,
        readyAt: updatedAt,
      },
      claimed!.revision,
    );
    ids.push(record.id);
  }
  return ids;
}

function pendingMedia(): MediaRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ownerId: USER_ID,
    projectId: null,
    source: "upload",
    idempotencyKey: "postgres:media:one",
    objectKey: "media/aa/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "image",
    name: "reference.png",
    declaredMimeType: "image/png",
    detectedMimeType: null,
    expectedSize: 1024,
    size: null,
    expectedSha256: null,
    sha256: null,
    width: null,
    height: null,
    durationMs: null,
    status: "pending",
    error: null,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    uploadExpiresAt: "2026-07-15T19:00:00.000Z",
    readyAt: null,
  };
}

async function seedUser(pool: Pool) {
  await pool.query(
    `INSERT INTO canvas_users (
      id, email, normalized_email, display_name, password_hash, status,
      created_at, updated_at, last_login_at
    ) VALUES ($1, $2, $2, 'test', 'test-hash', 'active', $3, $3, $3)`,
    [USER_ID, "media@example.test", NOW],
  );
  await pool.query(
    `INSERT INTO canvas_cloud_principals (id, created_at, last_seen_at)
     VALUES ($1, $2, $2)
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID, NOW],
  );
}

async function seedProject(pool: Pool, projectId: string) {
  await pool.query(
    `INSERT INTO canvas_cloud_projects (
      owner_id, id, title, schema_version, current_revision, document,
      document_bytes, local_media_count, created_at, updated_at
    ) VALUES ($1, $2, 'test', 1, 1, $3::jsonb, 0, 0, $4, $4)
    ON CONFLICT (owner_id, id) DO NOTHING`,
    [USER_ID, projectId, JSON.stringify({ projectId }), NOW],
  );
}
