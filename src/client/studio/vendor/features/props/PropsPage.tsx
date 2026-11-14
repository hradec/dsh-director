import { useEffect, useState } from "react";
import { patchAsset } from "../../shared/api/assets";
import { useProject } from "../../shared/project/ProjectContext";
import { ReferenceBoard } from "../assets/ReferenceBoard";
import { listProps, type PropRecord } from "./api";

interface Props {
  // Kept for the AssetWorkspace prop contract; browsing lives in the Library tab.
  onOpenLibrary: () => void;
  initialEditId?: string;
}

// Filesystem-first: no more reference-sheet generation form. This page edits one
// library prop's identity text and manages every stored image as a tagged reference.
export function PropsPage({ initialEditId }: Props) {
  const { projectId } = useProject();

  const [props, setProps] = useState<PropRecord[]>([]);
  const [editId, setEditId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<string | null>(null);

  const refresh = () => {
    if (!projectId) return;
    listProps(projectId)
      .then(setProps)
      .catch((e) => setFormError(String(e)));
  };

  // Project-scoped lists must never leak into the next project.
  useEffect(() => {
    setEditId("");
    setProps([]);
    setFormError(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Library "Edit" jumps here with a pre-selected asset once its list arrives.
  useEffect(() => {
    if (!initialEditId) return;
    if (props.some((item) => item.id === initialEditId)) setEditId(initialEditId);
  }, [initialEditId, props]);

  const prop = props.find((item) => item.id === editId) ?? null;

  // Seed the text fields when the selection changes; list refreshes must not
  // clobber edits in progress.
  useEffect(() => {
    if (!prop) return;
    setName(prop.name);
    setDescription(prop.description || "");
    setNotes(prop.notes || "");
    setSavedField(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prop?.id]);

  async function save(field: "name" | "description" | "notes", value: string) {
    if (!prop) return;
    if (field === "name" && !value.trim()) {
      setFormError("Name is required");
      return;
    }
    const next = field === "name" ? value.trim() : value;
    if (next === (prop[field] ?? "")) return;
    try {
      const updated = await patchAsset<PropRecord>("props", prop.id, { [field]: next });
      setProps((list) => list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
      setSavedField(field);
      setFormError(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="workspace">
      <section className="panel input-panel">
        <h2>Prop Editor</h2>
        {!projectId ? (
          <div className="banner error">Select a project in the header before editing props.</div>
        ) : null}

        <div className="block">
          <div className="block-title">Edit existing prop</div>
          <label className="field">
            <span>Target</span>
            <select value={editId} onChange={(e) => setEditId(e.target.value)}>
              <option value="">— select a prop —</option>
              {props.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <p className="field-hint">
            New props come from “Ask DSH to create” or “Import prop” in the toolbar above; every
            stored image of this prop is a reference in the board on the right.
          </p>
        </div>

        {prop ? (
          <div className="block">
            <div className="block-title">Identity</div>
            <label className="field">
              <span>
                Name <span className="req">*</span>
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void save("name", name)}
                placeholder="e.g. Folding knife"
              />
            </label>
            <label className="field">
              <span>Description (story)</span>
              <textarea
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => void save("description", description)}
                placeholder="What this object is in the story — owner, significance, where it appears…"
              />
            </label>
            <label className="field">
              <span>Notes (for the models)</span>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => void save("notes", notes)}
                placeholder="Logo, material, color, wear continuity DSH must keep…"
              />
            </label>
            {savedField ? (
              <span className="field-hint">
                {savedField === "name" ? "Name saved." : savedField === "description" ? "Description saved." : "Notes saved."}
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
        {prop ? (
          <ReferenceBoard
            kind="props"
            asset={prop}
            onAsset={(updated) =>
              setProps((list) => list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
            }
            onDeleted={refresh}
          />
        ) : (
          <p className="empty-copy">Select a prop above to view and manage its references.</p>
        )}
      </section>
    </main>
  );
}
