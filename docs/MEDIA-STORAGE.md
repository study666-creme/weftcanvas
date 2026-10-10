# Media Storage Boundary

Canvas media bytes never belong in PostgreSQL. PostgreSQL owns identity,
private object references, upload state, trusted metadata, checksums, and audit
timestamps. An object-store adapter owns the bytes.

## Implemented upload lifecycle

```text
pending -> uploading -> ready
                     -> failed
          interrupted -> pending
```

1. An authenticated user creates an upload intent with an idempotency key.
2. PostgreSQL fixes ownership, kind, expected byte count, optional SHA-256, and
   an opaque object key.
3. Exactly one uploader claims the current revision.
4. A proxy upload streams to an atomic temporary file. A direct upload lands in
   the quarantined object prefix and is materialized only by its completion call.
   Both paths enforce exact and maximum byte counts while calculating SHA-256.
5. The inspector decodes image pixels or parses audio/video container tracks.
6. A compare-and-swap update publishes only trusted metadata and marks the
   object ready. Invalid content is removed and receives a safe public error.

An active `uploading` claim blocks duplicate completion. If its process dies or
database finalization is genuinely lost, the claim becomes recoverable after a
bounded processing timeout and returns to `pending` through compare-and-swap.

Refreshing or retrying an intent with the same idempotency key returns the same
record. Reusing that key for different immutable input is rejected. A user can
never read or write another user's media id, and public contracts omit owner ids
and object keys.

## Inspection

- Images: Sharp parses and decodes pixels, including bounded animated frames.
  Width, height, format, total pixels, and input errors are validated.
- Video: MediaInfo parses the container and requires a video track, dimensions,
  duration, and recognized media type.
- Audio: MediaInfo requires a finite audio track and rejects files that also
  contain a video track.
- Every ready object has an exact byte count and SHA-256 digest.

The API currently accepts reviewed common raster image, video, and audio MIME
types. SVG is excluded because active and external content makes it unsuitable
for a trusted reference-media path.

## Filesystem adapter

`FilesystemMediaObjectStore` is a complete local adapter with bounded streaming
writes, atomic temporary-file promotion, traversal protection, private reads,
and byte ranges. It is suitable for development or one API instance backed by
a persistent volume.

Multiple API replicas cannot safely share an ordinary local directory, and a
container's ephemeral filesystem loses data after redeployment. Use it only for
development or a deliberately single-host deployment with a persistent volume.

## S3-compatible adapter

`S3MediaObjectStore` is the production adapter. It provides:

- short-lived direct PUT capabilities with signed content length and optional
  SHA-256 constraints
- an isolated `incoming/` namespace that cannot overwrite published media
- a completion endpoint that downloads into a bounded private temporary file,
  recalculates SHA-256, decodes/parses the media, then promotes valid bytes
- ETag-bound `GET If-Match` and `CopySourceIfMatch`, preventing a still-valid PUT
  capability from swapping bytes between inspection and promotion
- private signed GET capabilities issued only after account or provider-link
  authorization
- native range reads for API proxy fallback and internal consumers
- automatic cleanup of normal temporary materializations and startup cleanup of
  stale adapter-owned directories
- HMAC-derived physical keys, with distinct derivation domains for quarantine
  and published objects

The browser must never receive object-store credentials or choose an object key.
The signed capability contains only an opaque physical digest. Media ids and the
logical object references stored in PostgreSQL are not embedded in storage URLs.
Generated image and video outputs now pass this same validation boundary before
wallet capture. Normal materialized downloads are removed in `finally`, stale
crash leftovers are removed at worker startup, and staged result records are
removed after a completed or definitively failed task. Retryable validation work
retains its staged record.

## Bucket requirements

- Keep the bucket private and block anonymous list, read, and write access.
- Allow only the product origin to use signed `PUT` and signed `GET` requests.
- Apply a one-day expiration rule to `${S3_KEY_PREFIX}/incoming/`.
- Never apply the short incoming rule to `${S3_KEY_PREFIX}/objects/`.
- If versioning is enabled, expire noncurrent incoming versions as well; an
  ordinary delete marker alone does not stop old versions from consuming space.
- Enable encryption, access logs, storage usage alerts, and an explicit backup
  policy appropriate to the product's retention promise.

`S3_KEY_DERIVATION_SECRET` is part of the storage mapping and must be shared by
all API and worker replicas. Back it up as a production secret. Rotating it
without a migration makes existing objects unreachable. Credentials, endpoint,
bucket, prefix, and this secret remain server-only and must never use a `VITE_`
environment variable.

For generation routes that require a public reference URL, the worker first
checks media ownership and readiness, then creates a short-lived HMAC URL on the
Canvas API. The signature binds media id, kind, and expiry. The API streams this
authorized request instead of assuming every model service follows storage
redirects. Inline-capable image routes may instead receive a bounded data URI.
Neither route exposes an object key or storage credential.

## Bounded browser media loading

A completed generation result whose media bytes never arrive, or whose decode or
metadata never settles, must not leave the node on an indefinite spinner: the
node stays truthful (the completed generation truth is never changed) while the
media surface settles to the existing explicit media-load error/retry state.

- `BoundedImageLoader` gives every attempt one explicit per-attempt deadline
  (default 12 s) covering fetch plus `blob()` plus decode plus the native image
  fallback. A never-resolving fetch or hung decode settles the acquire, aborts
  the pending fetch on timeout, keeps retry count/backoff bounded, and releases
  the loader concurrency slot in every path; a late completion after the attempt
  settled or the component unmounted is ignored. A generated image whose media
  cannot be loaded leaves loading and shows the existing "结果加载失败" surface.
- `NodeVideoPlayer` bounds its metadata and ready-state waits with cleanup-safe
  timers (metadata 12 s, ready 45 s) that are cleared on phase change, source
  change, and unmount. A delayed-but-arriving video still displays; a video that
  never produces a usable event settles to the explicit "视频加载失败" retry
  state. No unexpected autoplay, media ownership change, or timer/object-URL
  leak occurs.
