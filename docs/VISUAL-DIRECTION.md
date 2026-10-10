# Visual Direction: Dark Creative Instrument

Product name: Kachang Canvas / 卡藏画布

The visual direction follows the established Kachang Canvas product language:
a full-screen graphite workspace, compact floating tools, clear node geometry,
and tactile feedback without ornamental effects.

## Reference boundary

The current Kachang Canvas screenshot and the owner's written interaction
specifications are the primary product reference. They describe proportions,
hierarchy, and behavior only. No legacy source, CSS, assets, or Git history is
copied into this repository.

## Interpretation

"Premium" means predictable geometry, legible hierarchy, restrained material
use, immediate feedback, and coherent motion. It does not mean glass
everywhere, oversized rounded rectangles, or white highlights that erase
labels.

## System

- Dark mode is the default creative workspace; a fine neutral grid provides
  scale without becoming decoration.
- The canvas fills the viewport. A compact project console and account controls
  float at the top without a structural header band.
- Persistent creation tools form a narrow left rail. Editing commands use a
  small bottom-center dock, while viewport controls stay independent at the
  bottom-right.
- Nodes use graphite surfaces, crisp gray borders, and restrained shadows.
- Node type labels sit outside the upper-left corner. Nodes do not display a
  separate user-facing title row.
- Selected-node actions float above the node and never cover its type label.
- Node bodies stay as previews on hover and selection. Editing and upload are
  explicit toolbar commands, never transient inputs inside the node.
- Magnetic add controls remain small in their resting state and gain contrast,
  not glow, on hover.
- Radius is 6-10 px for nodes and tool surfaces. Persistent controls use the
  same restrained geometry instead of oversized bottom pills.
- Typography uses the native system stack with compact, readable sizes.
- Letter spacing is always zero.
- Graphite provides structure; semantic colors are quiet secondary cues.
- Color never replaces text, shape, or state labels.
- Borders carry most hierarchy; shadows are reserved for movable surfaces.

## Motion

- Pointer and viewport transforms are immediate and never animated through
  React state.
- Hover and press feedback completes in 100-160 ms.
- Panels and popovers complete in 160-220 ms.
- Spatial creation may settle over 180-240 ms.
- Only transform and opacity animate during direct manipulation.
- Pressed controls darken or tint; they do not flash white.
- Selection uses a crisp border and restrained shadow rather than a glow.

## Rejected treatments

- nested cards or a card for every section
- large continuous blur layers
- gradient surfaces, colored haze, glow, or decorative orbs
- large pill buttons for ordinary icon actions
- low-contrast white-on-white controls
- oversized typography inside operational tools
- motion that delays the cursor or resizes surrounding layout
