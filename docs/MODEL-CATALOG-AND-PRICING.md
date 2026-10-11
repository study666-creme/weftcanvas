# Kachang API Model Catalog and Pricing

Kachang API is the built-in model and generation provider. The Card Repository
is a separate optional product integration and is not involved in this flow.

## Source of truth

The Kachang API public catalog is authoritative for:

- public model id, label, and description
- modality: text, image, video, or audio
- public operation category; private request routing remains server-side
- selectable, unavailable, degraded, or retired status
- input and output capabilities
- parameter schema, defaults, options, ranges, and reference limits
- pricing unit, tiers, conversion ratio, and pricing version
- catalog, capability, and pricing versions

Canvas does not maintain fallback model names, fixed default model ids, copied
parameter lists, or local prices. The browser receives only reviewed public
catalog fields from the Canvas API.

## Target synchronization

1. The server adapter fetches the catalog with `ETag` or a version token.
2. A short polling interval detects changes when push notifications are not
   available. Webhooks or a catalog event stream may invalidate immediately.
3. The server validates the payload and stores a last-known-good snapshot.
4. A future catalog event is pushed to connected clients through SSE or
   WebSocket; until then clients revalidate the lightweight version endpoint.
5. Model pickers update without a page refresh and remain filtered by modality.

Persisted built-in model selections are reconciled only after a successful
catalog load. If the selected public id no longer exists for that modality, the
picker selects the first currently available model and persists its catalog
defaults. A failed refresh keeps the saved id so a transient catalog outage is
not mistaken for a delisting. Browser-owned custom API ids are outside this
automatic migration.

Recommended initial timing:

- version check every 60 seconds
- full catalog fetch only when the version or ETag changes
- connected-client update immediately after validation
- a clearly bounded last-known-good window during temporary API failure

The UI must not expose internal provider diagnostics or implementation stages.

## Video catalog wire contract (2026-08-18)

New video integrations use the provider-neutral `video.v1` contract. The
canonical request carries a public model id, one operation
(`text_to_video`, `image_to_video`, or `video_to_video`), prompt,
`duration_seconds`, `resolution`, `aspect_ratio`, semantic `media_inputs`, and
model-specific `options`. Media roles describe intent (`reference`,
`first_frame`, `last_frame`, `source_video`, `audio_reference`,
`style_reference`, or `element_reference`) instead of exposing a provider's
field names.

`duration_seconds`, `aspect_ratio`, and `resolution` are common controls and
stay in the main Canvas parameter area whenever the model publishes them.
Resolution means clarity; aspect ratio means orientation. A fixed-resolution
model publishes its fixed `resolution` and Canvas renders it as a locked
one-option dropdown. The execution boundary derives a provider-specific pixel
size from the selected ratio when required. Compatibility spellings such as
`duration`, `seconds`, `size`, and `ratio` remain inbound or private-route
aliases; they are never rendered as duplicate controls or emitted beside the
canonical field.

The Canvas API and browser-owned custom API build this contract from the live
catalog. Existing callers are not forced to migrate: New API continues to
accept requests without a protocol version, preserves the old task lookup
routes and response URL fields, and projects `video.v1` to the reviewed adapter
fields server-side. Normalization is one request-to-one submission and never
duplicates billing. New clients should adopt `video.v1` gradually; old saved
projects are reconciled through their existing public controls.

The production catalog is dynamic: it contained 17 selectable video models at
deployment and 18 at the final read-only check on 2026-08-17. The count is
operational evidence, not a frozen allowlist. Canvas renders controls from the
live public schema. The public projection chooses one documented field for
each parameter family; compatibility aliases are server-side routing metadata,
never additional Canvas controls or request fields. Fixed catalog values such
as `async: true`, `n: 1`, and model-specific fixed durations are server-owned
and must be included in the execution request even when they are hidden from
the browser.

