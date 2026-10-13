# Self-Hosting (Docker)

One `docker compose up` gives you the canvas web app, the Canvas API, and
PostgreSQL. An optional worker profile adds durable server-side generation.

## What you get

| Service    | Role                                                             |
| ---------- | ---------------------------------------------------------------- |
| `web`      | nginx serving the built canvas app; proxies `/api` to the API    |
| `api`      | Canvas API — native identity, wallet, catalog, durable job store |
| `postgres` | the only required backing store                                  |
| `worker`   | (profile `generation`) durable generation execution              |

The API runs with `CANVAS_API_PROVIDER=dev-test`: native PostgreSQL identity
and wallets, zero external services. The canvas is usable immediately —
projects live in your browser, and model calls can run browser-direct via
BYOK (Configuration → Custom API) without any worker.

## Requirements

- Docker with Compose v2.

## Setup

1. Create a `.env` next to `docker-compose.yml` with two secrets:

   ```bash
   { echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"; \
     echo "IDENTITY_SESSION_SECRET=$(openssl rand -hex 32)"; } > .env
   ```

   Optional: `WEB_PORT` (default `8080`, bound to `127.0.0.1`), `API_PORT`,
   `REGISTRATION_CREDIT_MICROS` (signup credit grant; default `0`).

2. Build and start:

   ```bash
   docker compose up --build -d
   ```

   Open `http://127.0.0.1:8080`. If you put it behind a reverse proxy or
   domain, point that proxy at `web` and keep `/api` same-origin.

3. (Optional) durable server-side generation — start the worker with an
   OpenAI-compatible endpoint; without credentials jobs fail honestly rather
   than pretending:

   ```bash
   docker compose --profile generation up -d
   ```

## Point the canvas at your own upstream

The canvas does not hard-code a model source: it reads a model catalog (models +
each model's parameter schema + pricing) and a pricing document from whatever
upstream you configure. An upstream that publishes those documents is enough —
no code change, no plugin, and the canvas follows listings, renames, and price
changes automatically.

Set these on the `api` service (all optional; unset means "no upstream"):

| Variable                              | Purpose                                                         |
| ------------------------------------- | --------------------------------------------------------------- |
| `CANVAS_API_PROVIDER`                 | `dev-test` for self-hosting (no hosted account/wallet coupling) |
| `CANVAS_UPSTREAM_CATALOG_URL`         | Your model catalog document                                     |
| `CANVAS_UPSTREAM_VIDEO_INVENTORY_URL` | Optional video availability document                            |
| `CANVAS_UPSTREAM_PRICING_URL`         | Optional station text-pricing document                          |
| `CANVAS_UPSTREAM_API_BASE_URL`        | Base URL used for generation submit/observe                     |
| `CANVAS_UPSTREAM_AUTH_BASE_URL`       | Optional upstream auth base (only when delegating accounts)     |
| `CANVAS_UPSTREAM_ANON_KEY`            | Optional upstream credential                                    |
| `CANVAS_UPSTREAM_REQUEST_TIMEOUT_MS`  | Upstream request timeout (default `45000`)                      |

Older deployments used provider-branded names for the same settings
(`CATALOG_SOURCE_URL`, `VIDEO_INVENTORY_URL`, `WEFTCANVAS_*`, `PROMPT_HUB_*`,
`VITE_CARD_LIBRARY_*`). Those still work and are read after the neutral names, so
existing configurations keep running unchanged.

**Note**: the hosted commercial provider is not part of self-hosting; the SPI
assembly refuses to start if a build references a provider module that is not
compiled in.

## Updates

```bash
git pull
docker compose up --build -d
```

Migrations run automatically when the API container starts.

## Notes

- The hosted commercial provider (`weftcanvas`) is not part of self-hosting; the
  SPI assembly refuses to start if a build references a provider module that is
  not compiled in.
- Media uploads land in the `canvas-data` volume under the API service.
- This guide covers the single-host demo topology; production hardening (TLS,
  backups, object storage) is on you or your vendor.
