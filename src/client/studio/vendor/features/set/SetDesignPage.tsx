import { useEffect, useMemo, useState } from "react";
import { ImageUploadSlot, type LocalImage } from "../../shared/components/ImageUploadSlot";
import { Lightbox } from "../../shared/components/Lightbox";
import { OutputGrid } from "../../shared/components/OutputGrid";
import type { OutputSlot } from "../../shared/api/types";
import { useProject } from "../../shared/project/ProjectContext";
import {
  cancelSceneJob,
  deleteSceneFile,
  fetchSceneDefaults,
  generateScene,
  getSceneJob,
  listSceneJobs,
  listScenes,
  saveSceneJob,
  type JobStatus,
  type SceneJobRecord,
  type SceneMetaDefaults,
  type SceneRecord,
} from "./api";

const ACTIVE: JobStatus[] = ["queued", "uploading", "running"];

interface Props {
  onOpenLibrary: () => void;
  initialEditId?: string;
}

function angleLabel(prompt: string): string {
  const parts = prompt.split(",").map((part) => part.trim());
  const primary = parts[0] || "Angle";
  const descriptive = /^front view$/i.test(primary) && parts[1] && !/^eye level$/i.test(parts[1])
    ? parts[1]
    : primary;
  const shortLabel = descriptive.replace(/\s+view$/i, "").trim();
  return shortLabel.charAt(0).toUpperCase() + shortLabel.slice(1);
}

