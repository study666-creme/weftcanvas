import {
  cloudProjectEntitlementsSchema,
  type CloudProjectEntitlements,
  type WalletSummary,
} from "@weftcanvas/contracts";

import { WalletProviderError, type WalletProvider } from "../wallet/provider.js";
import type { PrincipalMembershipReader } from "../identity/principal-membership-reader.js";
import type {
  CloudProjectEntitlementResolveOptions,
  CloudProjectEntitlementResolver,
  ResolvedCloudProjectEntitlements,
} from "./types.js";

export type CloudProjectEntitlementPolicy = {
  free: CloudProjectEntitlements;
  lite: CloudProjectEntitlements;
  basic: CloudProjectEntitlements;
  standard: CloudProjectEntitlements;
  pro: CloudProjectEntitlements;
};

type EntitlementCacheOptions = {
  now?: () => number;
  cacheMs?: number;
  staleGraceMs?: number;
};

type EntitlementCacheEntry = {
  expiresAt: number;
  staleUntil: number;
  entitlements: CloudProjectEntitlements;
};

const DEFAULT_CACHE_MS = 5 * 60_000;
const DEFAULT_STALE_GRACE_MS = 10 * 60_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const FREE_MEDIA_STORAGE_BYTES = 300 * MIB;

const DEFAULT_POLICY: CloudProjectEntitlementPolicy = {
  free: entitlement("free", 3, 10 * MIB, FREE_MEDIA_STORAGE_BYTES, 3),
  lite: entitlement("lite", 10, 32 * MIB, FREE_MEDIA_STORAGE_BYTES + 2 * GIB, 5),
  basic: entitlement("basic", 30, 64 * MIB, FREE_MEDIA_STORAGE_BYTES + 5 * GIB, 10),
  standard: entitlement("standard", 100, 256 * MIB, FREE_MEDIA_STORAGE_BYTES + 10 * GIB, 20),
  pro: entitlement("pro", 500, GIB, FREE_MEDIA_STORAGE_BYTES + 30 * GIB, 50),
};

export class StaticCloudProjectEntitlementResolver implements CloudProjectEntitlementResolver {
  constructor(private readonly entitlements: CloudProjectEntitlements = DEFAULT_POLICY.free) {}

  async resolve(): Promise<ResolvedCloudProjectEntitlements> {
    return { data: this.entitlements };
  }
}

export class PrincipalCloudProjectEntitlementResolver implements CloudProjectEntitlementResolver {
  private readonly cache = new Map<string, EntitlementCacheEntry>();

  constructor(
    private readonly reader: PrincipalMembershipReader,
    private readonly policy: CloudProjectEntitlementPolicy = DEFAULT_POLICY,
    private readonly options: EntitlementCacheOptions = {},
  ) {}

  async resolve(
    ownerId: string,
    _token?: string,
    options: CloudProjectEntitlementResolveOptions = {},
  ): Promise<ResolvedCloudProjectEntitlements> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(ownerId);
    if (cached && cached.expiresAt > now) return { data: cached.entitlements };

    try {
      const membership = await this.reader.readMembership(ownerId);
      const entitlements = resolveMembershipEntitlements({ membership }, this.policy, now);
      const membershipUntil = activeMembershipUntil({ membership }, now);
      const expiresAt = Math.min(
        now + nonNegativeDuration(this.options.cacheMs, DEFAULT_CACHE_MS, "cacheMs"),
        membershipUntil,
      );
      this.cache.set(ownerId, {
        expiresAt,
        staleUntil: Math.min(
          expiresAt +
            nonNegativeDuration(this.options.staleGraceMs, DEFAULT_STALE_GRACE_MS, "staleGraceMs"),
          membershipUntil,
        ),
        entitlements,
      });
      pruneEntitlementCache(this.cache, now);
      return { data: entitlements };
    } catch {
      if (options.allowStale !== false && cached && cached.staleUntil > now)
        return { data: cached.entitlements };
      if (cached) this.cache.delete(ownerId);
      return { data: this.policy.free };
    }
  }
}

export class MembershipCloudProjectEntitlementResolver implements CloudProjectEntitlementResolver {
  private readonly tokenCache = new Map<string, EntitlementCacheEntry>();
  private readonly principalResolver: PrincipalCloudProjectEntitlementResolver | null;

