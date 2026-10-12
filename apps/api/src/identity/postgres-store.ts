import type { Pool, PoolClient } from "pg";

import type {
  ActiveIdentitySession,
  CreateIdentityAccountResult,
  IdentitySessionRecord,
  IdentityStore,
  IdentityUserRecord,
  IdentityUserStatus,
} from "./types.js";

type UserRow = {
  id: string;
  email: string;
  normalized_email: string;
  display_name: string;
  password_hash: string;
  status: IdentityUserStatus;
  created_at: Date | string;
  updated_at: Date | string;
  last_login_at: Date | string | null;
};

type SessionRow = UserRow & {
  token_hash: string;
  user_id: string;
  session_created_at: Date | string;
  expires_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
};

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly pool: Pool) {}

  async createAccount(
    user: IdentityUserRecord,
    session: IdentitySessionRecord,
    initialCreditMicros: number,
    creditLedgerId: string,
  ): Promise<CreateIdentityAccountResult> {
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO canvas_users (
          id, email, normalized_email, display_name, password_hash, status,
          created_at, updated_at, last_login_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (normalized_email) DO NOTHING
        RETURNING id`,
        [
          user.id,
          user.email,
          user.normalizedEmail,
          user.displayName,
          user.passwordHash,
          user.status,
          user.createdAt,
          user.updatedAt,
          user.lastLoginAt,
        ],
      );
      if (inserted.rowCount !== 1) return { kind: "email_taken" };

      await client.query(
        `INSERT INTO canvas_wallets (owner_id, available_credit_micros)
         VALUES ($1, $2)`,
        [user.id, initialCreditMicros],
      );
      if (initialCreditMicros > 0) {
        await client.query(
          `INSERT INTO canvas_wallet_ledger (
            id, owner_id, entry_type, available_delta_micros,
            reserved_delta_micros, metadata
          ) VALUES ($1, $2, 'credit', $3, 0, $4::JSONB)`,
          [
            creditLedgerId,
            user.id,
            initialCreditMicros,
            JSON.stringify({ source: "registration" }),
          ],
        );
      }
      await insertSession(client, session);
      return { kind: "created" };
    });
  }

  async findUserByNormalizedEmail(normalizedEmail: string) {
    const result = await this.pool.query<UserRow>(
      `${userSelect()} FROM canvas_users WHERE normalized_email = $1`,
      [normalizedEmail],
    );
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async createSession(session: IdentitySessionRecord, loginAt: string) {
    return withTransaction(this.pool, async (client) => {
      const active = await client.query(
        `UPDATE canvas_users
         SET last_login_at = $2, updated_at = $2
         WHERE id = $1 AND status = 'active'
         RETURNING id`,
        [session.userId, loginAt],
      );
      if (active.rowCount !== 1) return false;
      await insertSession(client, session);
      return true;
    });
  }

  async findActiveSession(tokenHash: string, now: string): Promise<ActiveIdentitySession | null> {
    const result = await this.pool.query<SessionRow>(
      `${userSelect("u")},
         s.token_hash, s.user_id, s.created_at AS session_created_at,
         s.expires_at, s.last_seen_at, s.revoked_at
       FROM canvas_sessions s
       JOIN canvas_users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > $2
         AND u.status = 'active'`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    if (!row) return null;
    await this.pool.query(
      `UPDATE canvas_sessions
       SET last_seen_at = $2
       WHERE token_hash = $1
         AND last_seen_at < ($2::TIMESTAMPTZ - INTERVAL '15 minutes')`,
      [tokenHash, now],
    );
    return {
      user: userFromRow(row),
      session: {
        tokenHash: row.token_hash,
        userId: row.user_id,
        createdAt: dateIso(row.session_created_at),
        expiresAt: dateIso(row.expires_at),
        lastSeenAt: dateIso(row.last_seen_at),
        revokedAt: row.revoked_at ? dateIso(row.revoked_at) : null,
      },
    };
  }

  async revokeSession(tokenHash: string, revokedAt: string) {
    await this.pool.query(
      `UPDATE canvas_sessions
       SET revoked_at = COALESCE(revoked_at, $2)
       WHERE token_hash = $1`,
      [tokenHash, revokedAt],
    );
  }
}

function userSelect(alias?: string) {
  const prefix = alias ? `${alias}.` : "";
  return `SELECT ${prefix}id, ${prefix}email, ${prefix}normalized_email,
    ${prefix}display_name, ${prefix}password_hash, ${prefix}status,
    ${prefix}created_at, ${prefix}updated_at, ${prefix}last_login_at`;
}

function userFromRow(row: UserRow): IdentityUserRecord {
  return {
    id: row.id,
    email: row.email,
    normalizedEmail: row.normalized_email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status,
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
    lastLoginAt: row.last_login_at ? dateIso(row.last_login_at) : null,
  };
}

async function insertSession(client: PoolClient, session: IdentitySessionRecord) {
  await client.query(
    `INSERT INTO canvas_sessions (
      token_hash, user_id, created_at, expires_at, last_seen_at, revoked_at
    ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      session.tokenHash,
      session.userId,
      session.createdAt,
      session.expiresAt,
      session.lastSeenAt,
      session.revokedAt,
    ],
  );
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function dateIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Identity timestamp is invalid");
  return date.toISOString();
}
