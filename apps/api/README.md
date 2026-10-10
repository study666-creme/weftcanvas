# Canvas API

The Canvas API is the server boundary for product data that must not be fetched
or trusted directly by the browser. Its public routes implement identity
sessions, validated reference media, the live model catalog, generation quotes,
authenticated generation tasks, recovery lists, and status events.

The official hosted composition uses Prompt Hub for account sessions,
membership, wallet operations, and shared credits. Canvas API exposes these
through same-origin product routes and does not persist a second writable
balance. A native PostgreSQL identity and wallet composition remains available
for isolated development, tests, and explicit self-hosting; passwords use
salted scrypt derivation and raw session tokens are returned only as same-origin
HttpOnly cookies.

The native generation job kernel is also implemented, including idempotent
reservation, revisioned state transitions, ambiguous-submission handling,
artifact validation, capture, release, and a PostgreSQL transaction adapter. It
is exposed only through owner-scoped routes with PostgreSQL request windows,
transactional active-task limits, and bounded SSE connections. See
[`../../docs/GENERATION-JOBS.md`](../../docs/GENERATION-JOBS.md).

The server-only native Kachang API client implements the reviewed text, image, and
recoverable video protocols. It consumes an immutable private route stored on a
reserved job, resolves media through a port, and writes provider results to an
opaque staging store. The public server does not construct this client or read a
generation credential. The separate worker process constructs it only when
started explicitly.

The native result artifact adapter validates staged job ownership, decodes generated
images, parses completed video media, persists final objects idempotently, and
settles text against actual token usage and the pricing snapshot frozen at
reservation time. Remote result downloads require a configured HTTPS hostname
allowlist and revalidate every redirect. This adapter remains worker-only and is
not constructed by the public API process.

Hosted production instead submits generation through Prompt Hub, which remains
the credit authority and routes work to NewAPI or another configured upstream.
The native generation Worker is disabled for that profile.

## Local use

From the repository root:

```bash
pnpm dev
```

The API listens on `http://127.0.0.1:8787`. The web app uses `/api`; Vite
proxies that path to the API during local development.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Process health without a catalog fetch |
| `POST` | `/api/v1/auth/register` | Register through the configured identity provider |
| `POST` | `/api/v1/auth/login` | Verify credentials and issue a new session |
| `GET` | `/api/v1/auth/session` | Read the current session or return `data: null` |
| `POST` | `/api/v1/auth/logout` | Revoke the current session and clear its cookie |
| `POST` | `/api/v1/media/uploads` | Create an owner-scoped, idempotent upload intent |
| `PUT` | `/api/v1/media/:id/content` | Stream exact upload bytes and validate the result |
| `POST` | `/api/v1/media/:id/complete` | Validate and publish a completed direct upload |
| `GET` | `/api/v1/media/:id` | Read private media metadata and processing status |
| `GET` | `/api/v1/media/:id/content` | Read private media bytes with single-range support |
| `GET` | `/api/v1/provider-media/:id/content` | HMAC-signed, short-lived model reference delivery |
| `GET` | `/api/v1/model-catalog` | Validated public catalog; optional `modality` query |
| `GET` | `/api/v1/model-catalog/version` | Catalog, capability, and pricing versions |
| `POST` | `/api/v1/generation-quotes` | Parameter validation and fixed-precision advisory quote |
| `POST` | `/api/v1/generation-jobs` | Revalidate, reserve, and create an authenticated task |
| `GET` | `/api/v1/generation-jobs` | List owner tasks; optional `projectId` and bounded `limit` |
| `GET` | `/api/v1/generation-jobs/:id` | Read one owner-scoped task snapshot |
| `GET` | `/api/v1/generation-jobs/reconcile` | Read-only resolution of one durable request by `?key=` idempotency identity; `404` on miss; never submits, mutates, or contacts a provider |
| `GET` | `/api/v1/generation-jobs/:id/events` | Versioned SSE snapshots with reconnect support |

Catalog responses support `ETag`. Quote and identity responses use
`Cache-Control: no-store` where applicable. Credential endpoints accept JSON
only and reject browser requests from an untrusted origin. JSON request bodies
are streamed with a 1 MiB limit; compressed request bodies are rejected.

## H3 2K/4K requests

The public `minimax_h3` catalog entry exposes `768`, `1080p`, `2K`, and `4K`
through the `resolution` parameter. `2K` and `4K` require at least one image
reference. Ask for a quote with the public Canvas API identity and include the
image count in `inputs`:

