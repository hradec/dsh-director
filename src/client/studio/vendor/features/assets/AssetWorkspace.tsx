import { useState } from "react";
import type { FormEvent } from "react";
import { useProject } from "../../shared/project/ProjectContext";
import type { LibraryKind } from "../library/api";
import { LibraryOverview } from "./LibraryOverview";
import { AssetImportDialog } from "../library/AssetImportDialog";
import { CastingPage } from "../casting/CastingPage";
import { SetDesignPage } from "../set/SetDesignPage";
import { PropsPage } from "../props/PropsPage";

type PreparedAssetCategory = Exclude<LibraryKind, "layouts" | "costumes">;
type AssetCategory = "library" | PreparedAssetCategory;

const CATEGORIES: { id: AssetCategory; label: string; eyebrow: string }[] = [
  { id: "library", label: "Library", eyebrow: "All reusable assets" },
  { id: "actors", label: "Actors", eyebrow: "Cast identity" },
  { id: "scenes", label: "Scenes", eyebrow: "World and locations" },
  { id: "props", label: "Props", eyebrow: "Story objects" },
  { id: "voices", label: "Voices", eyebrow: "Performance reference" },
];

const IMPORT_LABELS: Record<PreparedAssetCategory, string> = {
  actors: "actor",
  scenes: "scene",
  props: "prop",
  voices: "voice",
};

const PREPARED_CATEGORIES: { id: PreparedAssetCategory; label: string }[] = [
  { id: "actors", label: "Actors" },
  { id: "scenes", label: "Scenes" },
  { id: "props", label: "Props" },
  { id: "voices", label: "Voices" },
];

const REQUEST_LABELS: Record<PreparedAssetCategory, string> = {
  actors: "actor",
  scenes: "scene",
  props: "prop",
  voices: "voice sample",
};

function requestPrompt(kind: PreparedAssetCategory, projectName: string, name: string, details: string): string {
  const medium = kind === "voices" ? "audio voice sample" : "visual reference image";
  const workflowKind = kind === "voices" ? "other (audio generation)" : "text_to_image or image_edit, as appropriate";
  return [
    `Create a ${REQUEST_LABELS[kind]} asset for the Director Studio project “${projectName}” and save it in that project's DSH Director Studio library.`,
    `Asset name: ${name.trim()}.`,
    details.trim() ? `Creative direction: ${details.trim()}.` : "Use an appropriate clear, production-ready design consistent with the project.",
    `Use ComfyUI to create one ${medium}. First inspect available workflows with director_workflows; select and inspect a compatible workflow (${workflowKind}) and follow its configured workflow requirements. Do not use an uninspected graph.`,
    "Submit the actual workflow with submit_comfy_job and wait for its completed result. Then call director_studio asset.create with the exact output_artifacts.view_url and job_id from that result, kind " + kind + `, name “${name.trim()}”, and project_id for this project. Do not fabricate URLs or claim success before the import succeeds.`,
    kind === "voices" ? "Generate a short clean voice sample in WAV, MP3, or FLAC; use the requested voice description as the performance target." : "After importing, inspect the exact stored image with read_image before presenting it or adding it as a Production reference.",
    "Use a normal independent Comfy generation workflow for this asset. This request does not authorize unreviewed H3 Production submission; H3 shots still require the Director review card and confirmation gate.",
  ].join("\n");
}

