# Canvas Core

Framework-independent canvas helpers shared by the web client, the API, and
plugins. No dependencies, no React, no XYFlow — only logic that must behave
identically outside a browser.

Currently it owns identifier generation (`createId` and friends), re-exported
from `./src/index.ts`. The package is consumed as source through the workspace
(`exports: "./src/index.ts"`), so bundlers and `tsc` see the same code path.

Add code here only when it is genuinely framework-free; browser state, media,
and protocol schemas belong to `apps/web` and `packages/contracts` respectively.

Typecheck: `pnpm --filter @weftcanvas/canvas-core typecheck`.