```http
POST https://canvas-api.prompt-hubs.com/api/v1/generation-quotes
Content-Type: application/json
```

```json
{
  "modelId": "minimax_h3",
  "modality": "video",
  "parameters": {
    "prompt": "让主体自然运动，镜头保持平稳。",
    "duration_seconds": 4,
    "aspect_ratio": "16:9",
    "resolution": "4K"
  },
  "inputs": { "images": 1 }
}
```

The quote is rejected with `H3_REFERENCE_REQUIRED` when no image is supplied.
Canvas uploads and serves owned references through short-lived HTTPS delivery
URLs before the model request, so callers do not need to host local media on a
public URL.

## Midjourney v8.2 requests

The exact public model ids are `Midjourney v8.2 高速` and `mj-v82`; Chinese
characters are supported and are part of the first id. Canvas clients submit
through the public Prompt Hub image protocol:

```http
POST https://api.prompt-hubs.com/api/v1/generate
Authorization: Bearer <SESSION_TOKEN>
Content-Type: application/json
```

```json
{
  "version": "image.v1",
  "model": "Midjourney v8.2 高速",
  "operation": "text_to_image",
  "prompt": "保留参考图主体外形，改为电影感城市夜景。",
  "aspect_ratio": "16:9",
  "options": { "raw": false }
}
```

The server projects this request to the model's documented API-station route
`POST /v1/midjourney/generations`. Both ids require `model` and `prompt`, fix
`n` to `1`, and accept `size`, `raw`, and optional reference `image`/`images`.
Only `mj-v82` additionally accepts `resolution` with `1K` or `2K`:

```json
{
  "version": "image.v1",
  "model": "mj-v82",
  "operation": "text_to_image",
  "prompt": "电影感城市夜景。",
  "aspect_ratio": "16:9",
  "resolution": "2K",
  "options": { "raw": false }
}
```

One request returns four candidate images. The task is resumed through the
public generation job endpoint; clients must not turn the four artifacts into
four submissions or four charges.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | API listen port |
| `KACHANG_CATALOG_URL` | `https://newapi.prompt-hubs.com/api/model-catalog` | Server-side public catalog source |
| `CATALOG_SNAPSHOT_PATH` | `.data/model-catalog.json` | Last-known-good server snapshot |
| `DATABASE_URL` | none | PostgreSQL connection used by identity, media, wallets, and jobs |
| `APP_ORIGINS` | none | Comma-separated exact browser origins accepted for account writes |
| `SESSION_COOKIE_SECURE` | production: `true` | Require HTTPS for the identity cookie |
| `SESSION_COOKIE_NAME` | secure: `__Host-kachang_canvas_session` | Identity cookie name |
| `SESSION_TTL_SECONDS` | `2592000` | Absolute session lifetime; accepted range is 1 hour to 90 days |
| `REGISTRATION_CREDIT_MICROS` | `0` | Optional initial wallet credit in integer microcredits |
| `MEDIA_STORAGE_DRIVER` | `filesystem` | `filesystem` for local/single-host use or `s3` for online deployments |
| `MEDIA_STORAGE_PATH` | `.data/media-objects` | Filesystem object root when the filesystem driver is selected |
| `MEDIA_SIGNING_SECRET` | none | At least 32 random bytes for short-lived provider media URLs |

Generation API controls default to three active tasks per account, ten submit
attempts per minute, 100 per UTC day, 180 status reads per minute, 30 SSE starts
per minute, three live SSE connections per account, and 200 per API process.
Configure these with `GENERATION_MAX_ACTIVE_JOBS`,
`GENERATION_SUBMIT_PER_MINUTE`, `GENERATION_SUBMIT_PER_DAY`,
`GENERATION_READ_PER_MINUTE`, `GENERATION_STREAMS_PER_MINUTE`,
`GENERATION_STREAMS_PER_USER`, and `GENERATION_STREAMS_GLOBAL`. SSE polling,
heartbeat, and connection lifetime use `GENERATION_SSE_POLL_MS`,
`GENERATION_SSE_HEARTBEAT_MS`, and `GENERATION_SSE_MAX_MS`.

S3 mode additionally requires `S3_BUCKET`, `S3_REGION`, and a server-only
`S3_KEY_DERIVATION_SECRET` of at least 32 bytes. Configure `S3_ENDPOINT` for a
compatible non-AWS service. `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` must be
set together unless the runtime provides an instance role. Optional settings are
`S3_FORCE_PATH_STYLE`, `S3_KEY_PREFIX`, `S3_TEMP_PATH`,
`S3_UPLOAD_TTL_SECONDS`, `S3_DOWNLOAD_TTL_SECONDS`, and
`S3_MAX_MATERIALIZED_BYTES`. API and worker processes must use identical bucket,
prefix, and key-derivation settings.

