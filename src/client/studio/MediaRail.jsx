import { useEffect, useMemo, useState } from "react";
import { fetch as apiFetch } from "./fetch-inject.mjs";
import { ZoomPanImage } from "./vendor/shared/components/ImageCanvas.tsx";

// Session media rail: every image/video file in this session's library as a card,
// newest first. Same-title cards group into version stacks (newest is the face;
// ‹ › step through older versions, each stamped with date/time + vN).
// ponytail: versions come from library assets sharing a title (regenerated assets);
// a hard delete of an old asset erases its version history. Upgrade path: keep retired files.

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_EXT = /\.(mp4|webm)$/i;

function buildCards(assets) {
  const cards = [];
  for (const a of assets) {
    if (a.kind === "voices") continue;
    for (const key of Object.keys(a.files ?? {})) {
      const filename = a.files[key] ?? "", url = a.urls?.[key];
      if (!url) continue;
      const video = VIDEO_EXT.test(filename), image = IMAGE_EXT.test(filename);
      if (!video && !image) continue;
      cards.push({ title: a.name || key, kind: a.kind, key, url, type: video ? "video" : "image", at: a.updated_at || a.created_at || "" });
    }
  }
  return cards;
}

function groupVersions(cards) {
  const byTitle = new Map();
  for (const c of cards) {
    const t = c.title.trim().toLowerCase();
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(c);
  }
  const groups = [...byTitle.values()];
  for (const g of groups) g.sort((x, y) => String(x.at).localeCompare(String(y.at))); // oldest first, newest = face
  groups.sort((x, y) => String(y[y.length - 1].at).localeCompare(String(x[x.length - 1].at)));
  return groups;
}

const fmt = (at) => String(at).replace("T", " ").slice(0, 16);

export function MediaRail({ onClose }) {
  const [assets, setAssets] = useState(null);
  const [records, setRecords] = useState([]); // session media-store registrations (review/registered media)
  const [filter, setFilter] = useState("both");
  const [cursor, setCursor] = useState({}); // title → chosen version index
  const [open, setOpen] = useState(null); // card open in the big viewer
  useEffect(() => {
    const session = globalThis.__DSH_DIRECTOR_SESSION__ ?? "";
    // ponytail: no cross-source dedupe — a review image that later became an asset can show twice;
    // the title-group stacks usually fold them together anyway. Upgrade path: dedupe by sha256 once the library API exposes it.
    Promise.all([
      apiFetch("/api/library").then((r) => r.json()).catch(() => []),
      session ? apiFetch(`/director-media/list?session=${encodeURIComponent(session)}`).then((r) => r.json()).then((v) => (Array.isArray(v?.items) ? v.items : [])).catch(() => []) : Promise.resolve([]),
    ]).then(([assetList, list]) => { setAssets(assetList); setRecords(list); });
  }, []);
  const groups = useMemo(() => {
    const shelf = assets ? buildCards(assets) : [];
    if (assets) for (const r of records) shelf.push({ title: String(r.filename ?? "").replace(/\.[^.]+$/, "") || r.id, kind: "session", key: r.type, url: r.url, type: r.type, at: r.at ?? "" });
    return groupVersions(shelf);
  }, [assets, records]);
  const shown = filter === "both" ? groups : groups.filter((g) => g.some((c) => c.type === filter));
  return (
    <aside className="media-rail" aria-label="Session media">
      <div className="media-rail-head">
        <strong>Session media</strong>
        <div className="media-rail-filters" role="group" aria-label="Media filter">
          {[["images", "Images"], ["videos", "Videos"], ["both", "Both"]].map(([f, label]) => (
            <button key={f} type="button" className={filter === f ? "btn primary sm" : "btn ghost sm"} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
        {onClose ? <button type="button" className="btn ghost sm" aria-label="Close media rail" onClick={onClose}>✕</button> : null}
      </div>
      <div className="media-rail-grid">
        {shown.map((g) => {
          const t = g[0].title.trim().toLowerCase();
          const i = Math.min(cursor[t] ?? g.length - 1, g.length - 1);
          const c = g[i];
          return (
            <div key={t} className="media-card" role="button" tabIndex={0} onClick={() => setOpen(c)} onKeyDown={(e) => e.key === "Enter" && setOpen(c)}>
              {g.length > 1 ? (
                <div className="media-card-versions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" aria-label="Older version" onClick={() => setCursor((v) => ({ ...v, [t]: Math.max(0, i - 1) }))}>‹</button>
                  <span>{`v${i + 1}/${g.length}`}</span>
                  <button type="button" aria-label="Newer version" onClick={() => setCursor((v) => ({ ...v, [t]: Math.min(g.length - 1, i + 1) }))}>›</button>
                </div>
              ) : null}
              {c.type === "video" ? <video src={c.url} muted preload="metadata" /> : <img src={c.url} alt={c.title} loading="lazy" />}
              <div className="media-card-foot">
                <span title={c.title}>{c.title}</span>
                <span className="muted tiny">{`v${i + 1} · ${fmt(c.at)} · ${c.kind}`}</span>
              </div>
            </div>
          );
        })}
        {!assets ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted">No media yet.</p> : null}
      </div>
      {open ? (
        <div className="media-rail-viewer" role="dialog" onClick={() => setOpen(null)}>
          <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
            {open.type === "video"
              ? <video src={open.url} controls autoPlay />
              : <ZoomPanImage src={open.url} alt={open.title} className="lightbox-canvas" />}
          </div>
          <button type="button" className="lightbox-close btn secondary sm" onClick={() => setOpen(null)}>Close</button>
        </div>
      ) : null}
    </aside>
  );
}
