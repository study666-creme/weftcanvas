import type { PublicIdentityUser } from "@kachang/contracts";

export type IdentityUserStatus = "active" | "disabled";

export type IdentityUserRecord = PublicIdentityUser & {
  normalizedEmail: string;
  passwordHash: string;
  status: IdentityUserStatus;
  updatedAt: string;
  lastLoginAt: string | null;
};

export type IdentitySessionRecord = {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
};

export type ActiveIdentitySession = {
  user: IdentityUserRecord;
  session: IdentitySessionRecord;
};

export type CreateIdentityAccountResult =
  | { kind: "created" }
  | { kind: "email_taken" };

export interface IdentityStore {
  createAccount(
    user: IdentityUserRecord,
    session: IdentitySessionRecord,
    initialCreditMicros: number,
    creditLedgerId: string,
  ): Promise<CreateIdentityAccountResult>;
  findUserByNormalizedEmail(normalizedEmail: string): Promise<IdentityUserRecord | null>;
  createSession(session: IdentitySessionRecord, loginAt: string): Promise<boolean>;
  findActiveSession(tokenHash: string, now: string): Promise<ActiveIdentitySession | null>;
  revokeSession(tokenHash: string, revokedAt: string): Promise<void>;
}

export interface IdentityPasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
}
