# VERT UI adaptations

Source: https://github.com/VERT-sh/VERT/tree/257bcb3b2bb6a501bae0faf9ffb05060ee00c3f7

- `Panel.svelte` retains `src/lib/components/visual/Panel.svelte`.
- `Uploader.svelte` adapts `src/lib/components/functional/Uploader.svelte` to the OCR file input and drag/drop queue.
- `Navbar.svelte` adapts `src/lib/components/layout/Navbar/Base.svelte` to local OCR actions, removing converter stores and localization dependencies.
- `vert.scss` retains upstream `src/lib/css/app.scss` theme and control styles, with a local font import path.
- `host-grotesk.css` retains upstream font-face definitions with relative URLs and `font-display: swap`.
- `fonts/` and `vert-bg.svg` are copied upstream assets. Host Grotesk has its SIL OFL notice alongside the font files.

See the root `LICENSE` (AGPL-3.0), `NOTICE`, and `THIRD_PARTY.md`.
