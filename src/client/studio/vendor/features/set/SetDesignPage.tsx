import { useEffect, useState } from "react";
import { patchAsset } from "../../shared/api/assets";
import { useProject } from "../../shared/project/ProjectContext";
import { AskDshField } from "../../shared/components/AskDshField";
import { LorekeeperPage } from "../../shared/components/LorekeeperPage";
import { ReferenceBoard } from "../assets/ReferenceBoard";
import { listScenes, type SceneRecord } from "./api";

interface Props {
  // Kept for the AssetWorkspace prop contract; browsing lives in the Library tab.
  onOpenLibrary: () => void;
  initialEditId?: string;
  sendRequest?: (text: string, label: string) => void;
}

// Filesystem-first: no more multi-angle generation form. This page edits one
// library scene's identity text and manages every stored image as a tagged reference.
export function SetDesignPage({ initialEditId, sendRequest }: Props) {
  const { projectId } = useProject();

  const [scenes, setScenes] = useState<SceneRecord[]>([]);
  const [editId, setEditId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<string | null>(null);

  const refresh = () => {
    if (!projectId) return;
    listScenes(projectId)
      .then(setScenes)
      .catch((e) => setFormError(String(e)));
  };

  // Project-scoped lists must never leak into the next project.
  useEffect(() => {
    setEditId("");
    setScenes([]);
    setFormError(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Library "Edit" jumps here with a pre-selected asset once its list arrives.
  useEffect(() => {
    if (!initialEditId) return;
    if (scenes.some((item) => item.id === initialEditId)) setEditId(initialEditId);
  }, [initialEditId, scenes]);

  const scene = scenes.find((item) => item.id === editId) ?? null;

  // Seed the text fields when the selection changes; list refreshes must not
  // clobber edits in progress.
  useEffect(() => {
    if (!scene) return;
    setName(scene.name);
    setDescription(scene.description || "");
    setNotes(scene.notes || "");
    setSavedField(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.id]);

  async function save(field: "name" | "description" | "notes", value: string) {
    if (!scene) return;
    if (field === "name" && !value.trim()) {
      setFormError("Name is required");
      return;
    }
    const next = field === "name" ? value.trim() : value;
    if (next === (scene[field] ?? "")) return;
    try {
      const updated = await patchAsset<SceneRecord>("scenes", scene.id, { [field]: next });
      setScenes((list) => list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
      setSavedField(field);
      setFormError(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="workspace">
      <section className="panel input-panel">
        <h2>Scene Editor</h2>
        {!projectId ? (
          <div className="banner error">Select a project in the header before editing scenes.</div>
        ) : null}

        <div className="block">
          <div className="block-title">Edit existing scene</div>
          <label className="field">
            <span>Target</span>
            <select value={editId} onChange={(e) => setEditId(e.target.value)}>
              <option value="">— select a scene —</option>
              {scenes.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <p className="field-hint">
            New scenes come from “Ask DSH” or “Import scene” in the toolbar above; every
            stored image of this scene is a reference in the board on the right.
          </p>
        </div>

        {scene ? (
          <div className="block">
            <div className="block-title">Identity</div>
            <label className="field">
              <span>
                Asset name <span className="req">*</span>
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void save("name", name)}
                placeholder="e.g. Audition_Room"
              />
              {editId && sendRequest ? (
                <AskDshField
                  field="Asset name"
                  value={name}
                  kind="scenes"
                  kindLabel="scene"
                  name={name}
                  assetId={editId}
                  send={sendRequest}
                />
              ) : null}
            </label>
            <label className="field">
              <span>Description (story)</span>
              <textarea
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => void save("description", description)}
                placeholder="What this place is in the story — mood, history, what happens here…"
              />
              {editId && sendRequest ? (
                <AskDshField
                  field="Description (story)"
                  value={description}
                  kind="scenes"
                  kindLabel="scene"
                  name={name}
                  assetId={editId}
                  send={sendRequest}
                />
              ) : null}
            </label>
            <label className="field">
              <span>Notes (for the models)</span>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => void save("notes", notes)}
                placeholder="Layout, lighting, continuity guidance DSH should keep across views…"
              />
              {editId && sendRequest ? (
                <AskDshField
                  field="Notes (for the models)"
                  value={notes}
                  kind="scenes"
                  kindLabel="scene"
                  name={name}
                  assetId={editId}
                  send={sendRequest}
                />
              ) : null}
            </label>
            {savedField ? (
              <span className="field-hint">
                {savedField === "name" ? "Asset name saved." : savedField === "description" ? "Description saved." : "Notes saved."}
              </span>
            ) : null}
          </div>
        ) : null}

        {formError ? <div className="banner error">{formError}</div> : null}
      </section>

      <section className="panel output-panel">
        <div className="output-header">
          <h2>References</h2>
        </div>
        {scene ? (
          <ReferenceBoard
            kind="scenes"
            asset={scene}
            onAsset={(updated) =>
              setScenes((list) => list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
            }
            onDeleted={refresh}
            sendRequest={sendRequest}
            onRefresh={refresh}
          />
        ) : (
          <p className="empty-copy">Select a scene above to view and manage its references.</p>
        )}
      </section>

      {scene ? <LorekeeperPage key={scene.id} kind="site" queries={[name]} label={scene.name} /> : null}
    </main>
  );
}
