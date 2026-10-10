import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

export type MediaMultipartSessionStatus =
  | "active"
  | "completing"
  | "queued"
  | "processing"
  | "completed"
  | "aborted"
  | "failed";

export type MediaMultipartSession = {
  mediaId: string;
  ownerId: string;
  projectId: string | null;
  sessionId: string;
  storageUploadId: string;
  partSize: number;
  partCount: number;
  status: MediaMultipartSessionStatus;
  revision: number;
  expiresAt: string;
  assembledAt: string | null;
  terminalAt: string | null;
  nextAttemptAt: string | null;
  attemptCount: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaMultipartScope = {
  mediaId: string;
  ownerId: string;
  projectId: string | null;
  sessionId: string;
};

export type MediaMultipartLease = {
  mediaId: string;
  ownerId: string;
  projectId: string | null;
  sessionId: string;
  token: string;
  owner: string;
  expiresAt: string;
  attemptCount: number;
};

export interface MediaMultipartUploadStore {
  create(session: MediaMultipartSession): Promise<{ kind: "created" | "existing"; session: MediaMultipartSession }>;
  getByMedia(mediaId: string): Promise<MediaMultipartSession | null>;
  getByScope(scope: MediaMultipartScope): Promise<MediaMultipartSession | null>;
  claimCompleting(scope: MediaMultipartScope, expectedRevision: number, updatedAt: string): Promise<MediaMultipartSession | null>;
  resetActive(scope: MediaMultipartScope, expectedRevision: number, updatedAt: string): Promise<MediaMultipartSession | null>;
  markQueued(
    scope: MediaMultipartScope,
    expectedRevision: number,
    assembledAt: string,
    nextAttemptAt: string,
  ): Promise<MediaMultipartSession | null>;
  markAborted(scope: MediaMultipartScope, expectedRevision: number, terminalAt: string): Promise<MediaMultipartSession | null>;
  markFailed(
    scope: MediaMultipartScope,
    expectedRevision: number,
    terminalAt: string,
    code: string,
    message: string,
  ): Promise<MediaMultipartSession | null>;
  leaseNext(owner: string, now: string, leaseDurationMs: number): Promise<MediaMultipartLease | null>;
  renew(mediaId: string, token: string, now: string, leaseDurationMs: number): Promise<boolean>;
  releaseForRetry(
    mediaId: string,
    token: string,
    nextAttemptAt: string,
    code: string,
    message: string,
    updatedAt: string,
  ): Promise<boolean>;
  completeLease(mediaId: string, token: string, terminalAt: string): Promise<boolean>;
  failLease(mediaId: string, token: string, terminalAt: string, code: string, message: string): Promise<boolean>;
}

type MultipartRow = {
  media_id: string;
  owner_id: string;
  project_id: string | null;
  session_id: string;
  storage_upload_id: string;
  part_size: number | string;
  part_count: number;
  status: MediaMultipartSessionStatus;
  revision: number;
  expires_at: Date | string;
  assembled_at: Date | string | null;
  terminal_at: Date | string | null;
  next_attempt_at: Date | string | null;
  attempt_count: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type LeaseRow = MultipartRow & {
  lease_owner: string;
  lease_token: string;
  lease_expires_at: Date | string;
};

const RETURNING_COLUMNS = `
  media_id, owner_id, project_id, session_id, storage_upload_id,
  part_size, part_count, status, revision, expires_at, assembled_at,
  terminal_at, next_attempt_at, attempt_count, lease_owner, lease_token,
  lease_expires_at, last_error_code, last_error_message, created_at, updated_at`;

const RETURNING_UPLOAD_COLUMNS = `
  uploads.media_id, uploads.owner_id, uploads.project_id, uploads.session_id,
  uploads.storage_upload_id, uploads.part_size, uploads.part_count, uploads.status,
  uploads.revision, uploads.expires_at, uploads.assembled_at, uploads.terminal_at,
  uploads.next_attempt_at, uploads.attempt_count, uploads.lease_owner,
  uploads.lease_token, uploads.lease_expires_at, uploads.last_error_code,
  uploads.last_error_message, uploads.created_at, uploads.updated_at`;

export class PostgresMediaMultipartUploadStore implements MediaMultipartUploadStore {
  constructor(private readonly pool: Pool, private readonly createToken: () => string = randomUUID) {}

  async create(value: MediaMultipartSession) {
    const session = validateNewSession(value);
    const result = await this.pool.query<MultipartRow>(
      `INSERT INTO canvas_media_multipart_uploads (
        media_id, owner_id, project_id, session_id, storage_upload_id,
        part_size, part_count, status, revision, expires_at, assembled_at,
        terminal_at, next_attempt_at, attempt_count, lease_owner, lease_token,
        lease_expires_at, last_error_code, last_error_message, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'active', 0, $8,
        NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, $9, $9
      )
      ON CONFLICT (media_id) DO NOTHING
      RETURNING ${RETURNING_COLUMNS}`,
      [
        session.mediaId,
        session.ownerId,
        session.projectId,
        session.sessionId,
        session.storageUploadId,
        session.partSize,
        session.partCount,
        session.expiresAt,
        session.createdAt,
      ],
    );
    if (result.rows[0]) return { kind: "created" as const, session: parseSession(result.rows[0]) };
    const existing = await this.getByMedia(session.mediaId);
    if (!existing) throw new Error("Multipart upload insert conflict could not be reconciled");
    return { kind: "existing" as const, session: existing };
  }

  async getByMedia(mediaId: string) {
    const result = await this.pool.query<MultipartRow>(
      `SELECT ${RETURNING_COLUMNS} FROM canvas_media_multipart_uploads WHERE media_id = $1`,
      [mediaId],
    );
    return result.rows[0] ? parseSession(result.rows[0]) : null;
  }

  async getByScope(scope: MediaMultipartScope) {
    const result = await this.pool.query<MultipartRow>(
      `SELECT ${RETURNING_COLUMNS}
       FROM canvas_media_multipart_uploads
       WHERE media_id = $1
         AND owner_id = $2
         AND project_id IS NOT DISTINCT FROM $3::TEXT
         AND session_id = $4`,
      scopeParams(scope),
    );
    return result.rows[0] ? parseSession(result.rows[0]) : null;
  }

  async claimCompleting(scope: MediaMultipartScope, expectedRevision: number, updatedAt: string) {
    return this.transition(
      scope,
      expectedRevision,
      "active",
      `status = 'completing', revision = revision + 1, updated_at = $6`,
      [updatedAt],
    );
  }

  async resetActive(scope: MediaMultipartScope, expectedRevision: number, updatedAt: string) {
    return this.transition(
      scope,
      expectedRevision,
      "completing",
      `status = 'active', revision = revision + 1, updated_at = $6`,
      [updatedAt],
    );
  }

  async markQueued(
    scope: MediaMultipartScope,
    expectedRevision: number,
    assembledAt: string,
    nextAttemptAt: string,
  ) {
    return this.transition(
      scope,
      expectedRevision,
      "completing",
      `status = 'queued', revision = revision + 1, assembled_at = $6,
       next_attempt_at = $7, updated_at = $6, last_error_code = NULL,
       last_error_message = NULL`,
      [assembledAt, nextAttemptAt],
    );
  }

  async markAborted(scope: MediaMultipartScope, expectedRevision: number, terminalAt: string) {
    return this.transition(
      scope,
      expectedRevision,
      "active",
      `status = 'aborted', revision = revision + 1, terminal_at = $6,
       updated_at = $6, last_error_code = NULL, last_error_message = NULL`,
      [terminalAt],
    );
  }

  async markFailed(
    scope: MediaMultipartScope,
    expectedRevision: number,
    terminalAt: string,
    code: string,
    message: string,
  ) {
    const result = await this.pool.query<MultipartRow>(
      `UPDATE canvas_media_multipart_uploads
       SET status = 'failed', revision = revision + 1, terminal_at = $6,
           next_attempt_at = NULL, lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, last_error_code = $7,
           last_error_message = $8, updated_at = $6
       WHERE media_id = $1
         AND owner_id = $2
         AND project_id IS NOT DISTINCT FROM $3::TEXT
         AND session_id = $4
         AND revision = $5
         AND status IN ('active', 'completing', 'queued')
       RETURNING ${RETURNING_COLUMNS}`,
      [...scopeParams(scope), expectedRevision, terminalAt, safeCode(code), safeMessage(message)],
    );
    return result.rows[0] ? parseSession(result.rows[0]) : null;
  }

  async leaseNext(owner: string, now: string, leaseDurationMs: number) {
    const token = validLeaseToken(this.createToken());
    const result = await this.pool.query<LeaseRow>(
      `WITH candidate AS (
        SELECT media_id
        FROM canvas_media_multipart_uploads
        WHERE (
          (status = 'queued' AND next_attempt_at <= $1)
          OR (status = 'processing' AND lease_expires_at <= $1)
        )
        ORDER BY COALESCE(next_attempt_at, lease_expires_at), created_at, media_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE canvas_media_multipart_uploads AS uploads
      SET status = 'processing', revision = revision + 1,
          next_attempt_at = NULL, lease_owner = $2, lease_token = $3,
          lease_expires_at = $1::TIMESTAMPTZ + ($4 * INTERVAL '1 millisecond'),
          attempt_count = attempt_count + 1, updated_at = $1
      FROM candidate
      WHERE uploads.media_id = candidate.media_id
      RETURNING ${RETURNING_UPLOAD_COLUMNS}`,
      [now, validLeaseOwner(owner), token, positiveInteger(leaseDurationMs, "leaseDurationMs")],
    );
    const row = result.rows[0];
    return row ? parseLease(row) : null;
  }

  async renew(mediaId: string, token: string, now: string, leaseDurationMs: number) {
    const result = await this.pool.query(
      `UPDATE canvas_media_multipart_uploads
       SET lease_expires_at = $3::TIMESTAMPTZ + ($4 * INTERVAL '1 millisecond'),
           updated_at = $3
       WHERE media_id = $1
         AND status = 'processing'
         AND lease_token = $2
         AND lease_expires_at > $3
       RETURNING media_id`,
      [mediaId, validLeaseToken(token), now, positiveInteger(leaseDurationMs, "leaseDurationMs")],
    );
    return result.rowCount === 1;
  }

  async releaseForRetry(
    mediaId: string,
    token: string,
    nextAttemptAt: string,
    code: string,
    message: string,
    updatedAt: string,
  ) {
    const result = await this.pool.query(
      `UPDATE canvas_media_multipart_uploads
       SET status = 'queued', revision = revision + 1, next_attempt_at = $3,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = $4, last_error_message = $5, updated_at = $6
       WHERE media_id = $1 AND status = 'processing' AND lease_token = $2
       RETURNING media_id`,
      [mediaId, validLeaseToken(token), nextAttemptAt, safeCode(code), safeMessage(message), updatedAt],
    );
    return result.rowCount === 1;
  }

  async completeLease(mediaId: string, token: string, terminalAt: string) {
    const result = await this.pool.query(
      `UPDATE canvas_media_multipart_uploads
       SET status = 'completed', revision = revision + 1, terminal_at = $3,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = NULL, last_error_message = NULL, updated_at = $3
       WHERE media_id = $1 AND status = 'processing' AND lease_token = $2
       RETURNING media_id`,
      [mediaId, validLeaseToken(token), terminalAt],
    );
    return result.rowCount === 1;
  }

  async failLease(mediaId: string, token: string, terminalAt: string, code: string, message: string) {
    const result = await this.pool.query(
      `UPDATE canvas_media_multipart_uploads
       SET status = 'failed', revision = revision + 1, terminal_at = $3,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = $4, last_error_message = $5, updated_at = $3
       WHERE media_id = $1 AND status = 'processing' AND lease_token = $2
       RETURNING media_id`,
      [mediaId, validLeaseToken(token), terminalAt, safeCode(code), safeMessage(message)],
    );
    return result.rowCount === 1;
  }

  private async transition(
    scope: MediaMultipartScope,
    expectedRevision: number,
    expectedStatus: MediaMultipartSessionStatus,
    updates: string,
    values: unknown[],
  ) {
    const result = await this.pool.query<MultipartRow>(
      `UPDATE canvas_media_multipart_uploads
       SET ${updates}
       WHERE media_id = $1
         AND owner_id = $2
         AND project_id IS NOT DISTINCT FROM $3::TEXT
         AND session_id = $4
         AND revision = $5
         AND status = '${expectedStatus}'
       RETURNING ${RETURNING_COLUMNS}`,
      [...scopeParams(scope), expectedRevision, ...values],
    );
    return result.rows[0] ? parseSession(result.rows[0]) : null;
  }
}

function validateNewSession(value: MediaMultipartSession) {
  if (value.status !== "active" || value.revision !== 0 || value.attemptCount !== 0) {
    throw new Error("New multipart sessions must start active at revision zero");
  }
  if (value.assembledAt || value.terminalAt || value.nextAttemptAt || value.leaseOwner
    || value.leaseToken || value.leaseExpiresAt || value.lastErrorCode || value.lastErrorMessage) {
    throw new Error("New multipart sessions cannot include processing or terminal state");
  }
  positiveInteger(value.partSize, "partSize");
  positiveInteger(value.partCount, "partCount");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sessionId)) {
    throw new Error("Multipart session id must be a UUID");
  }
  dateIso(value.expiresAt);
  dateIso(value.createdAt);
  dateIso(value.updatedAt);
  return value;
}

