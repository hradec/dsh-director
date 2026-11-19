import { useEffect, useMemo, useState } from "react";
import { Lightbox } from "../../shared/components/Lightbox";
import type { OutputSlot } from "../../shared/api/types";
import {
  deleteAssetFile,
  refNoteOf,
  refTagsOf,
  setAssetRef,
  type RefMetaEntry,
  type ReferenceAsset,
} from "../../shared/api/assets";

// Every image of an asset is a reference. Approved ones (tag "approved") sit in an
// always-expanded section; everything else waits in the collapsed Brainstorm section.

interface BoardSlot extends OutputSlot {
  tags: string[];
  note: string;
  /** Poster for library videos (own refs use the full image). */
  thumb?: string | null;
  /** Absolute source path on disk (menu: copy path / AI tag / Open in ComfyUI). */
  abs?: string | null;
  /** Set on library tiles: which library + the path relative to it. */
  libKind?: "images" | "footage";
  libPath?: string;
}

interface Props {
  kind: string;
  asset: ReferenceAsset;
  /** Receives the API-returned asset after attach/scan so the page state stays authoritative. */
  onAsset: (asset: ReferenceAsset) => void;
  /** Called after a file delete so the page can re-fetch its asset list. */
  onDeleted?: () => void;
  /** The single DSH door (agent-task queue) for tile auto-tag and note edits. */
  sendRequest?: (text: string, label: string) => void;
  /** Re-fetch the page after a library tag write (AI tag on a linked tile). */
  onRefresh?: () => void;
}

