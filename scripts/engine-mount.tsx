// DSH mount entry: mounts the vendored WeftCut Timeline as a self-contained
// bundle inside the Director Studio "Editing" tab. Bundled with its own React 19
// (the renderer needs useEffectEvent); the host plugin keeps React 18 external,
// so the two never mix. This file is the ONLY new glue on the client side —
// everything below it is WeftCut's own renderer.
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Timeline } from "@/timeline/Timeline";
import { PreviewSurface, type PreviewSurfaceHandle } from "@/preview/PreviewSurface";
import { ShortcutBindingsProvider } from "@/shortcuts/bindings-context";
import { useProjectStore } from "@/state/projectStore";
import { useAppSettingsStore } from "@/settings/appSettingsStore";
import { configure, invoke } from "@/bridge/ipc";
import { seekPlayheadTimeUs } from "@/state/playheadStore";
import { initEval } from "@/eval";
import { installBootstrapHook, installMotifTestHooks, installMotifHook, installAudioTestHooks, installDecodeBenchHooks } from "@/testhook/e2eHook"; // e2e seek + composite readback bridge for proofs (mirrors main.tsx)
import { startPreviewAudioSession } from "@/render/audio/previewAudioSession"; // registers the playback transport (Play/Pause/Seek) — desktop App does this in its session effect
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
  style.textContent = CSS;
  document.head.appendChild(style);
  injected = true;
  document.documentElement.classList.add("dsh-timeline-scope");
}

function Shell() {
  const previewRef = React.useRef<PreviewSurfaceHandle>(null);
  const [playing, setPlaying] = React.useState(false);
  const summary = useProjectStore((s) => s.summary);
  const ready = useProjectStore((s) => s.ready);
  if (!ready) return <div className="p-4 text-sm opacity-70">Loading edit…</div>;
  if (!summary) return <div className="p-4 text-sm text-red-400">No edit is open.</div>;
  const compositionId = summary.root_id;
  const comp = summary.compositions[compositionId];
  if (!comp) return <div className="p-4 text-sm text-red-400">Root composition missing.</div>;
  const hasContent = Object.values(comp.tracks ?? {}).some((tr) => ((tr as { layers?: unknown[] }).layers ?? []).length > 0);
  const toggle = (): void => {
    const p = previewRef.current;
    if (!p) return;
    if (p.paused()) { p.play(); setPlaying(true); } else { p.pause(); setPlaying(false); }
  };
  return (
    <div className="dsh-tl flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-card">
        <button type="button" className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground" onClick={toggle}>{playing ? "Pause" : "Play"}</button>
        <span className="text-xs opacity-60">{(comp.duration_us / 1e6).toFixed(2)}s</span>
      </div>
      <div className="min-h-0 basis-2/5 grow-0 shrink-0">
        <PreviewSurface
          ref={previewRef}
          hasContent={hasContent}
          previewDecodableOf={() => true}
          visible
          editingLocked={false}
        />
      </div>
      <Timeline
        compositionId={compositionId}
        tracks={comp.tracks}
        links={comp.links}
        transitions={comp.transitions}
        durationUs={comp.duration_us}
        revealedTrackId={null}
        keybindings={{}}
        fpsNum={comp.fps_num}
        fpsDen={comp.fps_den}
        bladeMode={false}
        media={summary.media}
        readinessOf={() => ({ ready: true } as const)}
        visible
        editingLocked={false}
        onExitBlade={() => {}}
        onSeek={(us) => { seekPlayheadTimeUs(us); previewRef.current?.seekTo(us); }}
        onMutated={async () => {}}
      />
    </div>
  );
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
