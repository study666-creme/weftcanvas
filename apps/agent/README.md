# Agent Runtime

This is the server-only private Agent application for Canvas Next. It starts
with an empty implementation and does not inherit the legacy AGPL
`canvas-agent` source.

The Agent may plan and issue validated canvas commands through
`packages/contracts`. It must not import browser components, client stores, or
private user data outside an authorized run.

Private prompts, retrieval indexes, credentials, and operational data are not
stored in browser bundles or public artifacts.

## Models

`OPENAI_MODEL` is the default model. `OPENAI_MODELS` accepts either an explicit
comma-separated allowlist or `*` (equivalently, unset) for open mode. In open
mode the runtime forwards any syntactically valid model id; Canvas API remains
the authority because it only offers ids present in the published platform model
catalog, and merges that catalog's text models into the Agent model picker.

Reference media (pasted images or media from canvas nodes linked to the Agent)
arrives as bounded data URLs on the run request. The browser downscales images
and sends a video's first frame, because OpenAI-compatible chat completions do
not accept video bytes. The runtime attaches them to the latest user message as
`image_url` content parts. Canvas API rejects attachments for models that do not
declare `mediaInput.images`, before any credits are consumed.

## Execution permission and skills

Both arrive on the run request (`apps/agent/src/request.ts`) and are frozen by
Canvas API before the run starts, so changing a setting never rewrites a run
already in flight.

- `executionPermission` picks the action boundary and is injected as a rule in
  the system prompt: `read_only` (analyse only, no actions at all),
  `request_approval` (the default; canvas writes become a confirmation card) and
  `auto` (canvas structure writes go straight to `direct`). Generation stays out
  of every tier — choosing a model and spending credits is the creator's call,
  so the Agent only ever suggests it.
- `skills` carries the skills the creator enabled for this run (at most four,
  `packages/contracts/src/skill.ts`). Their text is injected as one more system
  message and is explicitly framed as a task playbook that neither overrides the
  system rules nor widens the action or tool surface. We import them only from
  the creator (single `SKILL.md` files): the public skill ecosystem measurably
  contains malicious packages, so nothing is installed automatically and no
  scripts are ever executed.

The prompt also instructs the Agent to deliver creative output (story, settings,
storyboard, shot prompts) **as canvas text nodes** through `canvas_add_node`
instead of pasting a long document into the chat, so the creator gets something
they can immediately see, wire up and generate from.

## Local connectors

Two machine-local connections live in this process and are toggled from the
canvas Agent drawer (see `docs/AGENT-CONNECTORS.md`):

- `codex` — the canvas is exposed to the local Codex CLI over MCP. Codex starts
  `mcp/canvas-mcp.mjs`, which forwards canvas commands to
  `POST /internal/v1/canvas-commands`; the browser applies them and returns a
  receipt. `GET /internal/v1/canvas-context` serves the canvas summary the
  browser reports while polling.
- `blender` — the Agent gets a `blender_run_python` tool speaking one JSON line
  per request to `blender/weftcanvas_bridge.py` running inside Blender.

Endpoints and enablement:

| Variable                        | Default          | Meaning                                          |
| ------------------------------- | ---------------- | ------------------------------------------------ |
| `CODEX_BIN`                     | `codex`          | Codex executable used for probing and delegation |
| `CODEX_CONNECTOR_ENABLED`       | `false`          | Start with the Codex connector on                |
| `BLENDER_BRIDGE_ADDRESS`        | `127.0.0.1:9876` | host:port of the Blender bridge                  |
| `BLENDER_CONNECTOR_ENABLED`     | `false`          | Start with the Blender connector on              |
| `WEFTCANVAS_BLENDER_BIN`        | unset            | Explicit Blender executable for provisioning     |
| `WEFTCANVAS_BLENDER_ADDONS_DIR` | unset            | Override the Blender user add-on directory       |
| `CODEX_HOME`                    | `~/.codex`       | Where `config.toml` is read and merged           |
| `CANVAS_CONTROL_WAIT_MS`        | `60000`          | How long a canvas command waits for the browser  |

Connector on/off state is process memory only: a restart returns to these
defaults. Probe results are cached for 15 seconds. Enabled but unreachable
connectors stay visible as unavailable and contribute no tools to a run.

### One-click provisioning

`POST /internal/v1/connectors/:id/connect` is what the panel's 连接 button calls.
It enables the connector and, only when the probe says it is not already
reachable, prepares the machine:

- **codex** — merges `[mcp_servers.weftcanvas]` into `$CODEX_HOME/config.toml`
  (default `~/.codex/config.toml`), keeps every other section, and writes
  `config.toml.weftcanvas-backup` first. Codex reads its config at startup, so the
  response asks the user to restart Codex.
- **blender** — locates Blender (`WEFTCANVAS_BLENDER_BIN` → `blender` on PATH →
  per-platform install paths), installs `blender/weftcanvas_bridge.py` as the
  `weftcanvas_bridge` add-on into the user add-on directory
  (`WEFTCANVAS_BLENDER_ADDONS_DIR` overrides), enables it once via
  `blender --background --python-expr`, then launches Blender. The configured
  `host:port` is baked into the add-on, which auto-starts the bridge on every
  Blender launch.

Nothing else on the machine is touched: no PATH edits, no registry writes, no
extra installs. `detail` in the response always carries the outcome plus the
step the user still has to take.

Endpoints added for the connectors (all bearer-authenticated with
`AGENT_RUNTIME_TOKEN`): `GET /internal/v1/connectors`,
`PUT /internal/v1/connectors/:id`,
`POST /internal/v1/connectors/:id/connect`,
`POST /internal/v1/canvas-control/pending`,
`POST /internal/v1/canvas-control/receipts`, `GET /internal/v1/canvas-context`,
`POST /internal/v1/canvas-commands`. Canvas API proxies the browser-facing half
under `/api/v1/agent/connectors` and `/api/v1/agent/canvas-control/*`.