  constructor(
    private readonly wallet: WalletProvider,
    private readonly policy: CloudProjectEntitlementPolicy = DEFAULT_POLICY,
    private readonly options: EntitlementCacheOptions & {
      principalMembershipReader?: PrincipalMembershipReader;
    } = {},
  ) {
    this.principalResolver = options.principalMembershipReader
      ? new PrincipalCloudProjectEntitlementResolver(
          options.principalMembershipReader,
          policy,
          options,
        )
      : null;
  }

  async resolve(
    ownerId: string,
    token?: string,
    options: CloudProjectEntitlementResolveOptions = {},
  ): Promise<ResolvedCloudProjectEntitlements> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.tokenCache.get(ownerId);
    if (cached && cached.expiresAt > now) return { data: cached.entitlements };

    let result;
    try {
      result = await this.wallet.getSummary(token);
    } catch (error) {
      if (!(error instanceof WalletProviderError) || error.status === 401) throw error;
      if (options.allowStale !== false && cached && cached.staleUntil > now)
        return { data: cached.entitlements };
      if (cached) this.tokenCache.delete(ownerId);
      return { data: this.policy.free };
    }
    const entitlements = resolveMembershipEntitlements(result.data, this.policy, now);
    const membershipUntil = activeMembershipUntil(result.data, now);
    const expiresAt = Math.min(
      now + nonNegativeDuration(this.options.cacheMs, DEFAULT_CACHE_MS, "cacheMs"),
      membershipUntil,
    );
    this.tokenCache.set(ownerId, {
      expiresAt,
      staleUntil: Math.min(
        expiresAt +
          nonNegativeDuration(this.options.staleGraceMs, DEFAULT_STALE_GRACE_MS, "staleGraceMs"),
        membershipUntil,
      ),
      entitlements,
    });
    pruneEntitlementCache(this.tokenCache, now);
    return {
      data: entitlements,
      ...(result.refreshedToken ? { refreshedToken: result.refreshedToken } : {}),
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    };
  }

  async resolveForPrincipal(
    principalId: string,
    options: CloudProjectEntitlementResolveOptions = {},
  ): Promise<ResolvedCloudProjectEntitlements> {
    return (
      this.principalResolver?.resolve(principalId, undefined, options) ?? { data: this.policy.free }
    );
  }
}

function pruneEntitlementCache(cache: Map<string, EntitlementCacheEntry>, now: number) {
  if (cache.size < 2_000) return;
  for (const [ownerId, item] of cache) {
    if (item.staleUntil <= now) cache.delete(ownerId);
  }
  while (cache.size > 4_000) {
    const ownerId = cache.keys().next().value as string | undefined;
    if (!ownerId) break;
    cache.delete(ownerId);
  }
}

function nonNegativeDuration(value: number | undefined, fallback: number, label: string) {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
  return duration;
}

export function resolveMembershipEntitlements(
  summary: Pick<WalletSummary, "membership">,
  policy: CloudProjectEntitlementPolicy = DEFAULT_POLICY,
  now = Date.now(),
) {
  if (!membershipIsActive(summary, now) || !summary.membership.tier) return policy.free;
  const tier = summary.membership.tier.trim().toLowerCase();
  if (["pro", "professional", "premium", "plus"].includes(tier)) return policy.pro;
  if (tier === "standard") return policy.standard;
  if (tier === "basic") return policy.basic;
  if (tier === "lite") return policy.lite;
  return policy.free;
}

export function defaultCloudProjectEntitlementPolicy() {
  return structuredClone(DEFAULT_POLICY);
}

function membershipIsActive(summary: Pick<WalletSummary, "membership">, now: number) {
  if (!summary.membership.active || !summary.membership.tier) return false;
  const until = summary.membership.until;
  return !until || Date.parse(until) > now;
}

function activeMembershipUntil(summary: Pick<WalletSummary, "membership">, now: number) {
  if (!membershipIsActive(summary, now) || !summary.membership.until)
    return Number.POSITIVE_INFINITY;
  return Date.parse(summary.membership.until);
}

function entitlement(
  tier: string,
  cloudProjectLimit: number,
  projectStorageBytes: number,
  mediaStorageBytes: number,
  revisionRetentionCount: number,
) {
  return cloudProjectEntitlementsSchema.parse({
    tier,
    cloudProjectLimit,
    projectStorageBytes,
    mediaStorageBytes,
    revisionRetentionCount,
    multiDeviceSync: true,
  });
}