MiniMax H3 publishes the resolution labels declared by the live catalog:
`768`, `1080p`, `2K`, and `4K`. The first two are the ordinary H3 video path;
`2K` and `4K` are reference-media modes and require at least one reference
image in the quote and generation request. Canvas selects the matching server
workflow at execution time, so clients send only the public model controls and
never need to provide an upstream workflow name.

H3 uses the same provider-neutral video controls as the other current models:
`duration_seconds`, `aspect_ratio`, and `resolution`. Older saved projects may
still contain `seconds`/`size` aliases; the catalog and quote layer normalize
those aliases into one public field per concept and never emit duplicate fields.

The same rule applies to image models. The public `image2-A` request contract
uses `resolution`, `aspect_ratio`, and `quality`; `size`, `aspectRatio`, and
`ratio` are compatibility spellings and are not selectable or submittable
Canvas fields. A public request and its advisory quote therefore contain one
field per concept:

```http
POST https://canvas-api.example.com/api/v1/generation-quotes
Content-Type: application/json
```

```json
{
  "modelId": "image2-A",
  "modality": "image",
  "parameters": {
    "prompt": "电影感产品图，主体清晰，背景简洁。",
    "resolution": "1k",
    "aspect_ratio": "auto",
    "quality": "standard"
  }
}
```

For H3 4K the corresponding quote includes one image reference:

```json
{
  "modelId": "minimax_h3",
  "modality": "video",
  "parameters": {
    "prompt": "让画面中的主体自然运动，镜头保持平稳。",
    "duration_seconds": 4,
    "aspect_ratio": "16:9",
    "resolution": "4K"
  },
  "inputs": { "images": 1 }
}
```

The quote endpoint rejects H3 `2K`/`4K` when `inputs.images` is zero, before a
generation task or provider request is created. Canvas-owned uploads are
converted to short-lived HTTPS media references at the server boundary, so a
browser does not need to expose a local file URL or configure separate object
storage.

The live `S-2.5-满血` contract is also catalog-driven: it accepts 4-30 seconds,
`480p`/`720p`, and `16:9`/`9:16`/`1:1`; the browser publishes the declared
reference limits of 30 images, 10 videos, and 10 audios, including optional
`first_image` and `last_image` roles. The Canvas controls and submission
normalizer must use those live limits rather than a shared 15-second or 8-item
fallback.

An inventory refresh is a companion availability signal, not a second catalog.
Transient inventory failure or a stale selectable list must not clear the
last-known-good video catalog. Only an explicit `selectable: false` entry may
hide an already-reviewed video model.

## Image catalog wire contract (2026-08-19)

Image-capable catalog entries may advertise the provider-neutral `image.v1`
contract. Its request carries a public model id, one operation
(`text_to_image`, `image_to_image`, or `image_edit`), prompt, optional
`resolution`, `aspect_ratio`, `quality`, `count`, semantic `media_inputs`, and
provider-neutral `options`. Image roles are `reference`, `style_reference`,
`element_reference`, and `mask`; clients never need to know a provider's field
names to attach a reference image.

`image.v1` is additive. Existing OpenAI-compatible image requests, saved
projects, Banana flows, Midjourney actions, and Card Library jobs keep their
existing routes and fields. Canvas and the Card Library normalize a canonical
request only at the server boundary and project it once into the reviewed
execution route, so a protocol request cannot create a duplicate submission or
second charge. A model that does not advertise the protocol remains on the
legacy projection path.

The public image catalog remains the source of truth for limits and controls.
The protocol does not invent resolution, ratio, quality, reference-count, or
output-count options; those continue to come from the live model capability
schema and quote validation. The browser therefore remains compatible with
new image models without a model-name parameter table.

Example request:

```http
POST https://canvas-api.example.com/api/v1/generation-quotes
Content-Type: application/json
```

```json
{
  "modelId": "image2-A",
  "modality": "image",
  "parameters": {
    "prompt": "电影感产品图，主体清晰，背景简洁。",
    "resolution": "1k",
    "aspect_ratio": "1:1",
    "quality": "standard"
  },
  "inputs": { "images": 0 },
  "quantity": 1
}
```

