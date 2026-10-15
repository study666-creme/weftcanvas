# Self-hosting with Docker

The default stack runs the web app, Canvas API and PostgreSQL. Local projects
and browser BYOK work without a generation worker. Server generation is an
optional profile and requires a compatible catalog, credentials and result hosts.

## Start the stack

1. Copy `.env.example` to `.env`. Set `POSTGRES_PASSWORD` and
   `IDENTITY_SESSION_SECRET` (at least 32 bytes). For example, on Linux/macOS:

   ```bash
   { echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"; \
     echo "IDENTITY_SESSION_SECRET=$(openssl rand -hex 32)"; } > .env
   ```

   On Windows PowerShell, copy the template with `Copy-Item .env.example .env`
   and enter independently generated secrets in the file.

2. Build and start:

   ```bash
   docker compose up --build -d --wait
   ```

3. Open `http://127.0.0.1:8080`. In settings, add a BYOK configuration using
   the [relay connection guide](CONNECTING-RELAYS.md).

`WEB_PORT` defaults to `127.0.0.1:8080`; `API_PORT` to `127.0.0.1:8787`.
The API image sets `CANVAS_API_HOST=0.0.0.0` for container networking; host
ports remain bound to loopback by default. Running Node directly defaults to
`127.0.0.1` unless `CANVAS_API_HOST` is set explicitly.
`APP_ORIGINS` must match the browser origin if you change the port or domain.
For a public domain, use HTTPS and proxy `/api/` and `/admin/` through `web`.
The production API requires secure session cookies; local loopback is the
development access path. Browser BYOK does not require login.

## Services and persistence

| Service    | Role                                             | Persistent state                      |
| ---------- | ------------------------------------------------ | ------------------------------------- |
| `web`      | nginx, same-origin API and operator-page proxy   | None                                  |
| `api`      | Native identity, catalog, media and durable jobs | PostgreSQL and `/repo/.data`          |
| `postgres` | Application records and job queue                | `canvas-db` volume                    |
| `worker`   | Optional durable generation execution            | Shared `/repo/.data` in `canvas-data` |

The API applies migrations before starting. The worker waits for API readiness,
so it starts after migrations. API and worker share media objects, result staging
and download paths. Catalog snapshots and model overrides use the same data volume.
Recreating containers preserves both named volumes. `docker compose down --volumes`
deletes them; back up both database and data before an upgrade or migration.

The bundled PostgreSQL service is accessible only within the Compose network.
Its connection URL explicitly uses `sslmode=disable` because that container has
no TLS listener. Configure TLS separately when using a remote database.

Projects and BYOK keys remain in each browser. Project JSON exports contain media
references, not media files; server backups do not back up local browser data.

## Optional server catalog and generation

Compose passes the following `.env` settings to the relevant services:

| Variable                                        | Purpose                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `CANVAS_UPSTREAM_CATALOG_URL`                   | Catalog satisfying [UPSTREAM-CONTRACT.md](UPSTREAM-CONTRACT.md)  |
| `CANVAS_UPSTREAM_PRICING_URL`                   | Optional token-pricing reference document                        |
| `CANVAS_UPSTREAM_VIDEO_INVENTORY_URL`           | Optional video availability document                             |
| `CANVAS_UPSTREAM_API_BASE_URL`                  | Native worker submit/observe endpoint                            |
| `CANVAS_UPSTREAM_API_KEY`                       | Worker credential, server-only                                   |
| `GENERATION_MEDIA_HOSTS`                        | Comma-separated trusted result hostnames; required by the worker |
| `MEDIA_SIGNING_SECRET`, `MEDIA_PUBLIC_BASE_URL` | Configure together for signed reference-media access             |
| `REGISTRATION_CREDIT_MICROS`                    | Native signup credit, default `0`                                |

The worker endpoint must use HTTPS and the native generation provider's supported protocols. A generic
`/v1/models` list is enough for browser BYOK discovery, but not for server pricing
or arbitrary generation protocols. Verify the catalog with the read-only probe
and test the intended modalities separately before enabling server generation.

```bash
docker compose --profile generation up --build -d --wait
```

The worker still accepts legacy `WEFTCANVAS_API_BASE_URL` and `WEFTCANVAS_API_KEY`
when neutral variables are unset. Browser advanced-protocol settings apply to
browser BYOK only and do not configure the worker.

## Operator pages

Set `MODEL_OVERRIDES_ADMIN_SECRET` to enable model administration. The ops console
uses `CANVAS_OPS_ADMIN_SECRET`, falling back to the model secret when unset.
Use the same secret for both pages unless separate access is intentional.

- `/admin/ops`: operator console — overview (users, projects, media, 24h job
  success/failure, queue backlog, catalog freshness, 7-day model health), user
  directory, recent jobs, and model listing/pricing controls. Styled from the
  canvas palette (light 石墨 / dark 墨黑). The overview, user and job sections
  read the database; the model section works from file storage alone.
- `/admin/model-overrides`: model visibility and overrides (the same API as the
  console's model section; embeddable in an existing operator surface).

nginx proxies these paths to the API. Leaving both secrets unset disables the
surfaces. These pages are operational tools; they do not provide a complete
membership, payment or license-management backend.

## Updates and troubleshooting

```bash
git pull
docker compose up --build -d --wait
docker compose logs --tail 100 api
```

If startup fails, check the required secrets, PostgreSQL health and API logs.
If the worker fails, check its key, endpoint and trusted result hosts. For BYOK
failures, check browser Network output and the relay's CORS/protocol settings.

CI builds this stack and checks startup, operator proxying, container recreation
and shared-volume persistence using an isolated project and synthetic data.
For production, configure TLS, backups and suitable storage independently.
