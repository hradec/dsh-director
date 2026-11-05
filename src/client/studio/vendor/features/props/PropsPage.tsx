import { useEffect, useMemo, useState } from "react";
import { ImageUploadSlot, type LocalImage } from "../../shared/components/ImageUploadSlot";
import { Lightbox } from "../../shared/components/Lightbox";
import { OutputGrid } from "../../shared/components/OutputGrid";
import type { OutputSlot } from "../../shared/api/types";
import { useProject } from "../../shared/project/ProjectContext";
import {
  cancelPropJob,
  generateProp,
  getPropJob,
  listPropJobs,
  listProps,
  savePropJob,
  type JobStatus,
  type PropJobRecord,
  type PropRecord,
} from "./api";

const ACTIVE: JobStatus[] = ["queued", "uploading", "running"];

const MASTER_LABELS = { master: "Prop Reference Sheet" };

interface Props {
  onOpenLibrary: () => void;
  initialEditId?: string;
}

export function PropsPage({ onOpenLibrary, initialEditId }: Props) {
  const { projectId, project } = useProject();

  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [propImg, setPropImg] = useState<LocalImage | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fixedSeed, setFixedSeed] = useState(false);
  const [seed, setSeed] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [job, setJob] = useState<PropJobRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<PropRecord | null>(null);
  const [libraryProps, setLibraryProps] = useState<PropRecord[]>([]);
  const [editId, setEditId] = useState("");
  const [extraImgs, setExtraImgs] = useState<(LocalImage | null)[]>([]);
  const [refLabels, setRefLabels] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ slots: OutputSlot[]; index: number } | null>(null);

  // Plugin: the edit picker regenerates one existing library prop instead of creating a new one.
  useEffect(() => {
    setEditId("");
    setLibraryProps([]);
    if (!projectId) return;
    let cancelled = false;
    listProps(projectId)
      .then((items) => {
        if (!cancelled) setLibraryProps(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Plugin: select-to-edit refills the form with the stored inputs of that prop.
  function applyPicked(id: string) {
    setEditId(id);
    if (!id) {
      // Back to "New prop": drop everything the previous selection populated.
      setName("");
      setNotes("");
      setFixedSeed(false);
      setSeed("");
      setPropImg(null);
      setExtraImgs([]);
      setRefLabels({});
      setJob(null);
      return;
    }
    const picked = libraryProps.find((item) => item.id === id);
    if (!picked) return;
    setName(picked.name);
    setNotes(picked.notes || "");
    const form = picked.form;
    if (form && form.seed !== null && form.seed !== undefined) { setSeed(String(form.seed)); setFixedSeed(!!form.fixed_seed); }
    if (form) setRefLabels({ ...(form.ref_labels ?? {}) });
    void fillReferences(picked);
    // Plugin: also restore the stored Output-panel render of this asset.
    void listPropJobs(projectId, 15)
      .then((jobs) => { const last = jobs.find((j) => j.prop_id === id); if (last) setJob(last); })
      .catch(() => undefined);
  }

  // Plugin: fetch the stored reference images back into the upload slots; fall back to the asset's own master render.
  async function fillReferences(picked: PropRecord) {
    const references = picked.references ?? null;
    setPropImg(null);
    setExtraImgs([]);
    const toLocal = async (ref: { url: string; filename: string }) => {
      const blob = await fetch(ref.url).then((r) => r.blob());
      return { file: new File([blob], ref.filename, { type: blob.type }), previewUrl: URL.createObjectURL(blob) };
    };
    const primary = references?.prop_image ?? (picked.urls?.master ? { url: picked.urls.master, filename: picked.files?.master || "master.png" } : null);
    if (primary) setPropImg(await toLocal(primary));
    const extras: (LocalImage | null)[] = [];
    // Plugin: images imported into the asset later (any non-master key) are references too — show and re-send them, even without job inputs.
    for (const key of Object.keys(picked.urls ?? {})) {
      if (key === "master" || key === "wardrobe_ref") continue;
      extras.push(await toLocal({ url: picked.urls[key], filename: picked.files?.[key] || `${key}.png` }));
    }
    if (!references) {
      setExtraImgs(extras);
      return;
    }
    for (const key of Object.keys(references)) if (/^reference_image_\d+$/.test(key)) extras.push(await toLocal(references[key]));
    setExtraImgs(extras);
  }

  useEffect(() => {
    if (!initialEditId) return;
    applyPicked(initialEditId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEditId, libraryProps]);

  useEffect(() => {
    setName("");
    setNotes("");
    setPropImg(null);
    setExtraImgs([]);
    setRefLabels({});
    setAdvancedOpen(false);
    setFixedSeed(false);
    setSeed("");
    setFieldErrors({});
    setFormError(null);
    setJob(null);
    setBusy(false);
    setSaved(null);
    setLightbox(null);
    if (!projectId) return;
    let cancelled = false;
    listPropJobs(projectId, 15)
      .then((jobs) => {
        if (cancelled) return;
        const active = jobs.find((j) => ACTIVE.includes(j.status));
        if (!active) return;
        setJob(active);
        if (active.name) setName(active.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!job || !ACTIVE.includes(job.status)) return;
    const t = window.setInterval(() => {
      getPropJob(job.id)
        .then(setJob)
        .catch((e) => setFormError(String(e)));
    }, 1500);
    return () => window.clearInterval(t);
  }, [job?.id, job?.status]);

  const status: JobStatus | "idle" = job?.status || "idle";
  const isRunning = job ? ACTIVE.includes(job.status) : false;

  const validate = (): boolean => {
    const err: Record<string, string> = {};
    if (!name.trim()) err.name = "Name is required";
    if (!propImg) err.prop = "Prop photo is required";
    if (fixedSeed && seed && Number.isNaN(Number(seed))) err.seed = "Seed must be an integer";
    setFieldErrors(err);
    return Object.keys(err).length === 0;
  };

  const onGenerate = async () => {
    setFormError(null);
    setSaved(null);
    if (!projectId) {
      setFormError("Select a project in the header first — props belong to a project.");
      return;
    }
    if (!validate()) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("name", name.trim());
      fd.set("notes", notes);
      fd.set("fixed_seed", fixedSeed ? "true" : "false");
      fd.set("project_id", projectId);
      if (editId) fd.set("asset_id", editId);
      if (fixedSeed && seed.trim()) fd.set("seed", seed.trim());
      if (propImg) fd.set("prop_image", propImg.file, propImg.file.name);
      extraImgs.forEach((img, index) => {
        if (img) fd.set(`reference_image_${index + 1}`, img.file, img.file.name);
      });
      const labels: Record<string, string> = {};
      if (propImg) labels.prop_image = refLabels.prop_image || "Prop photo";
      extraImgs.forEach((img, index) => {
        if (img) labels[`reference_image_${index + 1}`] = refLabels[`reference_image_${index + 1}`] || `Reference ${index + 2}`;
      });
      fd.set("reference_labels", JSON.stringify(labels));
      setJob(await generateProp(fd));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    if (!job) return;
    try {
      setJob(await cancelPropJob(job.id));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSave = async () => {
    if (!job || job.status !== "succeeded") return;
    if (!projectId) {
      setFormError("Select a project in the header — props must belong to a project.");
      return;
    }
    setBusy(true);
    try {
      const record = await savePropJob(job.id, {
        name: name.trim(),
        notes,
        project_id: projectId,
      });
      setSaved(record);
      setJob({ ...job, prop_id: record.id });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onReset = () => {
    setName("");
    setNotes("");
    setPropImg(null);
    setFixedSeed(false);
    setSeed("");
    setFieldErrors({});
    setFormError(null);
    setJob(null);
    setSaved(null);
  };

  const statusLabel = useMemo(() => {
    const map: Record<string, string> = {
      idle: "Idle",
      queued: "Queued",
      uploading: "Uploading…",
      running: "Preparing reference sheet…",
      succeeded: "Succeeded",
      failed: "Failed",
      cancelled: "Cancelled",
    };
    return map[status] || status;
  }, [status]);

  const outputMap = job?.outputs || null;
  const mainKeys = job?.output_order?.length ? job.output_order : ["master"];

  return (
    <>
      <main className="workspace">
        <section className="panel input-panel">
          <h2>Props · Reference Sheet</h2>
          {projectId ? (
            <p className="project-scope-hint">
              Saving to project <strong>{project?.name || projectId}</strong>
            </p>
          ) : (
            <div className="banner error">Select a project in the header before preparing props.</div>
          )}
          <div className="block">
            <div className="block-title">Edit existing prop</div>
            <label className="field">
              <span>Target</span>
              <select value={editId} disabled={isRunning} onChange={(e) => applyPicked(e.target.value)}>
                <option value="">New prop</option>
                {libraryProps.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            {editId ? (
              <p className="field-hint">DSH will generate a new reference sheet for “{libraryProps.find((item) => item.id === editId)?.name}” and replace its library media in place.</p>
            ) : null}
          </div>
          <p className="field-hint" style={{ marginBottom: "1rem" }}>
            Upload one photo. Director Studio creates one multi-view reference sheet: the same
            prop in a large hero view and supporting angles, on a neutral studio background.
            H3 receives the finished sheet as one picture reference.
          </p>

          <div className="block">
            <div className="block-title">1. Identity</div>
            <label className="field">
              <span>
                Name <span className="req">*</span>
              </span>
              <input
                value={name}
                disabled={isRunning}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Folding knife"
              />
              {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
            </label>
            <label className="field">
              <span>Notes</span>
              <input
                value={notes}
                disabled={isRunning}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional: logo, material, color"
              />
            </label>
          </div>

          <div className="block">
            <div className="block-title">2. Photo</div>
            <ImageUploadSlot
              label={refLabels.prop_image || "Prop photo"}
              onRename={(name) => setRefLabels((l) => ({ ...l, prop_image: name }))}
              required
              hint="Phone snap, catalog still, or generated object. One object, as complete as possible."
              value={propImg}
              onChange={setPropImg}
              disabled={isRunning}
              error={fieldErrors.prop}
            />
            {extraImgs.length ? (
              <div className="upload-row two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.85rem", marginTop: "0.65rem" }}>
                {extraImgs.map((img, index) => (
                  <div key={`extra-${index}`} style={{ position: "relative" }}>
                    <ImageUploadSlot
                      label={refLabels[`reference_image_${index + 1}`] || `Reference ${index + 2}`}
                      onRename={(name) => setRefLabels((l) => ({ ...l, [`reference_image_${index + 1}`]: name }))}
                      value={img}
                      onChange={(value) => setExtraImgs((list) => list.map((entry, position) => (position === index ? value : entry)))}
                      disabled={isRunning}
                    />
                    <button
                      type="button"
                      className="btn ghost sm"
                      title="Remove reference"
                      aria-label="Remove reference"
                      disabled={isRunning}
                      style={{ position: "absolute", top: "-0.5rem", right: "-0.4rem", width: "1.5rem", height: "1.5rem", padding: 0, borderRadius: "999px", border: "1px solid currentColor", lineHeight: 1 }}
                      onClick={() => setExtraImgs((list) => list.filter((_, position) => position !== index))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <button type="button" className="btn secondary sm" style={{ marginTop: "0.5rem" }} disabled={isRunning || extraImgs.length >= 6} onClick={() => setExtraImgs((list) => [...list, null])}>
              + Add reference
            </button>
          </div>

          <div className="block advanced">
            <button type="button" className="advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
              {advancedOpen ? "▾" : "▸"} Advanced
            </button>
            {advancedOpen ? (
              <div className="advanced-body">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={fixedSeed}
                    disabled={isRunning}
                    onChange={(e) => setFixedSeed(e.target.checked)}
                  />
                  <span>Fixed seed</span>
                </label>
                {fixedSeed ? (
                  <label className="field">
                    <span>Seed</span>
                    <input
                      value={seed}
                      disabled={isRunning}
                      onChange={(e) => setSeed(e.target.value)}
                      inputMode="numeric"
                    />
                    {fieldErrors.seed ? <span className="field-error">{fieldErrors.seed}</span> : null}
                  </label>
                ) : null}
              </div>
            ) : null}
          </div>

          {formError ? <div className="banner error">{formError}</div> : null}

          <div className="actions">
            {!isRunning ? (
              <button type="button" className="btn primary" disabled={busy} onClick={onGenerate}>
                {busy ? "Submitting…" : "Prepare Reference Sheet"}
              </button>
            ) : (
              <button type="button" className="btn danger" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button type="button" className="btn ghost" disabled={isRunning} onClick={onReset}>
              Reset form
            </button>
          </div>
        </section>

        <section className="panel output-panel">
          <div className="output-header">
            <h2>Output</h2>
            <div className={`status-pill status-${status}`}>
              <span className="dot" />
              {statusLabel}
              {job ? <span className="job-id">{job.id}</span> : null}
            </div>
          </div>

          {!job ? (
            <p className="empty-copy">
              The prepared reference sheet appears here. Save it to the library so Director can
              cast its complete multi-view object information as a single H3 picture.
            </p>
          ) : null}

          {job?.error && (job.status === "failed" || job.status === "cancelled") ? (
            <div className="banner error">{job.error}</div>
          ) : null}

          {job?.seed != null ? (
            <p className="meta-line">
              Seed <code>{job.seed}</code>
              {job.comfy_prompt_id ? (
                <>
                  {" "}
                  · Comfy <code>{job.comfy_prompt_id.slice(0, 8)}…</code>
                </>
              ) : null}
            </p>
          ) : null}

          <OutputGrid
            status={status}
            outputs={outputMap}
            mainKeys={mainKeys}
            labels={MASTER_LABELS}
            showSecondary={false}
            onOpen={(slot, all) => {
              const idx = all.findIndex((s) => s.key === slot.key);
              setLightbox({ slots: all, index: Math.max(0, idx) });
            }}
          />

          <div className="actions output-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!job || job.status !== "succeeded" || busy || !!job.prop_id}
              onClick={onSave}
            >
              {job?.prop_id ? "Saved" : "Save to Library"}
            </button>
            <button type="button" className="btn secondary" disabled={!job || isRunning || busy} onClick={onGenerate}>
              Regenerate
            </button>
          </div>

          {saved || job?.prop_id ? (
            <div className="banner ok">
              Saved as Prop · <code>{saved?.id || job?.prop_id}</code>
              <button type="button" className="btn ghost sm" onClick={onOpenLibrary}>
                View in Library
              </button>
            </div>
          ) : null}
        </section>
      </main>

      {lightbox ? (
        <Lightbox
          slots={lightbox.slots}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox((lb) => (lb ? { ...lb, index: i } : null))}
        />
      ) : null}
    </>
  );
}
