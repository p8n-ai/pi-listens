# Miko PNG sprites

Generated with Codex image generation for the pi-listens voice panel.

Files:

- `idle.png` — calm teal ready state.
- `listening.png` — blue listening state with receptive wave motif.
- `working.png` — purple agent-working state with tiny terminal/laptop panel.
- `speaking.png` — pink/magenta speaking state with sound wave motif.
- `error.png` — red error state with worried expression and warning motif.

The extension displays these PNGs in terminals with inline image support through Pi TUI's `Image` component. It falls back to the ANSI/Unicode Miko renderer elsewhere.
