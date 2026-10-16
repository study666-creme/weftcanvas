# Canvas Product Benchmark

This document records product-level observations only. It is not a source-code
reference and does not authorize copying any third-party CSS, assets, layouts,
or implementation details.

Last reviewed: 2026-07-15

## Primary Set: AI Creative Canvases

- LibTV: https://www.liblib.tv/
- Updream: https://www.updream.cn/
- Flora: https://www.flora.ai/
- Lovart Canvas: https://www.lovart.ai/canvas
- Freepik Spaces: https://www.freepik.com/spaces
- Krea: https://www.krea.ai/

LibTV and Updream expose most of their workbench after authentication, so this
pass uses their public product surfaces plus the owner's supplied canvas
captures. Logged-in workflow details must be rechecked before using them as a
behavioral reference.

## Secondary Set: Mature Infinite Canvases

- tldraw: https://www.tldraw.com/
- Excalidraw: https://excalidraw.com/
- Miro: https://miro.com/online-whiteboard/
- FigJam: https://www.figma.com/figjam/

These products inform viewport, selection, keyboard, and tool-disclosure
behavior. They do not define AI generation-node structure.

## Agent Skills: Format and Mounting Reference (reviewed 2026-10-16)

A skill is a **directory**, not a prompt string:

```
my-skill/
├── SKILL.md      # YAML frontmatter (name, description) + Markdown body
├── scripts/      # optional executable helpers
├── references/   # optional documentation, one level deep
└── assets/       # optional templates and resources
```

The runtime contract is **progressive disclosure** in three levels: the metadata
(name + description, roughly 100 tokens each) is always resident so the model can
route between skills; the body (under ~5,000 tokens / 500 lines) is loaded only
when the skill activates; reference files load only when the body points at them.
`name` and `description` are the only portable frontmatter fields across clients
(`allowed-tools` is still marked experimental). Anthropic published the format as
an open standard at <https://agentskills.io> (spec repo `agentskills/agentskills`,
Apache-2.0), and it is now read by roughly 45 clients — Claude Code, OpenAI Codex,
GitHub Copilot, VS Code, Cursor, Gemini CLI, ZCode, and others. So "skills" are
mostly packaged knowledge, but the packaging is the product: a portable directory
contract plus a loading discipline, not a paragraph of prompt.

### How 影策 (Open AI Canvas) mounts skills to its agent

Read from the MIT reference tree (`oss-reference/open-ai-canvas`), not copied:

- **Authoring**: `SKILL.md` + optional `cards/*.md` or `references/**/*.md`; 72
  built-in packs are embedded in the Go binary, user skills are uploaded as
  Markdown, ZIP, or GitHub URLs and stored as one ZIP per version under
  `<dataDir>/skill-packages/<skillId>/<versionId>.zip`. Per-version content hash,
  file manifest with SHA-256, package limits (20 MB / 8 MB per file / 512 files).
- **Per-run enable list**: the run request carries `skillIds`; only skills the
  user has installed _and_ enabled are accepted, and the set is frozen into an
  in-memory snapshot at run start (version + hash re-validated on every read, so
  an edited skill cannot change mid-run). The UI caps the round at 8.
- **What reaches the model**: name + description (truncated to 500 runes) +
  version + hash + the entry path and full file-path list — **never the body**.
  The policy text tells the model to read `SKILL.md` first and then only the
  files the entry explicitly references, and states that skills are task
  playbooks rather than standing persona or capability grants.
- **Read tools** (added only when the run has skills): `skill_read_file`
  (empty path = directory listing, 12,000 runes per page, entry path returns the
  body, other paths must exist in the frozen snapshot, binary rejected) and
  `skill_search` (server-side keyword ranking, no embeddings; card slug > skill
  name > description). Read-only tools, cached per version+hash, with a per-run
  read budget (32 calls) and receipts/telemetry (`skills_load`,
  `entryReads` vs `cardReads`, top cards).
- **Selection UX**: user skill library page + marketplace, install by
  md/zip/GitHub, personal categories, scene presets ("挂上 N 个技能"), a
  composer hint that `/` or `、` inserts a skill reference, a `Skills(N)` chip,
  and enable state persisted per conversation.
- **Second, different path**: canvas node generation inlines the full `SKILL.md`
  (plus up to 3 linked files, 32k-char budget) into the prompt instead of using
  the read tools. Same content, two delivery strategies: agent = pull on demand,
  single-shot generation = push eagerly.
- **Permission separation**: skills never widen the tool set. The tool list is
  compiled per execution mode (read-only omits every write, media tools always
  require approval regardless of mode), and the memory/lesson subsystem injects
  only an index with user approval per entry.

