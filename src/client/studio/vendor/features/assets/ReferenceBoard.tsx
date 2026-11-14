import { useEffect, useMemo, useState } from "react";
import { Lightbox } from "../../shared/components/Lightbox";
import type { OutputSlot } from "../../shared/api/types";
import {
  attachAssetSource,
  deleteAssetFile,
  refNoteOf,
  refTagsOf,
  scanAssetSources,
  setAssetRef,
  type RefMetaEntry,
  type ReferenceAsset,
} from "../../shared/api/assets";

// Every image of an asset is a reference. Approved ones (tag "approved") sit in an
// always-expanded section; everything else waits in the collapsed Brainstorm section.

interface BoardSlot extends OutputSlot {
  tags: string[];
  note: string;
}

interface Props {
  kind: string;
  asset: ReferenceAsset;
  /** Receives the API-returned asset after attach/scan so the page state stays authoritative. */
  onAsset: (asset: ReferenceAsset) => void;
  /** Called after a file delete so the page can re-fetch its asset list. */
  onDeleted?: () => void;
}

export function ReferenceBoard({ kind, asset, onAsset, onDeleted }: Props) {
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
  const [notice, setNotice] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    setTagDrafts({});
    setNoteDrafts({});
    setNotice(null);
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
          tags: entry.tags ?? ["brainstorming"],
          note: entry.note ?? "",
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asset, refMeta],
  );

  const approvedSlots = slots.filter((slot) => slot.tags.includes("approved"));
  const brainstormSlots = slots.filter((slot) => !slot.tags.includes("approved"));
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

  async function rescan() {
    setBusyKey("sources");
    setError(null);
    try {
      const out = await scanAssetSources(kind, asset.id);
      onAsset(out.asset);
      setNotice(out.added === 1 ? "Rescan added 1 new reference." : `Rescan added ${out.added} new references.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function attach() {
    const path = sourcePath.trim();
    if (!path) return;
    setBusyKey("sources");
    setError(null);
    try {
      const out = await attachAssetSource(kind, asset.id, path);
      onAsset(out.asset);
      setSourcePath("");
      setNotice(out.added === 1 ? "Attached folder added 1 new reference." : `Attached folder added ${out.added} new references.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  function tile(slot: BoardSlot) {
    return (
      <div key={slot.key} className="reference-tile">
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
        </div>
        <textarea
          className="reference-note"
          rows={2}
          placeholder="Note (saved on blur)…"
          aria-label={`Note for ${slot.key}`}
          value={noteDrafts[slot.key] ?? slot.note}
          onChange={(event) => setNoteDrafts((drafts) => ({ ...drafts, [slot.key]: event.target.value }))}
          onBlur={() => void saveNote(slot.key)}
        />
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

      <div className="reference-sources">
        <span className="reference-board-title">Source folders</span>
        {asset.sources?.length ? (
          <ul className="reference-source-list">
            {asset.sources.map((source) => (
              <li key={source}>
                <code>{source}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-copy">No source folders attached yet.</p>
        )}
        <div className="reference-source-actions">
          <button type="button" className="btn secondary sm" disabled={busyKey === "sources"} onClick={() => void rescan()}>
            Rescan
          </button>
          <input
            className="reference-source-input"
            placeholder="workspace folder, e.g. nelare-designs"
            aria-label="Source folder path"
            value={sourcePath}
            onChange={(event) => setSourcePath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void attach();
              }
            }}
          />
          <button
            type="button"
            className="btn secondary sm"
            disabled={busyKey === "sources" || !sourcePath.trim()}
            onClick={() => void attach()}
          >
            Attach folder
          </button>
          {notice ? <span className="field-hint">{notice}</span> : null}
        </div>
      </div>

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
