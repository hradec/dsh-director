// DSH mount entry: mounts the vendored WeftCut Timeline as a self-contained
// bundle inside the Director Studio "Editing" tab. Bundled with its own React 19
// (the renderer needs useEffectEvent); the host plugin keeps React 18 external,
// so the two never mix. This file is the ONLY new glue on the client side —
// everything below it is WeftCut's own renderer.
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { Timeline } from "@/timeline/Timeline";
import { ShortcutBindingsProvider } from "@/shortcuts/bindings-context";
import { useProjectStore } from "@/state/projectStore";
import { useAppSettingsStore } from "@/settings/appSettingsStore";
import { configure, invoke } from "@/bridge/ipc";
import { seekPlayheadTimeUs } from "@/state/playheadStore";
import { initEval } from "@/eval";
import CSS from "./timeline-css.generated.mjs";
import i18n from "i18next";
import enUS from "@/i18n/locales/en-US";
// English resource tree from the vendored locale file (the shim stores it; see
// src/renderer/shims/i18next-shim.jsx) so t() answers with real copy.
i18n.addResourceBundle("en", "translation", enUS);

interface MountOpts { editingId: string; apiBase: string; session: string }

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
  const summary = useProjectStore((s) => s.summary);
  const ready = useProjectStore((s) => s.ready);
  if (!ready) return <div className="p-4 text-sm opacity-70">Loading edit…</div>;
  if (!summary) return <div className="p-4 text-sm text-red-400">No edit is open.</div>;
  const compositionId = summary.root_id;
  const comp = summary.compositions[compositionId];
  if (!comp) return <div className="p-4 text-sm text-red-400">Root composition missing.</div>;
  return (
    <div className="dsh-tl flex h-full min-h-0 flex-col">
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
        onSeek={(us) => seekPlayheadTimeUs(us)}
        onMutated={async () => {}}
      />
    </div>
  );
}

const roots = new Map<Element, Root>();

export function mount(el: Element, opts: MountOpts): void {
  injectCss();
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
