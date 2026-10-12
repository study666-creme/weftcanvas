import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  identityLoginRequestSchema,
  identityRegisterRequestSchema,
  identitySessionSchema,
  publicIdentityUserSchema,
  type IdentitySession,
} from "@weftcanvas/contracts";

import { DUMMY_PASSWORD_HASH, ScryptPasswordHasher } from "./password.js";
import {
  IdentityProviderError,
  type IdentityProvider,
  type IdentityRegistrationResult,
  type IssuedIdentitySession,
} from "./provider.js";
import type {
  IdentityPasswordHasher,
  IdentitySessionRecord,
  IdentityStore,
  IdentityUserRecord,
} from "./types.js";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class IdentityServiceError extends IdentityProviderError {
  constructor(code: "EMAIL_TAKEN" | "INVALID_CREDENTIALS", message: string) {
    super(code, message, code === "EMAIL_TAKEN" ? 409 : 401);
    this.name = "IdentityServiceError";
  }
}

export type { IssuedIdentitySession } from "./provider.js";

type IdentityServiceOptions = {
  now?: () => number;
  createId?: () => string;
  createToken?: () => string;
  passwordHasher?: IdentityPasswordHasher;
  sessionTtlMs?: number;
  initialCreditMicros?: number;
};

export class IdentityService implements IdentityProvider {
  readonly capabilities = {
    available: true,
    registration: "native",
    registrationUrl: null,
    passwordResetUrl: null,
  } as const;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createToken: () => string;
  private readonly passwordHasher: IdentityPasswordHasher;
  private readonly sessionTtlMs: number;
  private readonly initialCreditMicros: number;

  constructor(
    private readonly store: IdentityStore,
    options: IdentityServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
    this.passwordHasher = options.passwordHasher ?? new ScryptPasswordHasher();
    this.sessionTtlMs = positiveInteger(
      options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      "sessionTtlMs",
    );
    this.initialCreditMicros = nonNegativeInteger(
      options.initialCreditMicros ?? 0,
      "initialCreditMicros",
    );
  }

  async register(value: unknown): Promise<IdentityRegistrationResult> {
    const input = identityRegisterRequestSchema.parse(value);
    const now = this.now();
    const timestamp = new Date(now).toISOString();
    const id = this.createId();
    const passwordHash = await this.passwordHasher.hash(input.password);
    const user: IdentityUserRecord = {
      id,
      email: input.email,
      normalizedEmail: input.email,
      displayName: input.displayName ?? defaultDisplayName(input.email),
      passwordHash,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastLoginAt: timestamp,
    };
    const issued = this.issueSession(id, now);
    const created = await this.store.createAccount(
      user,
      issued.record,
      this.initialCreditMicros,
      `ledger:credit:registration:${id}`,
    );
    if (created.kind === "email_taken") {
      throw new IdentityServiceError("EMAIL_TAKEN", "这个邮箱已经注册");
    }
    const session = publicSession(user, issued.token, issued.record.expiresAt);
    return {
      status: "authenticated",
      session,
      ...session,
    };
  }

  async login(value: unknown): Promise<IssuedIdentitySession> {
    const input = identityLoginRequestSchema.parse(value);
    const user = await this.store.findUserByNormalizedEmail(input.email);
    const verified = await this.passwordHasher.verify(
      input.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || user.status !== "active" || !verified) {
      throw new IdentityServiceError("INVALID_CREDENTIALS", "邮箱或密码不正确");
    }

    const now = this.now();
    const issued = this.issueSession(user.id, now);
    if (!(await this.store.createSession(issued.record, new Date(now).toISOString()))) {
      throw new IdentityServiceError("INVALID_CREDENTIALS", "邮箱或密码不正确");
    }
    return publicSession(user, issued.token, issued.record.expiresAt);
  }

  async authenticate(token: string | undefined): Promise<IdentitySession | null> {
    if (!token || !SESSION_TOKEN_PATTERN.test(token)) return null;
    const active = await this.store.findActiveSession(
      hashSessionToken(token),
      new Date(this.now()).toISOString(),
    );
    if (!active) return null;
    return identitySessionSchema.parse({
      user: publicIdentityUserSchema.parse(active.user),
      expiresAt: active.session.expiresAt,
    });
  }

  async logout(token: string | undefined) {
    if (!token || !SESSION_TOKEN_PATTERN.test(token)) return;
    await this.store.revokeSession(hashSessionToken(token), new Date(this.now()).toISOString());
  }

  private issueSession(userId: string, now: number) {
    const token = this.createToken();
    if (!SESSION_TOKEN_PATTERN.test(token))
      throw new Error("Session token generator returned an invalid token");
    const createdAt = new Date(now).toISOString();
    const record: IdentitySessionRecord = {
      tokenHash: hashSessionToken(token),
      userId,
      createdAt,
      expiresAt: new Date(now + this.sessionTtlMs).toISOString(),
      lastSeenAt: createdAt,
      revokedAt: null,
    };
    return { token, record };
  }
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function publicSession(
  user: IdentityUserRecord,
  token: string,
  expiresAt: string,
): IssuedIdentitySession {
  return {
    token,
    ...identitySessionSchema.parse({ user: publicIdentityUserSchema.parse(user), expiresAt }),
  };
}

function defaultDisplayName(email: string) {
  return email.slice(0, email.indexOf("@")).slice(0, 48);
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