The snapshot is excluded from Git because it contains the private routing map
needed by server-side generation submission. Older snapshots without private
routes are marked non-quotable and refreshed without an `ETag`, preventing a
`304` response from preserving an incomplete snapshot. The file must never be
served as a static asset or bundled into the web app.

## Freshness and failure rules

- Catalog refreshes are deduplicated and checked at most once per 60 seconds.
- Fetches time out after 12 seconds.
- Valid full responses and `304 Not Modified` confirmations renew a ten-minute
  trusted quote window.
- Invalid payloads and request failures retain the last valid catalog.
- The stale catalog may remain visible, but new quotes are blocked after the
  trusted window expires.
- A quote lasts at most two minutes and is capped by its catalog expiry.

A quote remains advisory until `POST /api/v1/generation-jobs` revalidates it,
creates an immutable task, and reserves credits atomically.

## Database

Apply committed migrations with a dedicated Canvas PostgreSQL database:

```bash
pnpm build
pnpm --filter @kachang/canvas-api db:migrate
```

The migration command requires `DATABASE_URL`. It is idempotent and protected
by a PostgreSQL advisory lock so multiple deploy processes cannot apply the same
migration concurrently. During API-only development, `db:migrate:dev` runs the
same migration code directly from TypeScript source.

PostgreSQL integration tests require a disposable database whose name contains
`test`:

```bash
pnpm --filter @kachang/canvas-api test:postgres
```

Set `CANVAS_TEST_DATABASE_URL` for that command. The tests truncate Canvas
identity, session, media, wallet, ledger, reservation, job, lease,
reconciliation, and API limit tables; they refuse database names without `test`
as a guard against production use.

When the native profile is selected, account routes return
`503 IDENTITY_UNAVAILABLE` when `DATABASE_URL` is absent, while health, catalog,
and quote routes remain usable. Apply migrations before enabling the
database-backed native identity service. Public native registration still needs
deployment-level rate limiting, email verification, password recovery, and
abuse monitoring before an unrestricted launch.

## Reference media

Reference uploads are authenticated and never trust the filename, declared
MIME type, size, dimensions, duration, or checksum supplied by the browser.
The API creates a metadata record first, accepts raw bytes through a bounded
stream, calculates SHA-256, and marks the object ready only after server-side
inspection. Failed validation deletes the object; an interrupted write returns
the intent to `pending` so it can be retried.

Images are decoded with Sharp under pixel and dimension limits. Audio and video
containers and tracks are parsed with MediaInfo's WebAssembly build. SVG is not
accepted as reference media. Default byte limits are 25 MiB for images, 100 MiB
for audio, and 512 MiB for video. Private content reads support one HTTP byte
range so video players do not need to load a whole file.

The filesystem adapter remains appropriate for local development and one API
instance with a persistent volume. S3 mode signs a constrained upload into an
isolated `incoming/` namespace, downloads it to a bounded temporary file for the
same server-side inspection, promotes it to the private object namespace, then
publishes metadata. Authenticated reads receive short-lived signed downloads.
Logical database keys are translated to HMAC-derived physical keys before any
storage request, so capability URLs do not reveal media ids or database paths.

The bucket must allow the application origin to `PUT` signed objects and to
`GET` signed private media. Configure a lifecycle rule that deletes the physical
`incoming/` prefix after one day, plus noncurrent versions when versioning is
enabled. Never apply that short rule to the private `objects/` prefix. See
[`../../docs/MEDIA-STORAGE.md`](../../docs/MEDIA-STORAGE.md).

## Production check

```bash
pnpm build
pnpm --filter @kachang/canvas-api start
```

The native worker is deployed and started separately only for the isolated
profile with `pnpm --filter @kachang/canvas-worker start`; see its README for
required secret and media-host configuration. It remains disabled when hosted
generation is routed through Prompt Hub.

Production routing must place the web app and this API behind one origin so the
browser can keep calling `/api`. Do not expose model credentials or private
catalog snapshots through deployment environment injection into Vite.

Submitting a task does not run generation inside the request. Without a separate
healthy worker, tasks remain safely reserved and visible instead of causing an
untracked external call. Monitor both API and worker deployments.