export function ReferenceBoard({ kind, asset, onAsset, onDeleted, sendRequest, onRefresh }: Props) {
  // Local mirror of ref_meta: tag/note writes update from the server's returned tags,
  // which is where approved/brainstorming exclusivity was enforced.
  const [refMeta, setRefMeta] = useState<Record<string, RefMetaEntry>>(asset.ref_meta ?? {});
  useEffect(() => {
    setRefMeta(asset.ref_meta ?? {});
  }, [asset.id, asset.ref_meta]);

  const [brainstormOpen, setBrainstormOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteAskKey, setNoteAskKey] = useState<string | null>(null);
  const [noteAskDraft, setNoteAskDraft] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Same right-click menu the Footage/Images tabs show on their cards (0.2.74).
  const [menu, setMenu] = useState<{ x: number; y: number; slot: BoardSlot } | null>(null);
  const [comfyKnown, setComfyKnown] = useState<Record<string, "pending" | boolean>>({});
  const [notice, setNotice] = useState("");

  function menuTarget(slot: BoardSlot) {
    const video = /\.(mp4|mov|webm|mkv)$/i.test(slot.filename ?? "");
    if (slot.libKind && slot.libPath) return { seg: slot.libKind, body: { path: slot.libPath } as Record<string, unknown> };
    return { seg: video ? "footage" : "images", body: { path: slot.abs ?? "", asset: { kind, asset_id: asset.id, key: slot.key } } };
  }
  const openMenu = (slot: BoardSlot) => (event: { preventDefault(): void; clientX: number; clientY: number }) => {
    event.preventDefault();
    setNotice("");
    setMenu({ x: event.clientX, y: event.clientY, slot });
  };
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", key); };
  }, [menu]);
  useEffect(() => {
    // Probe for an embedded ComfyUI workflow the first time a tile's menu opens.
    if (!menu || menu.slot.key in comfyKnown) return;
    const target = menuTarget(menu.slot);
    setComfyKnown((k) => ({ ...k, [menu.slot.key]: "pending" }));
    fetch(`/api/${target.seg}/comfy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ probe: true, ...target.body }) })
      .then((r) => (r.ok ? r.json() : { has: false }))
      .then((v) => setComfyKnown((k) => ({ ...k, [menu.slot.key]: Boolean(v?.has) })))
      .catch(() => setComfyKnown((k) => ({ ...k, [menu.slot.key]: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  async function aiTag(slot: BoardSlot) {
    const target = menuTarget(slot);
    setBusyKey(slot.key);
    setError(null);
    try {
      const res = await fetch(`/api/${target.seg}/tag-ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...target.body, existing: slot.tags }) });
      const v = await res.json().catch(() => null);
      if (!res.ok) throw new Error(v?.detail ?? `tag-ai ${res.status}`);
      if (slot.libKind) { onRefresh?.(); }
      else setRefMeta((meta) => ({ ...meta, [slot.key]: { tags: v?.tags ?? slot.tags, note: meta[slot.key]?.note ?? slot.note } }));
      setNotice(`Tagged ${slot.filename ?? slot.key}: ${(v?.tags ?? []).join(", ")}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }
  async function openComfy(slot: BoardSlot) {
    // Copy while this tab still has focus (see 0.2.75 note in FootageBoard); open the tab afterwards.
    const target = menuTarget(slot);
    try {
      const res = await fetch(`/api/${target.seg}/comfy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target.body) });
      const v = await res.json().catch(() => null);
      if (!res.ok) throw new Error(v?.detail ?? `comfy ${res.status}`);
      // A silent writeText rejection used to leave an old graph on the clipboard — pasting loaded the WRONG workflow; fall back to execCommand, then to a JSON download.
      const payload: string = v.ui ?? v.json;   // UI format when converted — the canvas paste path only takes UI graphs
      // Bridge contract v1: sidebar ComfyUI tab open + linked → load in place, skip the clipboard lane.
      if (globalThis.__DSH_COMFY_BRIDGE__?.({ type: "load-workflow", workflow: payload, name: String(target.body.path ?? target.body.file ?? "").split(/[\\/]/).pop()?.replace(/\.[a-z0-9]+$/i, "") || undefined })) { setNotice("Workflow sent to the embedded ComfyUI ✓ — open the ComfyUI sidebar tab to see it"); return; }
      let copied = true;
      try { await navigator.clipboard.writeText(payload); } catch {
        copied = false;
        try { const ta = document.createElement("textarea"); ta.value = payload; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); copied = document.execCommand("copy"); ta.remove(); } catch { /* fall through to download */ }
      }
      if (!copied) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
        a.download = `${String(slot.libPath ?? slot.abs ?? "workflow").split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, "")}-workflow.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        setNotice("Clipboard was blocked — the workflow JSON is DOWNLOADING instead: open it in ComfyUI via File → Open.");
      }
      if (v.host) window.open(v.host, "_blank");
      if (copied) setNotice(v.host ? `ComfyUI opened — paste (Ctrl+V) onto its canvas (copied ✓ ${v.ui ? "editor format" : "raw API graph — use File→Open"})${v.uploaded ? ` · also saved there as ${v.uploaded} (Workflows panel)` : ""}.` : "No ComfyUI answered — the workflow JSON is on your clipboard (copied ✓).");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function copyPath(slot: BoardSlot) {
    try { await navigator.clipboard.writeText(slot.abs ?? ""); setNotice("Absolute path copied to clipboard."); }
    catch { setNotice("Clipboard blocked by the browser — the path was not copied."); }
  }

  useEffect(() => {
    setTagDrafts({});
    setNoteDrafts({});
    setLightboxIndex(null);
    setFilter("");
  }, [asset.id]);

  function entryFor(key: string): RefMetaEntry {
    const local = refMeta[key];
    if (local) return local;
    return { tags: refTagsOf(asset, key), note: refNoteOf(asset, key) };
  }

  const slots = useMemo<BoardSlot[]>(
    () =>
      Object.keys(asset.urls ?? {}).map((key) => {
        const entry = entryFor(key);
        const filename = asset.files?.[key] || key;
        return {
          key,
          label: filename,
          filename,
          url: asset.urls?.[key] ?? null,
          abs: asset.paths?.[key] ?? null,
          tags: entry.tags ?? ["brainstorming"],
          note: entry.note ?? "",
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asset, refMeta],
  );

  // Tag = connection: library pictures/clips tagged with this asset's name sit on the same board.
  // Their tags are edited in the Images/Footage tab, so these tiles are read-only here (lightbox works).
  const librarySlots = useMemo<BoardSlot[]>(
    () =>
      (asset.library_refs ?? []).map((ref) => ({
        key: `lib:${ref.library}:${ref.path}`,
        label: ref.name,
        filename: `${ref.library}/${ref.path}`,
        url: ref.url,
        abs: ref.abs ?? null,
        libKind: ref.library as "images" | "footage",
        libPath: ref.path,
        tags: ref.tags,
        note: "",
        thumb: ref.thumb,
      })),
    [asset.library_refs],
  );
  const allSlots = [...slots, ...librarySlots];
  const approvedSlots = allSlots.filter((slot) => slot.tags.includes("approved"));
  const brainstormSlots = allSlots.filter((slot) => !slot.tags.includes("approved"));
  const needle = filter.trim().toLowerCase();
  // Typing hides images whose tags AND filename do not contain the string.
  const visibleBrainstorm = needle
    ? brainstormSlots.filter(
        (slot) =>
          (slot.filename || "").toLowerCase().includes(needle) ||
          slot.tags.some((tag) => tag.toLowerCase().includes(needle)),
      )
    : brainstormSlots;
  const visibleSlots = [...approvedSlots, ...visibleBrainstorm];

  function applyRef(key: string, next: { tags: string[]; note?: string }) {
    setRefMeta((meta) => ({
      ...meta,
      [key]: { tags: next.tags, note: next.note ?? meta[key]?.note ?? refNoteOf(asset, key) },
    }));
  }

  async function addTag(key: string) {
    const tag = (tagDrafts[key] ?? "").trim();
    if (!tag) return;
    setBusyKey(key);
    setError(null);
    try {
      // Rely on server exclusivity (approved ↔ brainstorming) and refresh from the returned tags.
      const result = await setAssetRef(kind, asset.id, key, { tags_add: [tag] });
      applyRef(key, result);
      setTagDrafts((drafts) => ({ ...drafts, [key]: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function removeTag(key: string, tag: string) {
    setBusyKey(key);
    setError(null);
    try {
      const result = await setAssetRef(kind, asset.id, key, { tags_remove: [tag] });
      applyRef(key, result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function saveNote(key: string) {
    const draft = noteDrafts[key];
    if (draft === undefined || draft === (entryFor(key).note ?? "")) return;
    setError(null);
    try {
      const result = await setAssetRef(kind, asset.id, key, { note: draft });
      applyRef(key, result);
      setNoteDrafts((drafts) => {
        const next = { ...drafts };
        delete next[key];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeFile(key: string) {
    if (!window.confirm(`Delete “${key}” from “${asset.name}”?\n\nThis cannot be undone.`)) return;
    setError(null);
    try {
      await deleteAssetFile(kind, asset.id, key);
      onDeleted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function libTile(slot: BoardSlot) {
    const video = /\.(mp4|mov|webm)$/i.test(slot.filename ?? "");
    const src = slot.thumb ?? (video ? null : slot.url);
    return (
      <div key={slot.key} className="reference-tile reference-tile-library" title="Linked by tag from the Images/Footage library — edit its tags in that tab" onContextMenu={openMenu(slot)}>
        <button
          type="button"
          className="folder-file-card"
          title="Open in lightbox"
          onClick={() => setLightboxIndex(Math.max(0, visibleSlots.findIndex((entry) => entry.key === slot.key)))}
        >
          <div className="folder-file-thumb">{src ? <img loading="lazy" src={src} alt={slot.label} /> : <div className="output-empty">🎞</div>}</div>
          <div className="folder-file-label ellipsis" title={slot.filename}>{slot.filename}</div>
        </button>
        <div className="reference-chips">
          {slot.tags.map((tag) => (
            <span key={tag} className={`reference-chip${tag === "approved" ? " approved" : ""}`}>{tag}</span>
          ))}
        </div>
      </div>
    );
  }

  function askNote(slot: BoardSlot, instruction: string) {
    const fence = String.fromCharCode(34, 34, 34);
    const message = `Director Studio — rewrite the note of the reference "${slot.key}" of the ${kind} "${asset.name}" (asset_id ${asset.id}). Current note:\n${fence}\n${noteDrafts[slot.key] ?? slot.note ?? ""}\n${fence}\nHuman request: ${instruction}\nApply the new note with the director_studio asset.tag action (note = …) and state the result in one line.`;
    sendRequest?.(message, `note ${slot.filename ?? slot.key}`);
    setNoteAskKey(null);
  }

  function tile(slot: BoardSlot) {
    if (slot.key.startsWith("lib:")) return libTile(slot);
    return (
      <div key={slot.key} className="reference-tile" onContextMenu={openMenu(slot)}>
        <button
          type="button"
          className="folder-file-card"
          title="Open in lightbox"
          onClick={() => setLightboxIndex(Math.max(0, visibleSlots.findIndex((entry) => entry.key === slot.key)))}
        >
          <div className="folder-file-thumb">
            {slot.url ? <img loading="lazy" src={slot.url} alt={slot.label} /> : <div className="output-empty">—</div>}
          </div>
          <div className="folder-file-label ellipsis" title={slot.filename || slot.key}>
            {slot.filename || slot.key}
          </div>
        </button>
        <button
          type="button"
          className="btn ghost sm reference-delete"
          title="Delete file"
          aria-label={`Delete ${slot.label}`}
          onClick={() => void removeFile(slot.key)}
        >
          ✕
        </button>
        <div className="reference-chips">
          {slot.tags.map((tag) => (
            <span key={tag} className={`reference-chip${tag === "approved" ? " approved" : ""}`}>
              {tag}
              <button
                type="button"
                className="reference-chip-x"
                title={`Remove tag “${tag}”`}
                aria-label={`Remove tag ${tag} from ${slot.key}`}
                disabled={busyKey === slot.key}
                onClick={() => void removeTag(slot.key, tag)}
              >
                ✕
              </button>
            </span>
          ))}
          <input
            className="reference-tag-add"
            placeholder="+ tag ↵"
            aria-label={`Add tag to ${slot.key}`}
            value={tagDrafts[slot.key] ?? ""}
            disabled={busyKey === slot.key}
            onChange={(event) => setTagDrafts((drafts) => ({ ...drafts, [slot.key]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addTag(slot.key);
              }
            }}
          />
          {sendRequest ? (
            <button
              type="button"
              className="btn secondary sm"
              title="Ask a DSH worker to look at this image and add descriptive tags"
              aria-label="DSH auto-tag this reference"
              onClick={() =>
                sendRequest(
                  `Director Studio — auto-tag the reference "QKEY" of the QKIND "QNAME" (asset_id QID). View the image at QPATH with read_image, then add 3-8 tags that actually fit with the director_studio asset.tag action (tags_add; content words like head, body, full body, frontal, side, calm, roaring) — never add or remove "approved"/"brainstorming" yourself. Report the tags you added.`.replace("QKEY", slot.key).replace("QKIND", kind).replace("QNAME", asset.name).replace("QID", asset.id).replace("QPATH", slot.abs ?? slot.path ?? slot.key),
                  `auto-tag ${slot.filename ?? slot.key}`,
                )
              }
            >
              DSH
            </button>
          ) : null}
        </div>
        <div className="reference-note-row">
          <textarea
            className="reference-note"
            rows={2}
            placeholder="Note (saved on blur)…"
            aria-label={`Note for ${slot.key}`}
            value={noteDrafts[slot.key] ?? slot.note}
            onChange={(event) => setNoteDrafts((drafts) => ({ ...drafts, [slot.key]: event.target.value }))}
            onBlur={() => void saveNote(slot.key)}
          />
          {sendRequest ? (
            <button
              type="button"
              className="btn secondary sm"
              title="Ask DSH to rewrite this reference note"
              aria-label="DSH rewrite this reference note"
              onClick={() => {
                setNoteAskKey(noteAskKey === slot.key ? null : slot.key);
                setNoteAskDraft("");
              }}
            >
              DSH
            </button>
          ) : null}
        </div>
        {noteAskKey === slot.key ? (
          <div className="reference-note-ask">
            <input
              autoFocus
              className="reference-tag-add"
              style={{ width: "14rem" }}
              placeholder="what should the note say…"
              value={noteAskDraft}
              onChange={(event) => setNoteAskDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && noteAskDraft.trim()) askNote(slot, noteAskDraft.trim());
              }}
            />
            <button type="button" className="btn primary sm" disabled={!noteAskDraft.trim()} onClick={() => askNote(slot, noteAskDraft.trim())}>
              Send
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="reference-board">
      {error ? <div className="banner error">{error}</div> : null}

      <section className="reference-board-section reference-approved">
        <h3 className="reference-board-title">
          Approved <span className="muted tiny">{approvedSlots.length}</span>
        </h3>
        {approvedSlots.length ? (
          <div className="reference-tile-grid">{approvedSlots.map((slot) => tile(slot))}</div>
        ) : (
          <p className="empty-copy">No approved references yet — tag a Brainstorm image “approved” to promote it.</p>
        )}
      </section>

      <section className="reference-board-section">
        <button
          type="button"
          className="reference-board-toggle"
          aria-expanded={brainstormOpen}
          onClick={() => setBrainstormOpen((open) => !open)}
        >
          {brainstormOpen ? "▾" : "▸"} Brainstorm <span className="muted tiny">{brainstormSlots.length}</span>
        </button>
        {brainstormOpen ? (
          <>
            <input
              className="reference-filter-input"
              type="search"
              placeholder="Filter by tag or filename…"
              aria-label="Filter brainstorm references"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {visibleBrainstorm.length ? (
              <div className="reference-tile-grid">{visibleBrainstorm.map((slot) => tile(slot))}</div>
            ) : (
              <p className="empty-copy">
                {brainstormSlots.length ? "No brainstorm images match this filter." : "No brainstorming references yet."}
              </p>
            )}
          </>
        ) : null}
      </section>


      {notice ? <div className="reference-notice">{notice}</div> : null}
      {menu ? (
        <div className="footage-menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          <button type="button" onClick={() => { void copyPath(menu.slot); setMenu(null); }}>Copy path to clipboard</button>
          <button type="button" onClick={() => { const s = menu.slot; setMenu(null); void aiTag(s); }}>AI tag / re-tag</button>
          <button
            type="button"
            disabled={comfyKnown[menu.slot.key] !== true}
            title={comfyKnown[menu.slot.key] === false ? "This file has no ComfyUI workflow embedded in its metadata" : "Load the workflow embedded in this file into ComfyUI"}
            onClick={() => { const s = menu.slot; setMenu(null); void openComfy(s); }}
          >
            {comfyKnown[menu.slot.key] === "pending" ? "Open in ComfyUI…" : "Open in ComfyUI"}
          </button>
        </div>
      ) : null}
      {lightboxIndex != null && visibleSlots[lightboxIndex]?.url ? (
        <Lightbox
          slots={visibleSlots}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndex={setLightboxIndex}
        />
      ) : null}
    </div>
  );
}
