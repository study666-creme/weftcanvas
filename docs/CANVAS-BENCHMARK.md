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

## Kachang Decisions

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