The quote and generation endpoints continue to accept the existing public
Canvas job contract. When a client sends `image.v1` directly to a compatible
generation service, the same semantic fields are accepted and the response is
projected into the existing image artifact contract (`data[].url` or
`data[].b64_json`) for old consumers.

## Current implementation

The first server boundary is implemented in `apps/api`:

- `GET /api/v1/model-catalog` returns validated public models and supports a
  `modality` filter.
- `GET /api/v1/model-catalog/version` supports lightweight version checks.
- `POST /api/v1/generation-quotes` validates model, modality, parameters, and
  reference counts before returning a fixed-precision advisory quote.
- The adapter checks for catalog changes every 60 seconds, uses a 12-second
  request timeout, and stores a server-only JSON snapshot.
- A successful full response or `304 Not Modified` renews the trusted quote
  window. Invalid or unavailable responses never replace the last valid data.
- Quotes expire after at most two minutes and can never outlive the catalog
  snapshot that produced them.

The browser receives public aliases, form capabilities, and display pricing.
It does not receive private model ids, request endpoints, parameter paths,
credentials, provider mappings, or source pricing groups. A validated private
route snapshot is frozen into each reserved job so later catalog changes cannot
silently change the execution target behind an accepted quote.

Authenticated job submission, wallet reservation, durable worker recovery, and
versioned SSE status are implemented. Browser node controls now revalidate a
loaded modality catalog every 60 seconds, build controls from the live public
schema, request a quote after relevant edits, and reject submission until the
current quote is confirmed. Completed public artifacts are inserted without
exposing private routes or model mappings.

`Midjourney v8.2 高速`, `mj-v82`, Midjourney 8.1, Midjourney 7, and Niji
7 are ordinary live-catalog models from the Canvas point of view. Model ids are
UTF-8 strings, so the Chinese characters in `Midjourney v8.2 高速` are part of
the exact public id and must not be translated or replaced. The browser renders the catalog's Chinese
aspect-ratio, clarity, stylize, chaos, and weird controls; it does not maintain
a second price or parameter table. On completion the first artifact replaces the
generating parent node, while every additional artifact is connected in one
vertical column to its right. The placement rule applies to all multi-output
generation models.

The public Canvas entry for the two 8.2 ids uses the provider-neutral image
protocol. Quote example:

```http
POST https://canvas-api.example.com/api/v1/generation-quotes
Content-Type: application/json
```

```json
{
  "modelId": "Midjourney v8.2 高速",
  "modality": "image",
  "parameters": {
    "prompt": "电影感城市夜景，雨后街道倒映霓虹灯光。",
    "aspect_ratio": "16:9",
    "raw": false
  },
  "quantity": 1
}
```

Both public 8.2 entries submit to `/v1/midjourney/generations`, require `model`
and `prompt`, and fix `n` at `1`. They accept `size`, `raw`, and optional
`image`/`images`; only `mj-v82` accepts `resolution` with `1K` or `2K`. Canvas
uses `aspect_ratio` in `image.v1` and projects it to `size` on dispatch. One
request returns four images and is priced as one request.

For the Chinese id, the equivalent request uses the exact public value
`Midjourney v8.2 高速`; do not translate or normalize the model string.

## Server catalog normalization boundary

The server adapter may inject reviewed fallback entries when the upstream
catalog omits them (Midjourney 8.1/7/Niji 7, reviewed legacy text models, and
the SD2 nine-image face route). These fallbacks live only inside the server
normalization boundary in `apps/api/src/catalog/normalize.ts`; the browser never
carries a fallback price or parameter table. Each Midjourney fallback entry
(`mj-v81`, `mj-v7`, `mj-niji7`) uses the product decision confirmed on
2026-08-10: one request costs 40 credits / CNY 0.4 with a 100 credit-per-yuan
conversion and returns four single-image artifacts. The 40/0.4 price is a
product pricing decision. When the live catalog provides a Midjourney entry,
its published price remains authoritative. Normalization pins the public output
contract to four artifacts and one submission (`n: 1`), so the four delivered
artifacts can never be interpreted as four separate paid calls.

