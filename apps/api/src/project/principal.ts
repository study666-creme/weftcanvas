import type { Pool, PoolClient } from "pg";

type QueryClient = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export async function ensureCloudPrincipal(
  client: QueryClient,
  ownerId: string,
  timestamp: string,
) {
  await client.query(
    `INSERT INTO canvas_cloud_principals (id, created_at, last_seen_at)
     VALUES ($1, $2, $2)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = GREATEST(canvas_cloud_principals.last_seen_at, EXCLUDED.last_seen_at)`,
    [ownerId, timestamp],
  );
}
