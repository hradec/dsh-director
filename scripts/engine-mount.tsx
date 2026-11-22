// DSH mount entry: mounts the vendored WeftCut Timeline as a self-contained
// bundle inside the Director Studio "Editing" tab. Bundled with its own React 19
// (the renderer needs useEffectEvent); the host plugin keeps React 18 external,
// so the two never mix. This file is the ONLY new glue on the client side —
// everything below it is WeftCut's own renderer.
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { DockWorkspace, type DockPanelContracts } from "@/workspace/DockWorkspace";
import { mediaReadiness, type MediaReadiness } from "@/panels/mediaReadiness";
import { ShortcutBindingsProvider } from "@/shortcuts/bindings-context";
import { useProjectStore } from "@/state/projectStore";
import { useAppSettingsStore } from "@/settings/appSettingsStore";
import { usePlaybackStore, transportPlay, transportPause } from "@/state/playbackStore";
import { configure, invoke, invokeRaw } from "@/bridge/ipc";
import { attachProjectPublication } from "@/state/projectPublication";
import { seekPlayheadTimeUs } from "@/state/playheadStore";
import { useSelectionStore, setLayerSelection, primaryLayerIdOf } from "@/state/selectionStore";
import { initEval } from "@/eval";
import { installBootstrapHook, installMotifTestHooks, installMotifHook, installAudioTestHooks, installDecodeBenchHooks } from "@/testhook/e2eHook"; // e2e seek + composite readback bridge for proofs (mirrors main.tsx)
import { startPreviewAudioSession } from "@/render/audio/previewAudioSession"; // registers the playback transport (Play/Pause/Seek) — desktop App does this in its session effect
import { useFocusRegions } from "@/focus/useFocusRegions"; // panel-scope tracker (ADR 0041) — desktop mounts it at the root
import { useShortcuts, type HandlerMap } from "@/shortcuts/useShortcuts"; // key dispatch lives in the shell, not DockWorkspace
import { deleteLayers, rippleDeleteLayers, projectUndo, projectRedo } from "@/ipc";
import { currentSelection, layerIdsOf, clearLayerSelection } from "@/state/selectionStore";
import { settleProjectStore } from "@/state/projectStore";
import { Ticker } from "pixi.js";
import type { PreviewSurfaceHandle } from "@/preview/PreviewSurface";
import dockviewCss from "dockview/dist/styles/dockview.css";
import CSS from "./timeline-css.generated.mjs";
import i18n from "i18next";
import enUS from "@/i18n/locales/en-US";
// English resource tree from the vendored locale file (the shim stores it; see
// src/renderer/shims/i18next-shim.jsx) so t() answers with real copy.
i18n.addResourceBundle("en", "translation", enUS);

interface MountOpts { editingId: string; apiBase: string; session: string }

// DSH has no Electron secondary windows. PerfHUD's telemetry bridge asks
// SecondaryWindow.getByLabel on mount; without this the passive effect throws
// (window.api is Electron-preload-only), React unmounts the preview subtree and
// the engine/compositor gets disposed under us. exists:false → the bridge no-ops.
declare global { interface Window { api?: unknown } }
if (!globalThis.window.api) {
  (globalThis.window as { api: unknown }).api = {
    win: { exists: async () => false, create: async () => {}, act: async () => {} },
  };
}

let injected = false;

