import { useMemo, useState } from "react";
import type { OutputSlot } from "../../shared/api/types";
import { refTagsOf } from "../../shared/api/assets";
import { Lightbox } from "../../shared/components/Lightbox";
import { CompareWipe } from "../../shared/components/ImageCanvas";
import type { LibraryAsset } from "./api";

const PREVIEW_KEYS = [
  "layout",
  "fullbody_threeview",
  "master",
  "asset_sheet",
  "bust_threeview",
  "wardrobe_ref",
  "image",
  "plate",
  "video",
] as const;

const KEY_LABELS: Record<string, string> = {
  master: "Master",
  fullbody_threeview: "Full-body three-view",
  bust_threeview: "Bust three-view",
  asset_sheet: "Asset sheet",
  wardrobe_ref: "Wardrobe ref",
  layout: "Layout",
  image: "Image",
  plate: "Plate",
  video: "Video",
  input_actor: "Input · actor",
  input_wardrobe: "Input · wardrobe",
  input_scene: "Input · scene",
};

function labelForKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  if (key.startsWith("input_")) return `Input · ${key.slice(6)}`;
  return key.replace(/_/g, " ");
}

export function assetPreviewUrl(asset: LibraryAsset): string | null {
  if (asset.kind === "voices") return null;
  const urls = asset.urls || {};
  for (const key of PREVIEW_KEYS) {
    if (urls[key]) return urls[key];
  }
  return Object.values(urls).find(Boolean) || null;
}

export function assetSlots(asset: LibraryAsset): OutputSlot[] {
  const urls = asset.urls || {};
  const files = asset.files || {};
  const keys = new Set([...Object.keys(urls), ...Object.keys(files)]);
  const ordered = [
    ...PREVIEW_KEYS.filter((key) => keys.has(key)),
    ...[...keys]
      .filter((key) => !(PREVIEW_KEYS as readonly string[]).includes(key))
      .sort(),
  ];
  return ordered
    .filter((key) => urls[key])
    .map((key) => ({
      key,
      label: labelForKey(key),
      filename: files[key] || null,
      url: urls[key],
    }));
}

export function AssetDetailDialog({
  asset,
  busy = false,
  onClose,
  onDelete,
  onEdit,
  onFilesChanged,
}: {
  asset: LibraryAsset;
  busy?: boolean;
  onClose: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  onFilesChanged?: () => void;
}) {
  const slots = useMemo(() => assetSlots(asset), [asset]);
  // Filesystem-first: the library dialog shows only approved references. With nothing
  // approved yet it falls back to the master file so the dialog is never empty.
  const shownSlots = useMemo(() => {
    if (asset.kind === "voices") return slots;
    const approved = slots.filter((slot) => refTagsOf(asset, slot.key).includes("approved"));
    if (approved.length) return approved;
    const master = slots.filter((slot) => slot.key === "master");
    return master.length ? master : slots;
  }, [asset, slots]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Plugin: delete ONE stored file (agents can pile hundreds of test renders onto an asset).
  async function removeFile(key: string) {
    if (!window.confirm(`Delete “${labelForKey(key)}” from “${asset.name}”?\n\nThis cannot be undone.`)) return;
    const res = await fetch(`/api/library/${asset.kind}/${asset.id}/files/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (res.ok) onFilesChanged?.();
    else window.alert(`Delete failed: ${await res.text()}`);
  }

  return (
    <>
      <div
        className="folder-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${asset.name} assets`}
        onClick={onClose}
      >
        <div className="folder-modal-panel" onClick={(event) => event.stopPropagation()}>
          <div className="folder-modal-head">
            <div>
              <h2 className="folder-modal-title">{asset.name}</h2>
              <p className="muted tiny">
                {asset.kind} · {asset.pipeline_id || "asset"}
                {asset.job_id ? ` · ${asset.job_id}` : ""}
                {asset.seed != null ? ` · seed ${asset.seed}` : ""}
              </p>
              {asset.notes ? <p className="folder-modal-notes">{asset.notes}</p> : null}
            </div>
            <div className="folder-modal-actions">
              {onEdit ? (
                <button type="button" className="btn secondary sm" disabled={busy} onClick={onEdit}>
                  Edit
                </button>
              ) : null}
              {onDelete ? (
                <button type="button" className="btn danger sm" disabled={busy} onClick={onDelete}>
                  Delete
                </button>
              ) : null}
              <button type="button" className="btn secondary sm" onClick={onClose}>
                Close
              </button>
            </div>
          </div>

          {shownSlots.length === 0 ? (
            <p className="empty-copy">No files in this asset.</p>
          ) : (
            <div className="folder-file-grid">
              {shownSlots.map((slot, index) =>
                asset.kind === "voices" ? (
                  <div key={slot.key} className="folder-file-card voice-file-card">
                    <div className="folder-file-label">{slot.label}</div>
                    <audio controls preload="metadata" src={slot.url || undefined} />
                    {slot.filename ? <div className="muted tiny ellipsis">{slot.filename}</div> : null}
                    <button type="button" className="btn ghost sm" title="Delete file" aria-label={`Delete ${slot.label}`} disabled={busy} style={{ marginTop: "0.3rem" }} onClick={() => void removeFile(slot.key)}>
                      ✕
                    </button>
                  </div>
                ) : (
                  <div key={slot.key} style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="folder-file-card"
                      onClick={() => setLightboxIndex(index)}
                    >
                      <div className="folder-file-thumb">
                        {slot.url ? <img loading="lazy" src={slot.url} alt={slot.label} /> : <div className="output-empty">—</div>}
                      </div>
                      <div className="folder-file-label">{slot.label}</div>
                      {slot.filename ? <div className="muted tiny ellipsis">{slot.filename}</div> : null}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      title="Delete file"
                      aria-label={`Delete ${slot.label}`}
                      disabled={busy}
                      style={{ position: "absolute", top: "-0.5rem", right: "-0.4rem", width: "1.5rem", height: "1.5rem", padding: 0, borderRadius: "999px", border: "1px solid currentColor", lineHeight: 1 }}
                      onClick={() => void removeFile(slot.key)}
                    >
                      ✕
                    </button>
                  </div>
                 ),
               )}
             </div>
           )}
           {asset.kind !== "voices" && shownSlots.filter((slot) => slot.url).length >= 2 ? (
             <div className="asset-compare">
               <div className="muted tiny">Compare files — pick A and B, drag the slider to wipe</div>
               <CompareWipe images={shownSlots.filter((slot) => slot.url).map((slot) => ({ src: slot.url!, label: slot.label || slot.key }))} />
             </div>
           ) : null}
         </div>
       </div>

      {lightboxIndex != null ? (
        <Lightbox
          slots={shownSlots}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndex={setLightboxIndex}
        />
      ) : null}
    </>
  );
}