When the upstream `pricing_version` is empty, missing, or the `unknown` sentinel
(any casing, with surrounding whitespace), normalization derives a deterministic
content-based pricing version from the price-relevant content of the normalized
public catalog (each selectable model's id, output count contract, and pricing
plus the catalog credit ratio). A selectable paid quote therefore never carries
an `unknown` pricing version, the derived version is stable across identical
refreshes, and it rotates whenever price-relevant content changes. A valid
non-empty upstream `pricing_version` is preserved unchanged. Timestamps are never
part of the derived version.

## Submission safety

The browser catalog is advisory. Every generation submission is checked again
on the server:

- model is selectable for the requested modality
- submitted parameters satisfy the current schema
- reference counts and media kinds are valid
- the quote has not expired
- the quote pricing version matches the accepted catalog version

The job service creates an immutable record containing the model
id, public label, catalog version, capability version, pricing version, quote,
and idempotency key before invoking generation.

## Operator model overrides (2026-09-10)

The upstream catalog is the default pricing authority, but an operator can
override visibility and retail price per public model without waiting for an
upstream change. Overrides live in `apps/api/src/catalog/overrides.ts` and are
applied when the catalog is read, so they affect the picker, quotes, and new
jobs while leaving the cached upstream snapshot untouched; clearing an override
immediately restores the source price.

The admin surface is served by the Canvas API itself and is enabled only when
`MODEL_OVERRIDES_ADMIN_SECRET` is set (otherwise every admin route 404s):

- `GET /admin/model-overrides` — self-contained operator page (secret held in
  sessionStorage, sent as `x-model-overrides-secret`).
- `GET /api/v1/admin/model-overrides` — raw catalog rows plus current
  overrides. This read bypasses overrides so a hidden model can be re-shown.
- `PUT /api/v1/admin/model-overrides` — replace the override set. Body:
  `{ "models": { "<public id>": { "hidden"?: boolean, "sortOrder"?: number,
  "price"?: { "yuan"?: number, "byResolution"?: { "<resolution>": number } } } } }`.

State is a JSON file at `MODEL_OVERRIDES_PATH` (default
`.data/model-overrides.json`). A price override rotates the catalog
`pricingVersion` so already-issued quotes are not silently repriced; a
visibility-only edit keeps the upstream version.

### Banana line group-standard prices