// Embedded on a weak-GPU browser, three idle 60fps Pixi tickers keep
// compositing full canvases forever; the window compositor then starves the
// whole page (scroll/typing lag on GTX 1050-class hardware). The desktop app
// owns its own pacing, so cap it at the DSH engine boundary only: 20fps idle,
// 60fps while playing. Realm-level patch — every ticker is captured at start.
const DSH_IDLE_FPS = 20;
const DSH_PLAY_FPS = 60;
const dshTickers = new Set<Ticker>();
const tickerStart = Ticker.prototype.start;
Ticker.prototype.start = function (this: Ticker, ...args: unknown[]) {
  dshTickers.add(this);
  if (this.maxFPS == null || this.maxFPS > DSH_IDLE_FPS) this.maxFPS = DSH_IDLE_FPS;
  return tickerStart.apply(this, args as []);
};
usePlaybackStore.subscribe(() => {
  const fps = usePlaybackStore.getState().requestedPlaying ? DSH_PLAY_FPS : DSH_IDLE_FPS;
  for (const t of dshTickers) t.maxFPS = fps;
});
function injectCss(host: Element): void {
  // The Studio panel hosts this element inside an IFRAME whose document is NOT
  // the script's own; appending styles to `document.head` leaves the dock
  // unstyled (and collapsed) there. Scope styles + scope class to the element's
  // OWN document.
  const doc = host.ownerDocument;
  if (!CSS || doc.querySelector("style[data-dsh-timeline]")) { injected = true; return; }
  const style = doc.createElement("style");
  style.setAttribute("data-dsh-timeline", "");
  // dockview's own stylesheet first — the panel chrome (Media Pool / Timeline
  // tabs, splitters, grips) is invisible without it; then the app's compiled CSS,
  // then a guard: the Studio page's own light-theme CSS otherwise paints the
  // dock white (it loads later than nothing but sets body backgrounds directly).
  // .dv-popover-anchor holds dockview context menus; it ships with no z-index,
  // so menus painted inside it sink under later panel siblings in a cramped dock.
  style.textContent = dockviewCss + "\n" + CSS + "\n.dsh-tl{background:#0e0e13;color:#e6e6ec;}\n.dsh-tl *{scrollbar-color:#3a3a45 transparent;}\n.dsh-tl .dv-popover-anchor{z-index:2147483000;}\n";
  doc.head.appendChild(style);
  doc.documentElement.classList.add("dsh-timeline-scope");
  // Base UI menus/popovers portal to document.body, OUTSIDE the .dsh-tl .dark
  // scope — they rendered white and under dockview's z-999 panels. The host
  // document here is the Studio panel's own app copy (iframe); scoping dark to
  // it darkens that copy's chrome too — consistent with the surrounding dark GUI.
  doc.documentElement.classList.add("dark");
  injected = true;
}

// The full desktop layout: Media Pool + monitor with transport + timeline +
// property/marker panels, exactly the DockWorkspace the upstream app mounts.
// DSH supplies only the contract (17 fields); every panel is store-driven.
// ponytail: importsById/readinessById/optimizeById are empty and onImportMedia
// no-ops until a Footage-import route lands (upgrade path: wire "+ Footage"
// to POST add_media_item, then feed useImportReadiness from /api/file probes).
function Workspace() {
  const summary = useProjectStore((s) => s.summary);
  const previewRef = React.useRef<PreviewSurfaceHandle | null>(null);
  const [revealedTrackId, setRevealedTrackId] = React.useState<string | null>(null);
  const selectedLayerId = useSelectionStore((s) => primaryLayerIdOf(s.selection));
  // Key dispatch (Delete/Shift+Delete/undo/redo/space) is App-shell behavior on
  // desktop; the DSH shell is this component, so it owns the same minimal map.
  useFocusRegions();
  const handlers = React.useMemo<HandlerMap>(() => ({
    togglePlay: () => {
      if (usePlaybackStore.getState().requestedPlaying) transportPause();
      else transportPlay();
    },
    deleteSelected: async () => {
      const ids = [...layerIdsOf(currentSelection())];
      if (!ids.length) return;
      try { await deleteLayers(ids); clearLayerSelection(); await settleProjectStore(); }
      catch (err) { console.error("dsh-timeline: delete failed", err); }
    },
    rippleDeleteSelected: async () => {
      const ids = [...layerIdsOf(currentSelection())];
      if (!ids.length) return;
      try { await rippleDeleteLayers(ids); clearLayerSelection(); await settleProjectStore(); }
      catch (err) { console.error("dsh-timeline: ripple delete failed", err); }
    },
    undo: () => projectUndo(),
    redo: () => projectRedo(),
  }), []);
  useShortcuts({ handlers, overrides: {} });
  const contracts = React.useMemo<DockPanelContracts>(() => ({
    summary,
    previewRef,
    onSeek: (us: number) => { seekPlayheadTimeUs(us); previewRef.current?.seekTo(us); },
    onTogglePlay: () => {
      if (usePlaybackStore.getState().requestedPlaying) transportPause();
      else transportPlay();
    },
    previewDecodableOf: () => true,
    revealedTrackId,
    keybindings: {},
    importsById: new Map(),
    // DSH footage is original, streamed over /api/file — always playable; the
    // desktop 'preparing/optimizing' badges describe its transcode pipeline.
    readinessById: new Map((summary?.media ?? []).map((m) => [String(m.id), { ready: true } as MediaReadiness])),
    // DSH media is original footage streamed over /api/file — always playable;
    // the desktop 'preparing/optimizing' badges describe its transcode pipeline,
    // which DSH does not have.
    readinessOf: (id: string) => {
      const media = useProjectStore.getState().mediaById.get(id);
      return media ? mediaReadiness(media, { status: "ok", target: media.path } as never) : { ready: false, reason: "missing" };
    },
    optimizeById: new Map(),
    onMutated: async () => {}, // every mutation already round-trips the actor and saves server-side
    // Media Pool import button: server scans workspace media/ and adds every
    // not-yet-pooled video through the shared actor (then refreshes projection).
    onImportMedia: async () => { await invoke("dsh_import_footage"); },
    selectedLayerId,
    onSelectLayer: (layerId: string | null) => setLayerSelection(layerId, layerId ? [layerId] : []),
    onRevealTrack: (trackId: string) => setRevealedTrackId(trackId),
  }), [summary, revealedTrackId, selectedLayerId]);
  return <DockWorkspace contracts={contracts} onControllerReady={() => {}} onResetWorkspace={() => {}} />;
}

