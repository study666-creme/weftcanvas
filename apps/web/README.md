# Canvas Web

The desktop web client: a pointer-first infinite canvas built with React and
XYFlow. Nodes are previews, not dialogs; pan, zoom, node drag, selection, and
connection feedback stay immediate. The UI is quiet, compact, and graphite-based
in two colour schemes (石墨 / 墨黑).

## Running it

From the repository root:

```bash
pnpm install
pnpm dev:web        # http://127.0.0.1:4173
```

`pnpm dev` starts contracts, the canvas API, and this app together. The web app
works standalone: projects are local-first in browser storage, and model calls
run through explicit BYOK (see below) or through the Canvas API when configured.

## Model access

- **BYOK (custom API):** Configuration → Custom API stores your own limited key
  in this browser's `localStorage` only. It never enters source, project JSON, or
  the Canvas API. Text, image, and video generation run directly from the
  browser; results are not durable server-side jobs.
- **Hosted:** when the Canvas API is configured, generation runs as durable
  server-side jobs (see [`../../docs/GENERATION-JOBS.md`](../../docs/GENERATION-JOBS.md)).

## Layout

- `src/components/` — canvas workspace, nodes and edges, dialogs, entry gate,
  Agent drawer, resource drawer.
- `src/lib/` — canvas logic: store adapters, custom API clients, media helpers,
  clipboard ingestion, feature flags (`canvas-features.ts`).
- `src/state/` — Zustand stores (canvas, agent, cloud projects, wallet).
- `src/appearance-packs/` — pluggable node/appearance packs.
- `public/` — static assets (entry films, Agent sprites, MediaPipe wasm).
- `e2e/` — Playwright specs against a real browser; `scripts/` — capture and
  motion-budget tooling.

## Testing

```bash
pnpm --filter @weftcanvas/canvas-web test          # unit (Vitest)
pnpm --filter @weftcanvas/canvas-web test:e2e      # Playwright (desktop viewport)
```

## Notes

- The clip workbench exists but is shelved: creation entries stay hidden behind
  `CLIP_EDITOR_AVAILABLE` in `src/lib/canvas-features.ts`.
- Visual and motion rules are contractual, not decorative: see
  [`../../docs/VISUAL-DIRECTION.md`](../../docs/VISUAL-DIRECTION.md) and
  [`../../docs/MOTION-SPEC.md`](../../docs/MOTION-SPEC.md).

Architecture overview: [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
Local project storage: [`../../docs/LOCAL-PROJECTS.md`](../../docs/LOCAL-PROJECTS.md).
Agent connectors (Codex, Blender): [`../../docs/AGENT-CONNECTORS.md`](../../docs/AGENT-CONNECTORS.md).