### Free skill libraries worth knowing

| Source                           | License                                       | Contents                                                                           |
| -------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `agentskills/agentskills`        | Apache-2.0                                    | The specification itself plus a reference validator                                |
| `obra/superpowers`               | MIT                                           | 15 engineering-methodology skills (TDD, debugging, planning, review)               |
| `wshobson/agents`                | MIT (check the 2 external plugins separately) | 185 skills / 202 agents across dev, review, testing, infra, security               |
| `vercel-labs/skills` + skills.sh | per-skill licenses (not shown on the site)    | The de-facto directory/leaderboard; publishers include Microsoft, Google, Supabase |
| awesome lists (several)          | mostly unlicensed directories                 | Discovery only — do not copy their content into a product                          |

Two hard warnings from the same review:

- **Anthropic's `pdf`/`docx`/`pptx`/`xlsx` skills are source-available, not open
  source** (`© 2025 Anthropic, PBC. All rights reserved.` with no-copy,
  no-derivative terms). They are excellent reference implementations and cannot
  be bundled into our product.
- **The supply chain is measurably hostile.** Snyk's ToxicSkills audit of ~3,984
  published skills found 13.4% with a critical issue, 36.8% with a flaw of any
  severity, and 76 confirmed malicious payloads (91% of those combined prompt
  injection with code), and one reported case reached 26,000+ users with no
  malicious code in the submitted files at all — the file pointed at an external
  domain that turned bad later. Skills inherit the agent's permissions, so any
  skill we ship must be ours (or MIT/Apache with attribution), must not carry
  scripts we have not written, and must never be installed automatically from the
  internet.

### What a good skill looks like

Trigger reliability lives entirely in `description` (state the intent and the
situations, imperatively, a few sentences). Keep the body under 500 lines; move
everything conditional into `references/` and say when to read it; prefer
focused skills with at most ~3 modules over exhaustive bundles (SkillsBench:
+16.6pp mean pass rate on 87 tasks, with focused skills beating large ones). Cut
anything the model would already get right without the instruction.

## Repeated Product Patterns

1. The canvas owns the viewport. Navigation and utilities float above it rather
   than reserving a permanent application frame.
2. Controls have three layers: persistent creation tools, selection-specific
   actions, and transient menus. A control does not appear in every layer.
3. Image and video nodes are media-first. The asset fills the node; metadata and
   editing controls appear on hover, selection, or in a dedicated generation
   surface.
4. Node type is lightweight metadata outside the content. A second permanent
   title row is usually unnecessary for generated media.
5. Selection is communicated by a crisp outline and handles. Glow and dramatic
   elevation make dense graphs harder to scan.
6. Connections remain quieter than node content. Creation affordances become
   obvious only near a port or during a connection gesture.
7. Empty media nodes use one centered action and little text. They do not nest a
   second bordered card inside the node.
8. Prompt, model, ratio, duration, and cost belong to the generation action.
   They should not permanently consume space on every finished asset.
9. Zoom and navigation controls are spatial utilities and stay separate from
   content-creation tools.
10. Direct manipulation must bypass React render loops. Pointer-follow effects
    use CSS transforms or imperative style updates, and graph rendering is
    limited to visible elements.

## Weftcanvas Decisions

- Dark graphite is the default workspace; light mode remains optional.
- Creation, editing, and viewport controls are deliberately split: a left
  creation rail, a bottom-center edit dock, and a bottom-right viewport surface.
- The top project console combines project identity and save state without
  recreating a full application header.
- Image and video content is full-bleed.
- Node type labels remain outside the upper-left corner.
- Nodes have no permanent user-facing title row.
- Hover and selection never turn the node body into an input. Text editing uses
  the explicit editor action; prompts and media descriptions use the dedicated
  generation surface.
- Empty image and video nodes remain drag surfaces. Clicking them selects the
  node; upload requires the explicit toolbar action. Canvas-level file drop is
  a separate node-creation workflow.
- Selected-node actions float above the node.
- The existing magnetic side-add interaction is retained as original product
  behavior, with a small resting state and a wider invisible hit area.
- Bezier connections are low contrast until selected.
- Product-specific generation controls use a dedicated surface and remain
  separate from the canvas engine. Agent controls follow the same boundary.

## Explicit Non-Goals

- reproducing another product's distinctive toolbar order or icon composition
- copying screenshots, illustrations, CSS values, assets, or source code
- adding controls only to make the interface look feature-rich
- keeping legacy abstractions that do not serve the new data model
