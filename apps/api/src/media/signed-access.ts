import { createHmac, timingSafeEqual } from "node:crypto";

import type { MediaKind } from "@kachang/contracts";

const DEFAULT_TTL_SECONDS = 10 * 60;
const DEFAULT_MAX_TTL_SECONDS = 15 * 60;

type SignedMediaAccessOptions = {
  secret: string;
  baseUrl?: string;
  now?: () => number;
  ttlSeconds?: number;
  maxTtlSeconds?: number;
  allowInsecureLocalhost?: boolean;
};

export class SignedMediaAccess {
  private readonly secret: Buffer;
  private readonly baseUrl: URL | null;
  private readonly now: () => number;
  private readonly ttlSeconds: number;
  private readonly maxTtlSeconds: number;

  constructor(options: SignedMediaAccessOptions) {
    this.secret = Buffer.from(options.secret, "utf8");
    if (this.secret.length < 32) throw new Error("MEDIA_SIGNING_SECRET must contain at least 32 UTF-8 bytes");
    this.now = options.now ?? Date.now;
    this.ttlSeconds = positiveInteger(options.ttlSeconds ?? DEFAULT_TTL_SECONDS, "ttlSeconds");
    this.maxTtlSeconds = positiveInteger(options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS, "maxTtlSeconds");
    if (this.ttlSeconds > this.maxTtlSeconds) throw new Error("ttlSeconds cannot exceed maxTtlSeconds");
    this.baseUrl = options.baseUrl ? safeBaseUrl(options.baseUrl, options.allowInsecureLocalhost ?? false) : null;
  }

  createUrl(mediaId: string, kind: MediaKind) {
    if (!this.baseUrl) throw new Error("Signed media base URL is not configured");
    const expires = Math.floor(this.now() / 1_000) + this.ttlSeconds;
    const url = new URL(`/api/v1/provider-media/${encodeURIComponent(mediaId)}/content`, this.baseUrl);
    url.searchParams.set("kind", kind);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("signature", this.signature(mediaId, kind, expires));
    return url.toString();
  }

  verify(mediaId: string, kind: MediaKind, expiresValue: string | undefined, signature: string | undefined) {
    if (!expiresValue || !signature || !/^\d{10,12}$/.test(expiresValue) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const expires = Number(expiresValue);
    const now = Math.floor(this.now() / 1_000);
    if (!Number.isSafeInteger(expires) || expires <= now || expires > now + this.maxTtlSeconds) return false;
    const expected = Buffer.from(this.signature(mediaId, kind, expires), "base64url");
    const received = Buffer.from(signature, "base64url");
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private signature(mediaId: string, kind: MediaKind, expires: number) {
    return createHmac("sha256", this.secret)
      .update(`kachang-media-v1\n${mediaId}\n${kind}\n${expires}`, "utf8")
      .digest("base64url");
  }
}

function safeBaseUrl(value: string, allowInsecureLocalhost: boolean) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("MEDIA_PUBLIC_BASE_URL must be an origin without credentials or a path");
  }
  const localHttp = allowInsecureLocalhost
    && url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("MEDIA_PUBLIC_BASE_URL must use HTTPS");
  return new URL(url.origin);
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
