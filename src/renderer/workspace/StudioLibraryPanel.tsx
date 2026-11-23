import * as React from "react";
import { useTranslation } from "react-i18next";

// Embeds the Director Studio's Footage / Images tab INSIDE the dock: the
// client bundle exposes the exact tab components through
// window.__DSH_STUDIO_TABS__ (same groups, tag filter, right-click actions),
// and this panel hosts that React-18 root inside its React-19 tree, adding an
// independent zoom (dropdown presets + typed %) so the embedded tab can be
// read at any dock width without touching the host tab's own zoom.
// ponytail: zoom is per-panel session state; upgrade path persists it in
// app_settings if the user wants it sticky across opens.

const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200];

interface StudioTabBridge {
  mount(kind: string, el: HTMLElement, opts?: { sessionId?: string }): void;
  unmount(el: HTMLElement): void;
}
declare global {
  interface Window { __DSH_STUDIO_TABS__?: StudioTabBridge; __DSH_TIMELINE_SESSION__?: string }
}

export function StudioLibraryPanel({ tab }: { tab: "footage" | "images" }): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = React.useState(100);
  const [draft, setDraft] = React.useState("100");
  const [mounted, setMounted] = React.useState(false);
  const { t } = useTranslation();

  React.useEffect(() => {
    const el = hostRef.current;
    const bridge = window.__DSH_STUDIO_TABS__;
    if (!el || !bridge) return;
    bridge.mount(tab, el, { sessionId: window.__DSH_TIMELINE_SESSION__ });
    setMounted(true);
    return () => { bridge.unmount(el); setMounted(false); };
  }, [tab]);

  const scale = zoom / 100;
  const applyDraft = (): void => {
    const v = Math.round(Number(draft.replace("%", "").trim()));
    if (Number.isFinite(v) && v > 0) { setZoom(v); setDraft(String(v)); }
    else setDraft(String(zoom));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-0 items-center gap-2 px-2 py-1 text-xs">
        <span className="opacity-70">{t("dock_workspace.panels.zoom", { defaultValue: "Zoom" })}</span>
        <select
          className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5"
          value={ZOOM_PRESETS.includes(zoom) ? String(zoom) : "custom"}
          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) { setZoom(v); setDraft(String(v)); } }}
        >
          {ZOOM_PRESETS.map((p) => <option key={p} value={String(p)}>{p}%</option>)}
          <option value="custom">{zoom}%</option>
        </select>
        <input
          className="w-14 rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5"
          value={draft}
          inputMode="numeric"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={applyDraft}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyDraft(); } }}
        />
        {!mounted && !window.__DSH_STUDIO_TABS__ ? (
          <span className="opacity-60">{t("dock_workspace.panels.library_missing", { defaultValue: "Studio tabs bridge not loaded yet — reopen this panel." })}</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* scale the embedded tab; grow its layout box by 1/z so the VISUAL
            size fills the panel while THIS container scrolls the enlarged box.
            The board is mounted directly (no srcdoc body to scroll in), so
            this div is the scroller — overflow-hidden here once made the
            library unscrollable. */}
        <div
          ref={hostRef}
          style={{ transform: `scale(${scale})`, transformOrigin: "0 0", width: `${100 / scale}%`, height: `${100 / scale}%` }}
        />
      </div>
    </div>
  );
}
