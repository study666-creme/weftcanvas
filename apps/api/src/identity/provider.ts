import type { IdentityCapabilities, IdentitySession } from "@weftcanvas/contracts";

export type IssuedIdentitySession = IdentitySession & {
  token: string;
};

export type ResolvedIdentitySession = IdentitySession & {
  refreshedToken?: string;
};

export type IdentityRegistrationResult =
  | { status: "authenticated"; session: IssuedIdentitySession }
  | { status: "verification_required"; email: string };

export type IdentityProviderErrorCode =
  | "EMAIL_TAKEN"
  | "INVALID_CREDENTIALS"
  | "REGISTRATION_REJECTED"
  | "IDENTITY_RATE_LIMITED"
  | "IDENTITY_PROVIDER_UNAVAILABLE"
  | "REGISTRATION_EXTERNAL";

export class IdentityProviderError extends Error {
  constructor(
    readonly code: IdentityProviderErrorCode,
    message: string,
    readonly status: 400 | 401 | 409 | 429 | 503,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "IdentityProviderError";
  }
}

export interface IdentityProvider {
  readonly capabilities: IdentityCapabilities;
  register(value: unknown): Promise<IdentityRegistrationResult>;
  login(value: unknown): Promise<IssuedIdentitySession>;
  authenticate(token: string | undefined): Promise<ResolvedIdentitySession | null>;
  logout(token: string | undefined): Promise<void>;
}
