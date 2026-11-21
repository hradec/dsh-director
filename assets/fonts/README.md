# Font assets

- LiberationSans-Regular.woff2 — Liberation Sans 2.x, Red Hat, SIL OFL 1.1
  (converted from /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf
  via fontTools; full license text in the distro package).
- NotoSansSC-VF.ttf — PLACEHOLDER: currently a copy of LiberationSans-Regular.ttf
  (no CJK glyphs). Replace with the real Noto Sans SC variable font (SIL OFL 1.1,
  google/fonts repo) when CJK text layers are needed. Referenced by
  src/renderer/render/text/registry.ts via ?url imports; the build embeds both
  as data URLs in lib/timeline-engine.js.
