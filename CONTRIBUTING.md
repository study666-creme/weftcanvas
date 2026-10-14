# Contributing to Weftcanvas

Thanks for your interest in improving Weftcanvas (纬线). This document is the
short version; the binding product rules live in [`AGENTS.md`](AGENTS.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development environment

- Node.js 22 LTS (the same version used by CI and Docker).
- pnpm: the repository pins its exact version via `packageManager`
  (corepack picks it up automatically).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev:web        # canvas at http://127.0.0.1:4173
```

`pnpm dev` additionally runs contracts + the Canvas API. The canvas works
standalone with BYOK (Configuration → Custom API); no server is required for UI
work.

## Before opening a PR

```bash
pnpm format:check   # prettier — run `pnpm format` to fix
pnpm typecheck      # tsc strict across all workspaces
pnpm test           # unit tests (Vitest)
pnpm build          # all distributed runtime artifacts
pnpm test:e2e       # Playwright, when you touched interaction
```

Run the browser specs relevant to your change. CI enforces formatting, types,
unit/script tests, build, the BYOK/project/plugin browser smoke suite, and Docker
startup/persistence checks. The full E2E suite may include hosted-only scenarios.

## Code style

- Formatting is mechanical: prettier + `.editorconfig`, no style debates in
  review. TypeScript is `strict` with `noUncheckedIndexedAccess`.
- Comments state constraints the code cannot show — never narration, never
  changelog-style "why my change is correct".
- Keep model IDs unchanged. Recognition rules provide defaults; describe relay
  compatibility only for verified protocols. Never infer prices or successful jobs.
- Put runtime code in its owning workspace, CLI tools in `scripts/`, and tests
  next to the behavior they cover. Use descriptive names; avoid one-off debug files.
- Cross-runtime payloads go through versioned schemas in `packages/contracts`
  first. Runtimes must not import each other's internal state.

## The canvas feel is the product

Pointer, pan, zoom, node drag, selection, and connection feedback must remain
immediate. Keep the UI quiet, compact, and graphite-based. Nodes are previews —
no hover text inputs, no click-to-upload, no resize borders, no internal title
rows. Changes that trade pointer latency for anything else will not be merged.

## Scope and provenance

- Weftcanvas is a clean-origin implementation. Third-party code requires an
  explicit provenance entry in `PROVENANCE.md`; do not paste code from other
  canvas projects without it.
- Never commit API keys, tokens, or production endpoints. BYOK keys belong in
  the contributor's own browser `localStorage` only. CI runs gitleaks.
- First-time contributors sign the CLA (see [`CLA.md`](CLA.md)); it grants the
  maintainer the right to relicense, which is what keeps the dual-license model
  viable.

## Reporting

- Bugs and features: GitHub issues (templates provided).
- Questions and design discussion: the QQ group **743378399**.
- Security vulnerabilities: see [`SECURITY.md`](SECURITY.md) — please do not
  open a public issue.
