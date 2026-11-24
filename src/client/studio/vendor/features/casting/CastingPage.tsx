import { useEffect, useState } from "react";
import { patchAsset } from "../../shared/api/assets";
import { useProject } from "../../shared/project/ProjectContext";
import { AskDshField } from "../../shared/components/AskDshField";
import { LorekeeperPage } from "../../shared/components/LorekeeperPage";
import { FamilyTreePage } from "../../shared/components/FamilyTreePage";
import { ReferenceBoard } from "../assets/ReferenceBoard";
import { listActors, type ActorRecord } from "./api";

interface Props {
  // Kept for the AssetWorkspace prop contract; browsing lives in the Library tab.
  onOpenLibrary: () => void;
  initialEditId?: string;
  sendRequest?: (text: string, label: string) => void;
}

// Filesystem-first: this page no longer generates. It edits one library actor's
// identity text and manages every stored image as a tagged reference.
export function CastingPage({ initialEditId, sendRequest }: Props) {
  const { projectId } = useProject();

  const [actors, setActors] = useState<ActorRecord[]>([]);
  const [editId, setEditId] = useState("");
  const [name, setName] = useState("");
  const [character, setCharacter] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<string | null>(null);

  const refresh = () => {
    if (!projectId) return;
    listActors(projectId)
      .then(setActors)
      .catch((e) => setFormError(String(e)));
  };

  // Project-scoped lists must never leak into the next project.
  useEffect(() => {
    setEditId("");
    setActors([]);
    setFormError(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Library "Edit" jumps here with a pre-selected asset once its list arrives.
  useEffect(() => {
    if (!initialEditId) return;
    if (actors.some((item) => item.id === initialEditId)) setEditId(initialEditId);
  }, [initialEditId, actors]);

  const actor = actors.find((item) => item.id === editId) ?? null;

  // Seed the text fields when the selection changes; list refreshes must not
  // clobber edits in progress.
  useEffect(() => {
    if (!actor) return;
    setName(actor.name);
    setCharacter(actor.character_name || "");
    setDescription(actor.description || "");
    setNotes(actor.notes || "");
    setSavedField(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor?.id]);

  async function save(field: "name" | "character_name" | "description" | "notes", value: string) {
    if (!actor) return;
    if (field === "name" && !value.trim()) {
      setFormError("Name is required");
      return;
    }
    const next = field === "name" ? value.trim() : value;
    if (next === (actor[field] ?? "")) return;
    try {
      const updated = await patchAsset<ActorRecord>("actors", actor.id, { [field]: next });
      setActors((list) => list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
      setSavedField(field);
      setFormError(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="workspace">
      <section className="panel input-panel">
        <h2>Actor Editor</h2>
        {!projectId ? (
          <div className="banner error">Select a project in the header before editing actors.</div>
        ) : null}

        <div className="block">
          <div className="block-title">Edit existing actor</div>
          <label className="field">
            <span>Target</span>
            <select value={editId} onChange={(e) => setEditId(e.target.value)}>
              <option value="">— select an actor —</option>
              {actors.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <p className="field-hint">
            New actors come from “Ask DSH to create” or “Import actor” in the toolbar above; every
            stored image of this actor is a reference in the board on the right.
          </p>
        </div>

        {actor ? (
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
                placeholder="e.g. Lead_Female_A"
              />
              {editId && sendRequest ? (
                <AskDshField
                  field="Asset name"
                  value={name}
                  kind="actors"
                  kindLabel="actor"
                  name={name}
                  assetId={editId}
                  send={sendRequest}
                />
              ) : null}
            </label>
            <label className="field">
              <span>Character name</span>
              <input
                value={character}
                onChange={(e) => setCharacter(e.target.value)}
                onBlur={() => void save("character_name", character)}
                placeholder="the real name in the story — e.g. Nelare Dawnwhisper"
              />
              {editId && sendRequest ? (
                <AskDshField
                  field="Character name"
                  value={character}
                  kind="actors"
                  kindLabel="actor"
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
                placeholder="Who this character is in the story — background, role, relationships…"
              />
              {editId && sendRequest ? (
                <AskDshField
                  field="Description (story)"
                  value={description}
                  kind="actors"
                  kindLabel="actor"
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
                placeholder="Guidance DSH follows when generating or casting this actor…"
              />
              {editId && sendRequest ? (
                <AskDshField
                  field="Notes (for the models)"
                  value={notes}
                  kind="actors"
                  kindLabel="actor"
                  name={name}
                  assetId={editId}
                  send={sendRequest}
                />
              ) : null}
            </label>
            {savedField ? (
              <span className="field-hint">
                {savedField === "name" ? "Asset name saved." : savedField === "character_name" ? "Character name saved." : savedField === "description" ? "Description saved." : "Notes saved."}
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
        {actor ? (
          <ReferenceBoard
            kind="actors"
            asset={actor}
            onAsset={(updated) =>
              setActors((list) => list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
            }
            onDeleted={refresh}
            sendRequest={sendRequest}
            onRefresh={refresh}
          />
        ) : (
          <p className="empty-copy">Select an actor above to view and manage its references.</p>
        )}
      </section>

      {actor ? <LorekeeperPage key={actor.id} kind="figure" queries={[character, name]} label={actor.name} /> : null}
      {actor ? <FamilyTreePage key={`lineage-${actor.id}`} queries={[character, name]} label={actor.name} /> : null}
    </main>
  );
}
