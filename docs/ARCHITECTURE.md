# Architecture Boundary

## Official production entry point

The only official production entry point is:

托管站点域名（部署侧配置）

Vercel deployment URLs, legacy aliases, and local development URLs are not
production links. The browser and API are exposed through the same-origin
`/api` path behind this entry point.

## Product split

Canvas Next is a private monorepo containing several independently deployable
runtimes. The Agent is part of the product but remains isolated from browser
state and secrets.

```text
Browser Canvas
  -> Canvas API (product boundary and same-origin session)
     -> Prompt Hub (identity, membership, shared credits, hosted generation)
        -> NewAPI or another configured model provider
  -> Canvas Agent (private prompts and orchestration, through the API)
```

The official hosted product has one account and credit authority: Prompt Hub.
The Canvas API owns Canvas-specific validation, projects, media, Agent access,
and public contracts, but it does not own or mirror a second writable balance.

## Monorepo layout

```text
apps/web       Browser product and local-first canvas runtime
apps/api       Product API; sessions, media, catalog, quote, and PostgreSQL adapters
apps/agent     Private Agent runtime
apps/worker    Durable leased generation and media-processing runtime
packages/contracts      Versioned commands, events, and API schemas
packages/canvas-core    Framework-independent canvas domain model
packages/ui             Product UI components and tokens
packages/motion         Motion primitives and interaction feedback
```

## Canvas responsibilities

- Infinite viewport, selection, nodes, connections, groups, and shortcuts.
- Image, video, audio, text, and director-stage presentation.
- Local-first editing with optional account-scoped cloud synchronization.
- Generation job submission, durable status, recovery, and validated media.
- A generic, versioned Agent client with no private prompts or credentials.

The current browser keeps an indexed library of editable projects in local
storage. Each project has an independent graph, viewport, groups, generation
bindings, and undo history while it is active. Project switching persists the
current snapshot before replacing runtime state. Local media remains in
IndexedDB and may be referenced by more than one duplicated project.

A node may persist a public model id, public parameter values, quote-related
output limits, and the latest public job version. When a submitted job needs a
local reference, authenticated upload records only an owner-scoped media id.
Generated media is rendered from the protected same-origin media route.

## Private Agent responsibilities

- Planning, tool orchestration, retrieval, and quality review.
- Private prompts, distilled knowledge, source metadata, and evaluation data.
- Canvas-specific quotas, abuse controls, and Agent audit logs. Shared account,
  membership, and billing authority remain in Prompt Hub.
- Model credentials and provider-specific behavior.

## Non-negotiable boundaries

- Browser code cannot import Agent runtime or server-only packages.
- Agent code cannot read or mutate React state, DOM nodes, or client stores.
- Agent canvas changes use versioned commands with validation and audit logs.
- Runtime communication uses documented HTTPS, SSE, WebSocket, or queue events.
- Browser sessions use short-lived credentials; model keys never reach clients.
- Canvas remains usable without the official Agent service.
- Identity, wallet, storage, and model catalogs are provider interfaces.
- The official deployment configures the Prompt Hub adapter for identity,
  membership, wallet operations, card access, and hosted generation.
- Prompt Hub is the only writable shared-credit ledger. Canvas must not copy,
  reconcile, or independently mutate a product balance.
- NewAPI and other model providers are downstream generation infrastructure,
  reached through Prompt Hub in the official deployment.
- Native identity, wallet, and generation adapters are allowed only in
  isolated development, tests, or an explicitly self-hosted deployment. They
  are not a fallback for hosted production.
- No Kachang credential, private model mapping, or provider response is shipped
  to the browser.
- Catalog snapshots containing private routing ids remain in ignored server
  storage. Browser responses are reconstructed from reviewed public contracts.
- Generation state transitions are server-owned. Authenticated job routes use
  database request windows, transactional active-task limits, and versioned SSE;
  the API still never constructs a generation client.
- Browser task observation prefers SSE, falls back to bounded snapshot polling,
  and recovers the newest task per node after an authenticated refresh. Closing
  a panel never changes task state.
- S3-compatible storage maps private logical references to HMAC-derived physical
  keys. Browser uploads land in a quarantined namespace and become readable only
  after server inspection and database publication.
- Execution routes and credentials remain server-only. A job freezes its route
  versions at reservation and stores only an opaque staged-result reference.

## Deployment profiles

| Profile | Identity and credits | Generation | Intended use |
| --- | --- | --- | --- |
| Official hosted | Prompt Hub, one shared ledger | Canvas API -> Prompt Hub -> provider | 托管站点域名（部署侧配置） |
| Isolated native | Canvas-local adapters | Native worker/provider adapter | Development, tests, explicit self-hosting |

Selecting the isolated profile is an explicit deployment decision. The hosted
profile must fail closed when Prompt Hub credentials or connectivity required
for identity and charging are unavailable; it must not silently create or use
a local balance.
