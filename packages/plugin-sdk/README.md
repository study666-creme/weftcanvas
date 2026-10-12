# Plugin SDK

The complete contract between a plugin and the canvas host. Types only, plus one
identity-check helper — zero runtime dependencies. React appears as a type only:
plugins share the host's React and never bundle their own.

## Safety model

The SDK surface is deliberately narrow, and the host enforces the rest:

- Plugins never receive model keys. `ai.*` calls are proxied by the host through
  the BYOK channel; keys never leave the browser's `localStorage` or reach plugin
  code.
- Node kinds are namespaced as `plugin:<pluginId>:<name>`; collisions fail loudly
  instead of silently overriding.
- Every plugin body renders inside a host `ErrorBoundary`; a crashing plugin
  cannot take down the canvas.
- `storage` is namespaced per plugin id; one plugin cannot read another's data.
- `onDispose` must undo what `onInit` did — unmounting is reversible.

## Authoring

A minimal plugin registers node types and appearance packs against the host
registries. See the official example at [`../../plugins/split-list/`](../../plugins/split-list/)
and the plugin overview in [`../../plugins/README.md`](../../plugins/README.md).

Remote (downloaded) plugins are not part of this contract yet; the boundary is
described in the plugin roadmap section of the repository docs.

Typecheck: `pnpm --filter @weftcanvas/plugin-sdk typecheck`.
