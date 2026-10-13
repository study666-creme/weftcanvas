# Upstream contract

The canvas does not ship a fixed list of models. It reads **your** model catalog
and follows it: list a model and it appears, rename it and the label changes,
change a price and quotes move. The only thing you publish is one JSON document.

This page is the whole contract. It is deliberately small, and it says what the
canvas **derives for you** so you do not have to match our internal shape.

## Verify first, read later

```bash
node apps/api/scripts/upstream-conformance.mjs \
  --catalog-url https://your-relay.example.com/api/model-catalog \
  --api-base     https://your-relay.example.com \
  [--pricing-url https://your-relay.example.com/api/pricing] \
  [--video-inventory-url https://your-relay.example.com/api/video-inventory] \
  [--api-key sk-...]
```

It is read-only. It tells you how many models the canvas can use, which rows it
would skip and why, and which optional fields it will derive. Exit code `0`
means the canvas can drive your upstream as configured.

## Point the canvas at your upstream

Set these on the `api` service (see [`docs/DEPLOYING.md`](DEPLOYING.md) for the
table): `CANVAS_API_PROVIDER=dev-test` plus
`CANVAS_UPSTREAM_CATALOG_URL` / `CANVAS_UPSTREAM_VIDEO_INVENTORY_URL` /
`CANVAS_UPSTREAM_PRICING_URL` / `CANVAS_UPSTREAM_API_BASE_URL`.

## The document

```jsonc
{
  "models": [
    {
      "id": "your-internal-model-id", // stable id you use upstream
      "modality": "image", // text | image | video | audio
      "operation": "generate",
      "public": {
        // what the user sees
        "id": "your-public-id",
        "label": "显示名称",
        "description": "一句话说明",
      },
      "selectable": true, // false = keep it out of the picker
      "parameters": [
        // the picker is built from this list
        { "name": "prompt", "type": "string", "required": true, "label": "提示词" },
        {
          "name": "quality",
          "type": "string",
          "default": "2k",
          "options": ["1k", "2k", "4k"],
          "label": "分辨率",
        },
      ],
      "pricing": {
        "mode": "tiered", // fixed | tiered | token | tiered_token
        "unit": "image", // request | image | second | token
        "currency": "CNY",
        "credits_per_yuan": 100, // your credit unit → CNY
        "tiers": [{ "when": { "quality": "2k" }, "credits": 15 }],
      },
    },
  ],
}
```

`parameters` is optional and drives the controls the user sees; without it the
canvas still lists the model and sends only the prompt. `tiers[].when` keys are
the parameter names above, so pricing and controls stay in one place.

## What the canvas derives (you do not have to publish it)

These are the "letterhead" fields. Any of them may be missing, blank, or written
in camelCase instead of snake_case:

| Field                            | If you omit it                                      |
| -------------------------------- | --------------------------------------------------- |
| `success`                        | treated as `true` — a bare object is fine           |
| `fetched_at` / `fetchedAt`       | stamped when the canvas fetched it                  |
| `version` / `capability_version` | derived from the content, so it changes when you do |
| `pricing_version`                | derived from content                                |
| `credits_per_yuan` (top level)   | treated as `1` (display conversion only)            |

The model list itself may also be an OpenAI-style `data[]` array.

## What the canvas refuses to guess

**Per-model prices.** Money is not inferred: a row without a valid `pricing`
object is skipped, and a catalog in which nothing is priced is rejected outright
rather than published as an empty picker. The probe lists exactly which rows were
skipped and why.

If your upstream publishes only `/v1/models` (ids, no prices), the server-side
billing path cannot drive it. That case is covered by the canvas's browser-owned
API mode instead: each user connects their own OpenAI-compatible endpoint with
their own key, and the canvas never prices or charges. See
[`apps/web/README.md`](../apps/web/README.md).

## Optional documents

- **Video inventory** (`CANVAS_UPSTREAM_VIDEO_INVENTORY_URL`): which video models
  currently have a working channel. Omit it and video models are published as
  declared in the catalog.
- **Pricing document** (`CANVAS_UPSTREAM_PRICING_URL`): upstream rates used as a
  reference for token-priced models.

## Why this shape

The canvas needs three things a picker cannot fake: **what models exist**, **what
the user can choose** (parameters), and **what a generation costs** (pricing).
Everything else is bookkeeping. Publishing those three is the whole integration
cost — no plugin, no code fork, and no need to match our internal file layout.
