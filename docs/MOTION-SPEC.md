# Motion Specification

This file records original product requirements. It is a behavior reference,
not a copy of any legacy CSS or TypeScript implementation.

## Principles

- Motion confirms state and intent; it does not decorate every surface.
- Pointer tracking must remain immediate. Never add visible cursor latency.
- Animate compositor-friendly properties such as transform and opacity.
- Text and icons must remain legible throughout every transition.
- No white flash, white sphere, cursor halo, or washed-out active state.
- Motion must not change the stable dimensions of tools, nodes, or toolbars.
- Reduced-motion preferences must preserve all functional feedback.

## Canvas navigation

- Holding Space enters pan mode with an immediate cursor and surface response.
- Releasing Space, losing window focus, pointer cancellation, or visibility
  changes must always terminate pan mode.
- Background movement may use restrained depth cues without delaying the
  viewport transform.
- Mobile uses deliberate two-finger pan and pinch zoom. Single-finger gestures
  must not accidentally zoom the canvas.

## Nodes and connections

- Node entry uses a short opacity and scale settle with no layout shift.
- Selection is communicated by border, tone, and a restrained shadow.
- Side add controls use a modest magnetic pointer range.
- Press feedback is compact, tactile, and color-filled without a large sphere.
- Connection creation communicates direction and completion without flashing.
- Deleting an in-flight node prevents late async results from restoring it.

## Tools and generation

- Hover tools reveal continuously and remain reachable in narrow viewports.
- Pressed tools respond immediately before asynchronous work begins.
- Running states may use a readable text sheen that stops when work completes.
- Success appears only after media is validated, persisted, and renderable.
- Error feedback belongs to the affected node and does not disturb the canvas.

## Quality gate

- Verify desktop and mobile screenshots at representative viewports.
- Measure pointer-to-transform latency and avoid main-thread animation loops.
- Test focus loss, pointer cancellation, touch interruption, and rapid input.
- Check that dynamic content cannot resize fixed-format controls.