export function AssetWorkspace({ sendAssetRequest }: { sendAssetRequest: (text: string) => Promise<void> }) {
  const { projectId, project } = useProject();
  const [category, setCategory] = useState<AssetCategory>("library");
  const [importKind, setImportKind] = useState<PreparedAssetCategory | null>(null);
  const [requestKind, setRequestKind] = useState<PreparedAssetCategory>("actors");
  const [requestOpen, setRequestOpen] = useState(false);
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Library "Edit" jumps to the kind's studio page with this asset pre-selected.
  const [editTarget, setEditTarget] = useState<{ kind: "actors" | "scenes" | "props"; id: string } | null>(null);
  const visibleCategory = category;

  const openRequest = (kind: PreparedAssetCategory = "actors") => {
    setRequestKind(kind);
    setRequestError(null);
    setRequestOpen(true);
  };

  const submitRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectId || !name.trim()) return;
    setBusy(true);
    setRequestError(null);
    try {
      await sendAssetRequest(requestPrompt(requestKind, project?.name || projectId, name, details));
      setRequestOpen(false);
      setName("");
      setDetails("");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="asset-workspace" aria-label="Asset preparation">
      <header className="asset-workspace-header">
        <div>
          <h1>Assets</h1>
          <p>Build the reusable cast, locations, objects, and voices the Director can assign across every Shot.</p>
        </div>
        <button type="button" className="btn primary" disabled={!projectId} onClick={() => openRequest()}>
          Ask DSH to create
        </button>
      </header>

      {!projectId ? <div className="banner">Select a project to prepare its assets.</div> : null}

      <div className="asset-workspace-body">
        <nav className="asset-category-rail" aria-label="Asset categories">
          {CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`asset-category-main ${visibleCategory === item.id ? "active" : ""}`}
              aria-label={item.label}
              aria-current={visibleCategory === item.id ? "page" : undefined}
              onClick={() => setCategory(item.id)}
            >
              <strong>{item.label}</strong>
              <span>{item.eyebrow}</span>
            </button>
          ))}
        </nav>

        <section className="asset-category-content" aria-live="polite">
          {visibleCategory === "library" ? (
            <div className="asset-library-overview-panel">
              <LibraryOverview onSelectKind={setCategory} onEditInStudio={(kind, id) => { setEditTarget({ kind, id }); setCategory(kind); }} />
            </div>
          ) : null}
          {CATEGORIES.filter((item) => item.id !== "library").map((item) => {
            const workflowCategory = item.id as PreparedAssetCategory;
            return (
              <div
                key={workflowCategory}
                className="asset-preparation-panel"
                hidden={visibleCategory !== workflowCategory}
              >
                <div className="asset-workflow-toolbar">
                  <span>{workflowCategory === "voices" ? "Create with DSH or import an audio sample." : "Create with DSH or import an existing reference."}</span>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!projectId}
                    onClick={() => openRequest(workflowCategory)}
                  >
                    Ask DSH to create {REQUEST_LABELS[workflowCategory]}
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={!projectId}
                    onClick={() => setImportKind(workflowCategory)}
                  >
                    Import {IMPORT_LABELS[workflowCategory]}
                  </button>
                </div>
                {/* Plugin: actors/scenes/props show the full generation studio (Casting, Set, Props). Queued jobs go to the DSH session agent, which generates with a reviewed local ComfyUI workflow and imports results under the same job token. */}
                {workflowCategory === "actors" || workflowCategory === "scenes" || workflowCategory === "props" ? (
                  workflowCategory === "actors" ? <CastingPage onOpenLibrary={() => setCategory("library")} initialEditId={editTarget?.kind === "actors" ? editTarget.id : undefined} />
                    : workflowCategory === "scenes" ? <SetDesignPage onOpenLibrary={() => setCategory("library")} initialEditId={editTarget?.kind === "scenes" ? editTarget.id : undefined} />
                    : <PropsPage onOpenLibrary={() => setCategory("library")} initialEditId={editTarget?.kind === "props" ? editTarget.id : undefined} />
                ) : (
                  <div className="asset-guidance-card">
                    <div className="workspace-kicker">{IMPORT_LABELS[workflowCategory]} preparation</div>
                    <h2>{workflowCategory === "voices" ? "Create or import a performance sample" : `Create or import ${workflowCategory === "actors" ? "a character" : workflowCategory === "scenes" ? "a location" : "a story object"}`}</h2>
                    <p>{workflowCategory === "voices" ? "Describe the speaker and delivery; DSH can use a compatible local ComfyUI audio workflow and save the verified output to this project's library." : "Describe the look and continuity needs; DSH can inspect a compatible local ComfyUI workflow, generate a reference, and register the exact output in the project library."}</p>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>

      {requestOpen ? (
        <div className="folder-modal asset-import-modal" role="dialog" aria-modal="true" aria-labelledby="dsh-asset-request-title" onClick={() => !busy && setRequestOpen(false)}>
          <form className="folder-modal-panel asset-import-modal-panel" onSubmit={submitRequest} onClick={(event) => event.stopPropagation()}>
            <div className="folder-modal-head">
              <div>
                <span className="mobile-eyebrow">Generate using this DSH session</span>
                <h2 className="folder-modal-title" id="dsh-asset-request-title">Ask DSH to create an asset</h2>
              </div>
              <button type="button" className="btn secondary sm" onClick={() => setRequestOpen(false)} disabled={busy}>Close</button>
            </div>
            {requestError ? <div className="banner error" role="alert">{requestError}</div> : null}
            <p className="field-hint">This sends a request to the current DSH conversation. DSH will inspect a local ComfyUI workflow, generate the media, and register the completed output in this project library.</p>
            <label className="field">
              <span>Asset type</span>
              <select value={requestKind} onChange={(event) => setRequestKind(event.target.value as PreparedAssetCategory)} disabled={busy}>
                {PREPARED_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required disabled={busy} placeholder={requestKind === "voices" ? "e.g. Mira — warm alto" : "Asset name"}/>
            </label>
            <label className="field field-span-2">
              <span>Creative direction</span>
              <textarea value={details} onChange={(event) => setDetails(event.target.value)} maxLength={3000} rows={4} disabled={busy} placeholder={requestKind === "voices" ? "Describe tone, accent, delivery, and sample text." : "Describe appearance, style, setting, or important continuity details."}/>
            </label>
            <div className="folder-modal-actions">
              <button type="submit" className="btn primary" disabled={!projectId || !name.trim() || busy}>{busy ? "Sending…" : "Send request to DSH"}</button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setRequestOpen(false)}>Cancel</button>
            </div>
          </form>
        </div>
      ) : null}

      {importKind && projectId ? (
        <AssetImportDialog kind={importKind} projectId={projectId} onClose={() => setImportKind(null)} onImported={() => setImportKind(null)}/>
      ) : null}
    </main>
  );
}