function Shell() {
  const ready = useProjectStore((s) => s.ready);
  const summary = useProjectStore((s) => s.summary);
  if (!ready) return <div className="p-4 text-sm opacity-70">Loading edit…</div>;
  if (!summary) return <div className="p-4 text-sm text-red-400">No edit is open.</div>;
  // `dark` scopes WeftCut's dark CSS variables (app.css defines them under
  // `.dark`) to the engine subtree — the Studio page stays its own theme.
  return <div className="dsh-tl dark h-full min-h-0 w-full"><Workspace /></div>;
}

const roots = new Map<Element, Root>();

export function mount(el: Element, opts: MountOpts): void {
  injectCss(el);
  installBootstrapHook(() => {}, () => {}); installMotifTestHooks(); installMotifHook(); installAudioTestHooks(); installDecodeBenchHooks();
  // display_mode: the store now migrates/creates A-roll/B-roll role stamps on
  // every document, so WeftCut's default AbRoll view works unforced.
  // Pool layout 'large': the poster card is what the reference picture shows;
  // the compact list hides the thumbnail slot entirely.
  useAppSettingsStore.setState((s) => ({ settings: { ...s.settings, media_pool_layout: "large" } }));
  configure({ editingId: opts.editingId, apiBase: opts.apiBase, session: opts.session });
  // Publication barrier: desktop wires a push-driven client (wireProjectStore);
  // DSH's HTTP bridge already re-reads and applies the full projection after
  // EVERY command (refreshStore in dsh-bridge-ipc), so the barrier is
  // satisfied by construction. Without an attached client every gated command
  // (delete, ripple-delete, undo…) rejects 'unavailable' — clips looked
  // undeletable. refresh still re-reads for callers like refreshProjectStore.
  attachProjectPublication({
    waitFor: () => Promise.resolve(),
    settle: () => Promise.resolve(),
    refresh: async () => {
      const pub = await invokeRaw<{ summary: unknown }>("project_publication");
      useProjectStore.getState().apply(pub.summary as never);
    },
    stop: () => {},
  });
  const run = (): void => {
    void initEval()
      .catch((err) => console.error("dsh-timeline: eval wasm init failed", err))
      .then(() => invoke<{ summary: unknown }>("project_publication"))
      .then((pub) => useProjectStore.getState().apply(pub.summary as never))
      .then(() => {
        startPreviewAudioSession(); // transport registration — after eval wasm + first summary (its sync reads both)
        const root = roots.get(el) ?? createRoot(el);
        roots.set(el, root);
        root.render(
          <ShortcutBindingsProvider overrides={{}}>
            <Shell />
          </ShortcutBindingsProvider>,
        );
      })
      .catch((err) => {
        el.textContent = "Timeline failed to load: " + String(err && err.message ? err.message : err);
      });
  };
  run();
}

export function unmount(el: Element): void {
  const root = roots.get(el);
  if (root) { root.unmount(); roots.delete(el); }
}

// Expose for the plugin client (loaded as a plain script tag).
(globalThis as unknown as { DSH_TIMELINE: { mount: typeof mount; unmount: typeof unmount } }).DSH_TIMELINE = { mount, unmount };

export default { mount, unmount };
