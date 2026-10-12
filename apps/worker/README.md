# Canvas Worker

This process owns durable background work. It runs exactly one of two modes,
selected explicitly and validated fail-closed at startup:

- `media-multipart` (`GENERATION_WORKER_ENABLED=false`,
  `MEDIA_MULTIPART_WORKER_ENABLED=true`) runs the durable multipart media
  inspection queue. It needs only the media contract below and never requires
  or reads generation credentials or hosts, never constructs the generation
  provider, and never sends a generation request.
- `generation` (`GENERATION_WORKER_ENABLED=true`,
  `MEDIA_MULTIPART_WORKER_ENABLED=false`) owns durable generation execution. It
  leases runnable jobs from PostgreSQL, submits or polls one state transition at
  a time, validates staged results, persists final media, and settles wallet
  reservations.

Both flags must be set to `true` or `false`. Enabling both, disabling both, or
using any other value fails startup with a clear error, so a misconfigured
worker can never accidentally start generating.

The worker is intentionally separate from the public API process. `pnpm dev`
does not start it, preventing an ordinary UI development session from consuming
model usage. Apply database migrations first, then start it explicitly:

```bash
pnpm --filter @weftcanvas/canvas-api db:migrate
pnpm dev:worker
```

Required environment variables for every mode:

- `DATABASE_URL`
- `GENERATION_WORKER_ENABLED`
- `MEDIA_MULTIPART_WORKER_ENABLED`

Generation mode additionally requires:

- `WEFTCANVAS_API_KEY`
- `GENERATION_MEDIA_HOSTS`: comma-separated exact or `*.suffix` host rules for
  generated image and video downloads

Reference video/audio delivery also requires both `MEDIA_SIGNING_SECRET` and
the HTTPS `MEDIA_PUBLIC_BASE_URL` of the API. Image parameters that accept a
data URI can work without a public media URL.

`MEDIA_STORAGE_DRIVER=filesystem` requires the API and worker to share one
persistent volume. Do not run multiple hosts with independent local media
directories. For S3 mode, both processes must share `S3_BUCKET`, `S3_REGION`,
optional endpoint/credentials, `S3_KEY_PREFIX`, and
`S3_KEY_DERIVATION_SECRET`. The worker cleans stale local media materializations
at startup; `WORKER_TEMP_RETENTION_MS` defaults to 24 hours. The bucket must also
expire the physical `incoming/` prefix independently.