function parseSession(row: MultipartRow): MediaMultipartSession {
  return {
    mediaId: row.media_id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    storageUploadId: row.storage_upload_id,
    partSize: safeInteger(row.part_size, "part_size"),
    partCount: safeInteger(row.part_count, "part_count"),
    status: row.status,
    revision: safeInteger(row.revision, "revision", true),
    expiresAt: dateIso(row.expires_at),
    assembledAt: nullableDateIso(row.assembled_at),
    terminalAt: nullableDateIso(row.terminal_at),
    nextAttemptAt: nullableDateIso(row.next_attempt_at),
    attemptCount: safeInteger(row.attempt_count, "attempt_count", true),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: nullableDateIso(row.lease_expires_at),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: dateIso(row.created_at),
    updatedAt: dateIso(row.updated_at),
  };
}

function parseLease(row: LeaseRow): MediaMultipartLease {
  const session = parseSession(row);
  if (session.status !== "processing" || !session.leaseOwner || !session.leaseToken || !session.leaseExpiresAt) {
    throw new Error("Multipart queue returned an invalid lease");
  }
  return {
    mediaId: session.mediaId,
    ownerId: session.ownerId,
    projectId: session.projectId,
    sessionId: session.sessionId,
    token: session.leaseToken,
    owner: session.leaseOwner,
    expiresAt: session.leaseExpiresAt,
    attemptCount: session.attemptCount,
  };
}

function scopeParams(scope: MediaMultipartScope) {
  return [scope.mediaId, scope.ownerId, scope.projectId, scope.sessionId];
}

function validLeaseOwner(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) throw new Error("Multipart worker owner is invalid");
  return normalized;
}

function validLeaseToken(value: string) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new Error("Multipart worker lease token is invalid");
  return value;
}

function safeCode(value: string) {
  const normalized = value.replace(/[^A-Z0-9_:-]+/gi, "_").slice(0, 128);
  return normalized || "MEDIA_MULTIPART_ERROR";
}

function safeMessage(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 1_000) || "Multipart upload failed";
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function safeInteger(value: number | string, name: string, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`Multipart ${name} is invalid`);
  }
  return parsed;
}

function nullableDateIso(value: Date | string | null) {
  return value === null ? null : dateIso(value);
}

function dateIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Multipart timestamp is invalid");
  return date.toISOString();
}