export function SetDesignPage({ onOpenLibrary, initialEditId }: Props) {
  const { projectId, project } = useProject();

  const [defaults, setDefaults] = useState<SceneMetaDefaults | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [angles, setAngles] = useState("");
  const [disabledAngleIndexes, setDisabledAngleIndexes] = useState<Set<number>>(() => new Set());
  const [prepend, setPrepend] = useState("");
  const [append, setAppend] = useState("");
  const [sceneImg, setSceneImg] = useState<LocalImage | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fixedSeed, setFixedSeed] = useState(false);
  const [seed, setSeed] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [job, setJob] = useState<SceneJobRecord | null>(null);
  // Plugin: which generated angle is being viewed (filters the Output panel and targets Re-run).
  const [viewAngle, setViewAngle] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SceneRecord | null>(null);
  const [libraryScenes, setLibraryScenes] = useState<SceneRecord[]>([]);
  const [editId, setEditId] = useState("");
  const [extraImgs, setExtraImgs] = useState<(LocalImage | null)[]>([]);
  const [refLabels, setRefLabels] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ slots: OutputSlot[]; index: number } | null>(null);

  // Plugin: the edit picker regenerates one existing library scene instead of creating a new one.
  useEffect(() => {
    setEditId("");
    setLibraryScenes([]);
    if (!projectId) return;
    let cancelled = false;
    listScenes(projectId)
      .then((items) => {
        if (!cancelled) setLibraryScenes(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Plugin: select-to-edit refills the form with the stored inputs of that scene.
  function applyPicked(id: string) {
    setEditId(id);
    if (!id) {
      // Back to "New scene": drop everything the previous selection populated.
      setName("");
      setNotes("");
      setAngles(defaults?.default_angles || "");
      setDisabledAngleIndexes(new Set());
      setPrepend(defaults?.default_prepend || "");
      setAppend(defaults?.default_append || "");
      setFixedSeed(false);
      setSeed("");
      setSceneImg(null);
      setExtraImgs([]);
      setRefLabels({});
      setJob(null);
      setViewAngle(null);
      return;
    }
    const picked = libraryScenes.find((item) => item.id === id);
    if (!picked) return;
    setName(picked.name);
    setNotes(picked.notes || "");
    const form = picked.form;
    if (form) {
      if (form.angle_prompts) setAngles(form.angle_prompts.replaceAll("\\n", "\n"));
      setPrepend(form.prepend_text || "");
      setAppend(form.append_text || "");
      if (form.seed !== null && form.seed !== undefined) { setSeed(String(form.seed)); setFixedSeed(!!form.fixed_seed); }
      setRefLabels({ ...(form.ref_labels ?? {}) });
    }
    void fillReferences(picked);
    setViewAngle(null);
    // Plugin: also restore the stored Output-panel render of this asset.
    void listSceneJobs(projectId, 15)
      .then((jobs) => { const last = jobs.find((j) => j.scene_id === id); if (last) setJob(last); })
      .catch(() => undefined);
  }

  // Plugin: fetch the stored reference images back into the upload slots; fall back to the asset's own master render.
  async function fillReferences(picked: SceneRecord) {
    const references = picked.references ?? null;
    setSceneImg(null);
    setExtraImgs([]);
    const toLocal = async (ref: { url: string; filename: string }) => {
      const blob = await fetch(ref.url).then((r) => r.blob());
      return { file: new File([blob], ref.filename, { type: blob.type }), previewUrl: URL.createObjectURL(blob) };
    };
    const primary = references?.scene_image ?? (picked.urls?.master ? { url: picked.urls.master, filename: picked.files?.master || "master.png" } : null);
    if (primary) setSceneImg(await toLocal(primary));
    if (!references) return;
    const extras: (LocalImage | null)[] = [];
    for (const key of Object.keys(references)) if (/^reference_image_\d+$/.test(key)) extras.push(await toLocal(references[key]));
    setExtraImgs(extras);
  }

  useEffect(() => {
    if (!initialEditId) return;
    applyPicked(initialEditId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEditId, libraryScenes]);

  useEffect(() => {
    fetchSceneDefaults()
      .then((d) => {
        setDefaults(d);
        setAngles((prev) => prev || d.default_angles);
        setPrepend((prev) => prev || d.default_prepend || "");
        setAppend((prev) => prev || d.default_append || "");
      })
      .catch((e) => setFormError(String(e)));
  }, []);

  // Project-scoped drafts must never leak into the next project. On a reload,
  // reconnect only to work that is still in progress.
  useEffect(() => {
    setName("");
    setNotes("");
    setAngles(defaults?.default_angles || "");
    setDisabledAngleIndexes(new Set());
    setPrepend(defaults?.default_prepend || "");
    setAppend(defaults?.default_append || "");
    setSceneImg(null);
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
    listSceneJobs(projectId, 15)
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
      getSceneJob(job.id)
        .then(setJob)
        .catch((e) => setFormError(String(e)));
    }, 1500);
    return () => window.clearInterval(t);
  }, [job?.id, job?.status]);

  const status: JobStatus | "idle" = job?.status || "idle";
  const isRunning = job ? ACTIVE.includes(job.status) : false;

  const angleLines = useMemo(
    // Plugin: also split LITERAL backslash-n text so a single-line field entry becomes real angle rows.
    () => angles.split("\n").flatMap((line) => line.split("\\n")).map((line) => line.trim()).filter(Boolean),
    [angles],
  );
  const selectedAngleLines = useMemo(
    () => angleLines.filter((_, index) => !disabledAngleIndexes.has(index)),
    [angleLines, disabledAngleIndexes],
  );
  const angleCount = selectedAngleLines.length;

  const toggleAngle = (index: number) => {
    setDisabledAngleIndexes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const validate = (): boolean => {
    const err: Record<string, string> = {};
    if (!name.trim()) err.name = "Name is required";
    if (!sceneImg) err.scene = "Scene reference image is required";
    if (angleCount < 1) err.angles = "Add at least one angle line";
    if (fixedSeed && seed && Number.isNaN(Number(seed))) err.seed = "Seed must be an integer";
    setFieldErrors(err);
    return Object.keys(err).length === 0;
  };

  const onGenerate = async (onlyAngle: number | null = null) => {
    setFormError(null);
    setSaved(null);
    if (!projectId) {
      setFormError("Select a project in the header first — scenes belong to a project.");
      return;
    }
    if (!validate()) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("name", name.trim());
      fd.set("notes", notes);
      fd.set("angle_prompts", onlyAngle === null ? selectedAngleLines.join("\n") : angleLines[onlyAngle] || "");
      fd.set("prepend_text", prepend);
      fd.set("append_text", append);
      fd.set("fixed_seed", fixedSeed ? "true" : "false");
      fd.set("project_id", projectId);
      if (editId) fd.set("asset_id", editId);
      if (fixedSeed && seed.trim()) fd.set("seed", seed.trim());
      if (sceneImg) fd.set("scene_image", sceneImg.file, sceneImg.file.name);
      extraImgs.forEach((img, index) => {
        if (img) fd.set(`reference_image_${index + 1}`, img.file, img.file.name);
      });
      const labels: Record<string, string> = {};
      if (sceneImg) labels.scene_image = refLabels.scene_image || "Scene image";
      extraImgs.forEach((img, index) => {
        if (img) labels[`reference_image_${index + 1}`] = refLabels[`reference_image_${index + 1}`] || `Reference ${index + 2}`;
      });
      fd.set("reference_labels", JSON.stringify(labels));
      setJob(await generateScene(fd));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    if (!job) return;
    try {
      setJob(await cancelSceneJob(job.id));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSave = async () => {
    if (!job || job.status !== "succeeded") return;
    if (!projectId) {
      setFormError("Select a project in the header — scenes must belong to a project.");
      return;
    }
    setBusy(true);
    try {
      const scene = await saveSceneJob(job.id, {
        name: name.trim(),
        notes,
        project_id: projectId,
      });
      setSaved(scene);
      setJob({ ...job, scene_id: scene.id });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onReset = () => {
    setName("");
    setNotes("");
    setSceneImg(null);
    setDisabledAngleIndexes(new Set());
    setFixedSeed(false);
    setSeed("");
    setFieldErrors({});
    setFormError(null);
    setJob(null);
    setSaved(null);
    if (defaults) {
      setAngles(defaults.default_angles);
      setPrepend(defaults.default_prepend || "");
      setAppend(defaults.default_append || "");
    }
  };

  const statusLabel = useMemo(() => {
    const map: Record<string, string> = {
      idle: "Idle",
      queued: "Queued",
      uploading: "Uploading…",
      running: `Generating ${angleCount || "?"} angles…`,
      succeeded: "Succeeded",
      failed: "Failed",
      cancelled: "Cancelled",
    };
    return map[status] || status;
  }, [status, angleCount]);

  const allOutputKeys = job?.output_order?.length
    ? job.output_order
    : job?.output_stems?.length
      ? job.output_stems
      : Object.keys(job?.outputs || {});
  const placeholderKeys = Array.from(
    { length: angleCount },
    (_, index) => `angle_${String(index).padStart(2, "0")}`,
  );
  // Plugin: per-angle view — a stored render keyed angle_NN belongs to angle line N.
  const hasOutputs = !!job && job.status === "succeeded" && allOutputKeys.length > 0;
  const angleKeyFor = (index: number) => `angle_${String(index).padStart(2, "0")}`;
  const mainKeys = hasOutputs && viewAngle !== null && allOutputKeys.includes(angleKeyFor(viewAngle))
    ? allOutputKeys.filter((key) => key === "master" || key === angleKeyFor(viewAngle))
    : allOutputKeys;
  const angleLabels = Object.fromEntries(
    angleLines.map((line, index) => [angleKeyFor(index), `${String(index + 1).padStart(2, "0")} · ${angleLabel(line)}`]),
  );

  const outputMap = job?.outputs || null;

  return (
    <>
      <main className="workspace">
        <section className="panel input-panel">
          <h2>Set Design · Multi-Angle</h2>
          {projectId ? (
            <p className="project-scope-hint">
              Saving to project <strong>{project?.name || projectId}</strong>
            </p>
          ) : (
            <div className="banner error">Select a project in the header before generating scenes.</div>
          )}
          <div className="block">
            <div className="block-title">Edit existing scene</div>
            <label className="field">
              <span>Target</span>
              <select value={editId} disabled={isRunning} onChange={(e) => applyPicked(e.target.value)}>
                <option value="">New scene</option>
                {libraryScenes.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            {editId ? (
              <p className="field-hint">DSH will re-shoot the requested views for “{libraryScenes.find((item) => item.id === editId)?.name}” and replace its library media in place.</p>
            ) : null}
          </div>
          <p className="field-hint" style={{ marginBottom: "1rem" }}>
            Upload one scene plate. 1728×960 quality mode re-shoots seven selectable views with
            Qwen Edit 2511 multi-angle LoRA. The original plate is saved as master for H3. Filenames
            use your scene name + view, e.g.{" "}
            <code>{name.trim() || "SceneName"}_01_left_side_view_h270_v0.png</code>.
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
                placeholder="e.g. Audition_Room"
              />
              {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
            </label>
            <label className="field">
              <span>Notes</span>
              <input value={notes} disabled={isRunning} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>

          <div className="block">
            <div className="block-title">2. Scene reference</div>
            <ImageUploadSlot
              label={refLabels.scene_image || "Scene image"}
              onRename={(name) => setRefLabels((l) => ({ ...l, scene_image: name }))}
              required
              hint="Single set / environment still. Multi-angle LoRA keeps layout while changing camera."
              value={sceneImg}
              onChange={setSceneImg}
              disabled={isRunning}
              error={fieldErrors.scene}
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

          <div className="block">
            <div className="block-title">
              3. Angles ({angleCount}/{angleLines.length} selected)
            </div>
            <div className="angle-toggle-row" role="group" aria-label="Scene angles">
              {angleLines.map((angle, index) => {
                const selected = !disabledAngleIndexes.has(index);
                const label = angleLabel(angle);
                return (
                  <button
                    key={`${index}-${angle}`}
                    type="button"
                    className={`angle-toggle ${selected ? "selected" : ""}`}
                    aria-label={label}
                    aria-pressed={selected}
                    title={hasOutputs ? `View and re-run this angle (${angleKeyFor(index)})` : angle}
                    disabled={isRunning}
                    onClick={() => {
                      // Plugin: with stored renders a click filters the Output panel; otherwise it toggles generation.
                      if (hasOutputs) setViewAngle((v) => (v === index ? null : index));
                      else toggleAngle(index);
                    }}
                    style={viewAngle === index ? { outline: "1px solid currentColor", outlineOffset: 2 } : undefined}
                  >
                    <span className="angle-toggle-index">{String(index + 1).padStart(2, "0")}</span>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            {hasOutputs && viewAngle !== null ? (
              // Plugin: queue only this angle again; the agent imports it back under angle_NN.
              <button
                type="button"
                className="btn secondary sm"
                style={{ marginTop: "0.4rem" }}
                disabled={isRunning || busy || !editId}
                onClick={() => onGenerate(viewAngle)}
              >
                Re-run Angle {String(viewAngle + 1).padStart(2, "0")} only
              </button>
            ) : null}
            <label className="field">
              <span>
                Angle prompts <span className="req">*</span>
              </span>
              <textarea
                rows={6}
                value={angles}
                disabled={isRunning}
                onChange={(e) => setAngles(e.target.value)}
                placeholder="One angle per line…"
                className="mono-area"
              />
              {fieldErrors.angles ? <span className="field-error">{fieldErrors.angles}</span> : null}
              <span className="field-hint">
                Multi-angle LoRA format, e.g.{" "}
                <code>front view, eye level, medium shot (horizontal: 0, vertical: 0, zoom: 5.0)</code>
              </span>
            </label>
            <label className="field">
              <span>Prepend</span>
              <input
                value={prepend}
                disabled={isRunning}
                onChange={(e) => setPrepend(e.target.value)}
                placeholder="Keep the same set; only change the camera"
              />
            </label>
            <label className="field">
              <span>Append (optional)</span>
              <input value={append} disabled={isRunning} onChange={(e) => setAppend(e.target.value)} />
            </label>
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
              <button type="button" className="btn primary" disabled={busy} onClick={() => onGenerate()}>
                {busy ? "Submitting…" : `Generate ${angleCount || ""} Angles`}
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
              Each non-empty angle line produces one image in a single Comfy batch. Results appear as a multi-view
              set for the library.
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
              {job.used_angles?.length ? <> · {job.used_angles.length} angles</> : null}
            </p>
          ) : null}

          <OutputGrid
            status={status}
            outputs={outputMap}
            mainKeys={mainKeys.length ? mainKeys : placeholderKeys}
            labels={angleLabels}
            showSecondary={false}
            onRemove={
              hasOutputs && (job?.scene_id || editId)
                ? (key) => {
                    // Plugin: delete this stored render from the scene, then refresh the panel from the job record.
                    const assetId = job?.scene_id || editId;
                    if (!assetId || !job) return;
                    void deleteSceneFile(assetId, key)
                      .then(() => getSceneJob(job.id))
                      .then(setJob)
                      .catch((e) => setFormError(e instanceof Error ? e.message : String(e)));
                  }
                : null
            }
            onOpen={(slot, all) => {
              const idx = all.findIndex((s) => s.key === slot.key);
              setLightbox({ slots: all, index: Math.max(0, idx) });
            }}
          />

          <div className="actions output-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!job || job.status !== "succeeded" || busy || !!job.scene_id}
              onClick={onSave}
            >
              {job?.scene_id ? "Saved" : "Save to Library"}
            </button>
            <button type="button" className="btn secondary" disabled={!job || isRunning || busy} onClick={() => onGenerate()}>
              Regenerate
            </button>
          </div>

          {saved || job?.scene_id ? (
            <div className="banner ok">
              Saved as Scene · <code>{saved?.id || job?.scene_id}</code>
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
