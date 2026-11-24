import { useEffect, useState } from "react";

// Book-page bookmark for the asset pages: the ribbon tab on the right edge
// "turns" the page over to the lorekeeper spread — canon facts resolved from
// the workspace df-universe/corpus plus the LegendsViewer-Next page embedded.
// Data comes from the dsh-director-dwarf-fortress plugin (/dwarf-fortress/*),
// session id from the studio mount (StudioSidebar sets __DSH_DIRECTOR_SESSION__).

type CanonKind = "figure" | "site" | "artifact";

interface CanonHit {
  kind: CanonKind;
  id: number | string;
  name: string;
  race?: string;
  birth?: number | null;
  death?: number | null;
  type?: string;
  founded?: number | string | null;
  viewer_path: string;
}

interface CanonEvent {
  year: number | null;
  type: string;
}

// Same localhost-remap trick as the dwarf plugin's LegendsTab: when the GUI is
// opened from another device (iPad) the viewer's 127.0.0.1 URL must become this host.
export function remapViewer(url: string): string {
  try {
    const parsed = new URL(url);
    if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
      parsed.protocol = window.location.protocol;
      parsed.hostname = window.location.hostname;
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

export async function getJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(path);
  if (response.ok) return response.json();
  let detail = String(response.status);
  try {
    const body = await response.json();
    if (body && typeof body.detail === "string") detail = body.detail;
  } catch {
    /* keep status text */
  }
  throw new Error(detail);
}

function factLine(hit: CanonHit): string {
  if (hit.kind === "figure") {
    const life = hit.birth != null || hit.death != null ? ` · b. ${hit.birth ?? "?"} – d. ${hit.death ?? "alive?"}` : "";
    return [hit.race, life ? life.replace(/^ · /, "") : ""].filter(Boolean).join(" · ");
  }
  if (hit.kind === "site") return [hit.type, hit.founded != null ? `founded ${hit.founded}` : ""].filter(Boolean).join(" · ");
  return hit.type || "";
}

export function LorekeeperPage({ kind, queries, label }: { kind: CanonKind; queries: string[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [hits, setHits] = useState<CanonHit[]>([]);
  const [selected, setSelected] = useState<CanonHit | null>(null);
  const [events, setEvents] = useState<CanonEvent[]>([]);
  const [viewerBase, setViewerBase] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setStatus("loading");
    setError("");
    const session = encodeURIComponent(String((globalThis as unknown as { __DSH_DIRECTOR_SESSION__?: string }).__DSH_DIRECTOR_SESSION__ ?? ""));
    (async () => {
      let base = "";
      try {
        const config = await getJson(`/dwarf-fortress/config?session=${session}`);
        base = remapViewer(String(config.viewerBaseUrl ?? ""));
      } catch (e) {
        if (!alive) return;
        setStatus("error");
        setError("Lorekeeper service unreachable — the running DSH server needs an idle restart to load it.");
        return;
      }
      const names = queries.map((item) => item.trim()).filter(Boolean);
      let found: CanonHit[] = [];
      let lastDetail = "";
      for (const query of names) {
        try {
          const out = await getJson(`/dwarf-fortress/lore/resolve?query=${encodeURIComponent(query)}&kind=${kind}&session=${session}`);
          found = (out.hits as CanonHit[]) ?? [];
          if (found.length) break;
        } catch (e) {
          lastDetail = e instanceof Error ? e.message : String(e);
        }
      }
      if (!alive) return;
      setViewerBase(base);
      if (!found.length) {
        setStatus("error");
        if (/Not found/i.test(lastDetail)) setError("The lorekeeper routes are not active in the running DSH server yet — it needs an idle restart.");
        else if (/no df-universe/i.test(lastDetail)) setError("This workspace has no df-universe/corpus canon export.");
        else setError(names.length ? `No canon match for “${names[0]}” in this world.` : "Nothing to look up — the asset has no name yet.");
        return;
      }
      setHits(found);
      const first = found[0];
      setSelected(first);
      setStatus("ready");
      try {
        const out = await getJson(`/dwarf-fortress/lore/events?kind=${first.kind}&id=${encodeURIComponent(String(first.id))}&session=${session}`);
        if (alive) setEvents(((out.events as CanonEvent[]) ?? []).slice(0, 10));
      } catch {
        if (alive) setEvents([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = async (hit: CanonHit) => {
    setSelected(hit);
    setEvents([]);
    const session = encodeURIComponent(String((globalThis as unknown as { __DSH_DIRECTOR_SESSION__?: string }).__DSH_DIRECTOR_SESSION__ ?? ""));
    try {
      const out = await getJson(`/dwarf-fortress/lore/events?kind=${hit.kind}&id=${encodeURIComponent(String(hit.id))}&session=${session}`);
      setEvents(((out.events as CanonEvent[]) ?? []).slice(0, 10));
    } catch {
      setEvents([]);
    }
  };

  const viewerUrl = selected && viewerBase ? viewerBase + selected.viewer_path : "";

  return (
    <>
      <button
        type="button"
        className={"page-bookmark" + (open ? " open" : "")}
        aria-expanded={open}
        title={`Lorekeeper page for ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        lorekeeper
      </button>
      {open ? (
        <aside className="lore-page" aria-label={`Lorekeeper page for ${label}`}>
          <header className="lore-page-header">
            <h2>Lorekeeper</h2>
            <span className="lore-page-subject">{label}</span>
            <button type="button" className="lore-page-close" aria-label="Turn back" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          {status === "loading" ? <p className="empty-copy">Consulting the legends…</p> : null}
          {status === "error" ? <div className="banner error">{error}</div> : null}
          {status === "ready" ? (
            <>
              {hits.length > 1 ? (
                <div className="lore-candidates" role="tablist" aria-label="Canon candidates">
                  {hits.map((hit) => (
                    <button key={`${hit.kind}-${hit.id}`} type="button" role="tab" aria-selected={selected?.id === hit.id} className={selected?.id === hit.id ? "active" : ""} onClick={() => pick(hit)}>
                      <strong>{hit.name}</strong>
                      <small>{hit.kind}</small>
                    </button>
                  ))}
                </div>
              ) : null}
              {selected ? (
                <div className="lore-facts">
                  <strong>{selected.name}</strong>
                  <small>
                    {factLine(selected)} {selected.id != null ? `· legends id ${selected.id}` : ""}
                  </small>
                  {viewerUrl ? (
                    <a className="lore-open" href={viewerUrl} target="_blank" rel="noreferrer">
                      Open in LegendsViewer
                    </a>
                  ) : null}
                </div>
              ) : null}
              {events.length ? (
                <ul className="lore-events">
                  {events.map((event, index) => (
                    <li key={index}>
                      <span className="lore-event-year">{event.year ?? "—"}</span> {event.type}
                    </li>
                  ))}
                </ul>
              ) : null}
              {viewerUrl ? <iframe className="lore-viewer" title="LegendsViewer canon page" src={viewerUrl} /> : null}
            </>
          ) : null}
        </aside>
      ) : null}
    </>
  );
}
