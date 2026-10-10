# Identity and Shared Credit Boundaries

The official Canvas product shares Prompt Hub identity, membership, and
credits. Prompt Hub is the sole writable balance and ledger authority. Canvas
API is a product boundary and adapter; it does not maintain or synchronize a
second Canvas balance.

```text
Canvas browser -> Canvas API -> Prompt Hub identity and shared-credit ledger
                           \-> Prompt Hub hosted generation -> model provider
```

Native identity, wallet, and generation implementations remain useful for
isolated tests, local development, and explicitly self-hosted deployments.
They are a separate deployment profile, not the official default or a hosted
production fallback.

## Official authority

- Prompt Hub owns product users, authentication state, membership, wallets,
  credit orders, redemption, balances, and ledger entries.
- Canvas owns Canvas-specific projects, graph revisions, media metadata, Agent
  runs, and product audit records.
- A stable Prompt Hub subject id, not an email address, owns Canvas cloud data.
- Passwords and upstream access tokens are handled by server-side providers and
  are never exposed to Canvas browser application code.
- Hosted production fails closed if Prompt Hub identity or charging is
  unavailable. It must not silently switch to a native account or balance.

## Provider ports

The product API exposes internal interfaces rather than external product types:

- `IdentityProvider`: sign-in, token verification, account linking, and logout.
- `WalletProvider`: quote, reserve, capture, release, balance, and ledger list.
- `ModelCatalogProvider`: capabilities, parameters, pricing, and availability.
- `MediaStore`: direct upload, signed download, retention, and deletion.

An integration adapter may implement one or more ports. Canvas domain code must
not import provider URLs, SDK types, cookies, or database schema. The production
composition root may name Prompt Hub explicitly because selecting the authority
is a deployment decision.

## Sign-in flow

1. Canvas redirects an unauthenticated user to the configured Prompt Hub sign-in
   route or accepts the supported same-origin sign-in exchange.
2. Canvas API exchanges or verifies credentials with Prompt Hub server-side.
3. Canvas API returns only an HttpOnly, short-lived product session cookie.
4. Canvas data is scoped to the stable Prompt Hub subject returned by the
   provider.

Do not depend on browser local storage or a cross-domain shared cookie for the
security boundary.

## Isolated native identity

The PostgreSQL adapter implements a native-login branch for isolated use:

- normalized email identities with stable random user ids
- salted scrypt password derivation with bounded parameters
- account, wallet, optional opening credit, ledger entry, and first session in
  one database transaction
- 256-bit random session tokens returned only through an HttpOnly cookie
- SHA-256 session-token hashes in PostgreSQL, absolute expiry, last-seen time,
  revocation, and disabled-account enforcement
- same-origin JSON-only account writes and no-store identity responses

Sessions default to 30 days and can be configured from one hour to 90 days.
They are absolute sessions rather than browser-local permanent tokens. The
production cookie uses the `__Host-` prefix, `Secure`, `HttpOnly`, `Path=/`, and
`SameSite=Strict` when the API and web app share one HTTPS origin.

This branch protects owner-scoped media, local wallets, native generation
submission, task recovery, and result delivery. It does not share Prompt Hub
credits and must be selected explicitly. Before using it as a public self-hosted
account product, add distributed rate limiting, verified email ownership,
password recovery, security-event audit logs, and operational session
management.

## Credit model

Prompt Hub is the cost and settlement authority for the official product. A
catalog or quote exposed by Canvas is advisory until Prompt Hub accepts the
operation. Prices may use fractional credits, so public values use fixed
precision and never binary floating-point arithmetic.

The Prompt Hub wallet is backed by an append-only ledger. Any Canvas-side
balance is display data only, may be cached briefly, and cannot authorize or
settle work.

### Ledger read boundary

`GET /api/v1/wallet/ledger` is a read-only product view of the Prompt Hub
ledger. The Canvas API normalizes the upstream `/api/v1/me/ledger` success
response at the server adapter boundary and never forwards the raw upstream
payload to the browser. The adapter accepts both the historical
`{ data: { items } }` envelope and the current list style where the items
array sits directly under `data`, then exposes one canonical, bounded item
shape. Only display-only fields that an entry kind omits are defaulted; the
critical financial fields (`id`, `delta`, `balanceAfter`, `createdAt`) remain
required and fail closed, oversized lists are rejected, and unknown or private
upstream fields are dropped so they cannot leak to a browser response. An
upstream business error envelope is surfaced as the product error rather than
being reported as an unrecognized payload.

Every hosted billable operation preserves this lifecycle through Prompt Hub:

1. `quote` returns a price, pricing version, and expiry.
2. `reserve` atomically holds enough credits before work starts.
3. `capture` settles the actual amount after a valid result is available.
4. `release` returns the hold when submission or generation fails.
5. `adjust` is restricted to audited administrative corrections.

## Required authoritative ledger fields

- user id and wallet id
- signed amount and resulting balance
- product and operation
- model catalog id
- project, canvas, node, run, and generation job references when applicable
- quote and pricing versions
- idempotency key
- reservation, capture, release, or adjustment relationship
- creation time and immutable audit metadata

## Reliability rules

- Password login may retry once inside one bounded request budget when the
  upstream connection times out, fails at the network layer, or returns 5xx.
  Invalid credentials and rate limits are definitive responses and must never
  be retried automatically.
- One job id and idempotency key can be charged at most once.
- Retrying, refreshing, or reconnecting resumes the existing reservation.
- A result is captured only after required media passes validation and storage.
- A failed or expired job releases its unused reservation automatically.
- Concurrent usage is protected by a database transaction.
- Every client refreshes its displayed Prompt Hub balance after a ledger event.
- Submission revalidates the selected model, parameters, and current quote
  against the latest server-owned catalog and Prompt Hub settlement rules.

## Deployment rule

Shared identity and credits are a required relationship for the official
Canvas deployment, not a future optional integration. Both products use Prompt
Hub as the same authoritative ledger service. Never synchronize two writable
balances in either direction.

The native adapters remain available behind the same ports so tests and an
explicitly self-hosted profile do not depend on Prompt Hub. Switching profiles
changes the authority; it is not a balance migration or runtime fallback.
