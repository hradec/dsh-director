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
import { configure, invoke } from "@/bridge/ipc";
import { seekPlayheadTimeUs } from "@/state/playheadStore";
import { useSelectionStore, setLayerSelection, primaryLayerIdOf } from "@/state/selectionStore";
import { initEval } from "@/eval";
import { installBootstrapHook, installMotifTestHooks, installMotifHook, installAudioTestHooks, installDecodeBenchHooks } from "@/testhook/e2eHook"; // e2e seek + composite readback bridge for proofs (mirrors main.tsx)
import { startPreviewAudioSession } from "@/render/audio/previewAudioSession"; // registers the playback transport (Play/Pause/Seek) — desktop App does this in its session effect
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
function injectCss(): void {
  if (injected || !CSS) return;
  const style = document.createElement("style");
  style.setAttribute("data-dsh-timeline", "");
  // dockview's own stylesheet first — the panel chrome (Media Pool / Timeline
  // tabs, splitters, grips) is invisible without it; then the app's compiled CSS.
  style.textContent = dockviewCss + "\n" + CSS;
  document.head.appendChild(style);
  injected = true;
  document.documentElement.classList.add("dsh-timeline-scope");
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
    onImportMedia: async () => {},
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
  return <div className="dsh-tl h-full min-h-0 w-full"><Workspace /></div>;
}

const roots = new Map<Element, Root>();

export function mount(el: Element, opts: MountOpts): void {
  injectCss();
  installBootstrapHook(() => {}, () => {}); installMotifTestHooks(); installMotifHook(); installAudioTestHooks(); installDecodeBenchHooks();
  // DSH edits carry no A/B-roll role stamps yet, so the WeftCut default AbRoll
  // view would show an empty lane. Open in AllTracks until the Production
  // adapter stamps roles (upgrade path: flip the default back then).
  useAppSettingsStore.setState((s) => ({ settings: { ...s.settings, display_mode: "AllTracks" } }));
  configure({ editingId: opts.editingId, apiBase: opts.apiBase, session: opts.session });
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
