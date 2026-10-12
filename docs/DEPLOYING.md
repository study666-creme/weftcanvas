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
