# Third-Party Dependency Register

Versions are pinned by `pnpm-lock.yaml`. Recheck this table before a public or
commercial release.

| Package                    | Purpose                                                   | License reviewed |
| -------------------------- | --------------------------------------------------------- | ---------------- |
| React / React DOM          | Browser UI runtime                                        | MIT              |
| Vite / React plugin        | Development and production build                          | MIT              |
| TypeScript                 | Type checking                                             | Apache-2.0       |
| `@xyflow/react`            | Viewport, node, and edge primitives                       | MIT              |
| Zustand                    | Application state                                         | MIT              |
| `use-sync-external-store`  | React-compatible external store bridge                    | MIT              |
| Lucide React               | Interface icons                                           | ISC              |
| Zod                        | Runtime contract validation                               | MIT              |
| Hono / `@hono/node-server` | Product API routing and Node HTTP adapter                 | MIT              |
| tsx                        | Local TypeScript API development runtime                  | MIT              |
| `pg` / `@types/pg`         | PostgreSQL client and TypeScript declarations             | MIT              |
| Vitest                     | Unit tests                                                | MIT              |
| Playwright                 | Browser verification                                      | Apache-2.0       |
| Three.js / `@types/three`  | On-demand 3D director-stage runtime and type declarations | MIT              |
| fflate                     | 流式 ZIP 读写（完整项目备份/恢复，web 端）                | MIT              |
| undici                     | 受控出网 HTTP 传输（API SSRF 防线的 dispatcher）          | MIT              |

No source from these packages is copied into product modules. Their normal
package distributions and required license notices remain intact.

## Vendored skill content

`apps/web/src/content/curated-skills/` carries six MIT-licensed Agent Skills as
plain text (no code, no scripts, no archives). They are not dependencies and are
never executed: the user must explicitly import one into their own skill library.
Each upstream LICENSE is stored under `licenses/`, and the source repository,
pinned commit, and upstream/local SHA-256 are recorded in that directory's
`ATTRIBUTION.md`.

| Source repository                   | License | Local directory              |
| ----------------------------------- | ------- | ---------------------------- |
| `blader/humanizer`                  | MIT     | `humanizer/`                 |
| `coreyhaines31/marketingskills`     | MIT     | `image-prompts/`             |
| `arnabbagxd/Brand-building-skills`  | MIT     | `brand-voice/`               |
| `kaomei/hand-drawn-video-prompts`   | MIT     | `hand-drawn-video/`          |
| `content-designer/ux-writing-skill` | MIT     | `ux-writing/`                |
| `wshobson/agents`                   | MIT     | `visual-design-foundations/` |