The 卡藏 catalog publishes one price per model, but some 香蕉 lines bill on a
specific NewAPI group whose standard differs from the published top-level
price. The group standards (from the deployment's pricing endpoint) are:

| public id | group | standard (CNY) |
| --- | --- | --- |
| `nano-banana-2` | 生图 | 0.06 |
| `nano-banana-pro` | 生图 | 0.062 |
| `nano-banana-2-a` | 稳定香蕉 | 0.08 |
| `nano-banana-pro-a` | 稳定香蕉 | 0.10 |

`nano-banana-2`, `nano-banana-pro`, and `nano-banana-2-a` already match their
group standard. `nano-banana-pro-a` is published at 0.07 and must be corrected
either in the upstream catalog or with an override
(`{"models":{"nano-banana-pro-a":{"price":{"yuan":0.1}}}}`). The override value
is the operator's own retail price, which may sit above the group standard.

## Price changes

- New quotes use the newest validated pricing snapshot.
- An accepted, unexpired reservation keeps its quoted price for that job.
- A changed price never silently alters an already submitted job.
- Retry and reconnect resume the existing job and reservation.
- A genuinely new generation receives a new quote.
- Canvas credits mirror the catalog conversion and tiers without client-side
  rounding; fixed-point microcredits preserve fractional values.

## Model availability changes

- Newly selectable models appear in the correct modality list automatically.
- Disabled or retired models disappear from new-generation choices.
- Existing nodes retain the historical public label and generation metadata.
- A retired model on an existing node prompts model reselection rather than
  breaking project loading.
- Default selection is capability-based and chooses an active catalog model;
  it is not a hard-coded model id.

## Failure behavior

- An invalid catalog never replaces the last-known-good snapshot.
- Stale state is recorded internally and bounded by policy.
- New paid jobs are blocked when no trustworthy current quote is available.
- Existing jobs continue polling and recovering independently of catalog sync.
- Catalog and generation errors use product-facing messages without revealing
  private provider details.

## Non-Midjourney image/video model matrix (2026-08-10)

Every currently selectable non-Midjourney image/video model is exercised
end-to-end through the production chain with fixtures only. The selectable
matrix is derived from current code and repo fixtures, not from a hard-coded
list, and lives in `apps/api/src/catalog/nonmj-catalog-fixture.ts` with
construction/quote/route coverage in `apps/api/src/catalog/nonmj-catalog.test.ts`
and hosted/native full-chain and boundary coverage in
`apps/api/src/generation/nonmj-full-chain.test.ts`,
`nonmj-native-chain.test.ts`, and `nonmj-boundaries.test.ts`.

Image: `gpt-image-2-1k`, `gpt-image-2`, `gpt-image-2-ext`, `gpt-image-2-free`,
`image2`, `image2-economy`, `image2-4k-fast`, `image2-A`, `nano-banana`,
`nano-banana-fast`, `nano-banana-2-lite`, `nano-banana-pro`, `nano-banana-2`,
`lingtu`, `lingtu-fast`, `lingtu-lite`, `grok-imagine-image`.

Video: `grok-imagine-video`, `grok-imagine-video-1.5`,
`kling-o3-pro-v2v-reference`, `sd2.0-480p`, `sd2.0-720p`, `motion-video`,
`motion-video-1-5`, `firefly-seedance2-fast-480p`, and the injected reviewed
face-route card `sd2.0 pro 满血九图卡脸版`.

Verified production-path boundaries:

- A definitive upstream `VALIDATION_ERROR` (observed for `image2-A` and
  `grok-imagine-image`) is surfaced as the product error on a failed job with
  exactly one submission and never a fabricated success. The validation details
  are captured as a sanitized diagnostic. The public `image2-A`
  body is the reviewed `resolution`/`aspect_ratio`/`quality` contract; its
  compatibility aliases are excluded before the quote and submission layers.
- `nano-banana` maintenance: a `selectable: false` catalog entry disappears
  from new-generation quotes, and a definitive upstream maintenance rejection
  surfaces the provider message without fabrication.
- A long-running `gpt-image-2-ext` job frozen at 48% stays read-only (no
  second POST, no duplicate artifact, public version does not advance) and the
  browser shows the explicit "生成长时间未推进" stalled marker after three
  minutes without progress.
- `kling-o3-pro-v2v-reference` `submission_unknown` recovery is read-only
  lookup first, then a bounded replay of the exact same idempotency key after
  a confirmed miss, capped at eight attempts, never minting a new key.
- `sd2.0-480p` vendor failure surfaces the upstream refunded/error status and
  message; the native path refunds the reservation on a definitive rejection.

### Post-deployment minimum verification order (zero extra paid clicks)

1. Confirm `GET /api/v1/model-catalog` exposes the expected non-MJ image/video
   ids and the derived non-`unknown` pricing version.
2. Quote `gpt-image-2-1k`, `image2-A`, `grok-imagine-image`, `nano-banana`,
   `kling-o3-pro-v2v-reference`, and `sd2.0-480p`; confirm the credit/yuan
   values match the catalog pricing.
3. For `image2-A` and `grok-imagine-image`, submit through a validation-only or
  zero-cost path and capture the product-facing validation details. The
   Canvas request itself must contain only the documented public fields.
4. Confirm `nano-banana` maintenance/selectable state mirrors the upstream.
5. Confirm a running `gpt-image-2-ext` job shows the stalled marker after three
   minutes without progress and never creates a second POST.
6. Confirm wallet ledger reads remain compatible and no account debit changed.
