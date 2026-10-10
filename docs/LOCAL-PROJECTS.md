# Local Project Library

The desktop canvas currently uses a local-first multi-project library. Project
switching does not reload the page and does not share graph identity between
projects.

## Implemented lifecycle

- Create a clean project while first persisting the active project.
- Search and switch projects from the left project sidebar.
- Rename active or inactive projects.
- Duplicate a project with new project, node, edge, and group ids.
- Clear copied generation job bindings, runtime errors, selection, and progress.
- Delete active or inactive projects with an explicit confirmation dialog.
- Import a validated project as a new project rather than overwriting an
  existing project with colliding ids.
- Export the active validated project as a versioned JSON document.
- Migrate the former single-project local-storage key on first load.

## Empty new-project invariant

A newly created project always starts empty: `nodes: []`, `edges: []`, and
`groups: []`, with no selection, undo/redo history, or transaction residue, a
usable default viewport, and normal persistence/save state. This applies at
every new-project boundary: a first-time browser with no valid local project,
an explicit New Project action (`resetProject`), and the empty replacement
created after deleting the final project. Node creation tools remain fully
usable from the empty canvas and do not require any starter anchor.

## Default viewport invariant

New-project boundaries use a neutral 70% viewport (`createEmptyProjectViewport`:
`{ x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 0.7 }`, exactly
`{ x: 720, y: 450, zoom: 0.7 }` on a 1440x900 desktop). The flow origin is
centered in the reachable editing area, so toolbar creation immediately centers
a new node and the empty grid is usable without panning. The 0.7 zoom renders a
fresh standard landscape image/video node at a moderate ~238 screen-pixel width
(340 x 0.7), clear of persistent chrome, with both side add controls visible
when the node is selected. Existing stored, imported, duplicated, cloud, and
legacy projects are never reset: their saved viewport is restored byte-for-byte
on every open, and only true new-project boundaries apply the 70% default.

## Stable node-size invariant

A newly created node's intrinsic canvas dimensions come only from its kind, the
selected aspect ratio, the media ratio, and explicit user resizing. They are
never derived from the viewport zoom at creation: creating a node at a 10%
overview no longer inflates it (the former `nodeCreationScaleForZoom` 6x cap was
removed), so the same node at 100% keeps its normal 340-380 canvas-pixel family
instead of occupying most of the screen, and at 0.1 it becomes a true
overview-sized node. This applies consistently to toolbar creation, context-menu
creation, quick-add/connected nodes, generated-result nodes, clipboard/paste,
file drop/import, captured images, and all layout helpers that previously
received the creation-zoom scale.

Already-persisted project graphs are preserved exactly, including intentionally
resized or historically inflated node dimensions; legitimate user resizing is
indistinguishable from any historical adaptation, so no heuristic normalization
is applied. Generated-result nodes may still inherit the explicit user-resize
scale of their origin node (never the viewport zoom), and media arriving after
creation is fitted to the media ratio at the node's existing explicit scale.

Existing local projects, the legacy single-project migration, imports,
duplicates, cloud-project replacement, and undo/redo snapshots load unchanged;
they are never identified or pruned by body text, node kind, position, count,
or edge shape.

The browser index stores only project summaries. Every full snapshot remains in
its own key so one malformed entry does not make the entire library unreadable.
If the summary index is missing or corrupt, the loader scans valid project keys
and reconstructs it.

## Storage keys

```text
kachang-canvas:projects:v1
kachang-canvas:active-project:v1
kachang-canvas:project-data:v1:<encoded-project-id>
```

The migrated key is `kachang-canvas:project:v1`. It is removed only after a
valid legacy project has been written into the new library.

## Media boundary

Project JSON contains validated media metadata and ids, not local media bytes.
Local image, video, and audio bytes remain in the `kachang-canvas-media`
IndexedDB database. Duplicated projects may intentionally reference the same
local media id.

Therefore, the current JSON export is suitable for graph inspection, same-
browser duplication, and server-media projects. It is not yet a portable backup
for local media on another browser or device. Portable project packages must
bundle referenced local objects or upload them to account-scoped cloud storage;
that work belongs to the cloud-project milestone and must not be represented as
complete before byte-level restore tests pass.

Import accepts only validated, bounded project files. Payloads larger than
`PROJECT_IMPORT_MAX_BYTES` (4 MiB) are rejected before parsing, malformed JSON
and schema-invalid files are explicitly refused with distinct messages, and a
rejected import never replaces or corrupts the current project. Imported files
may intentionally reference local media ids whose bytes are absent in the
current browser; such nodes render an explicit unavailable state instead of
fabricated media.

## Cloud synchronization boundary

The local project id will remain the stable client identity when cloud sync is
added. The server must use revision or ETag preconditions, preserve a local
recovery copy on conflict, and never silently replace a newer local graph.
Account cloud projects are optional; anonymous local editing remains usable.
