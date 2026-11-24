import { useEffect, useMemo, useState } from "react";
import { getJson, remapViewer } from "./LorekeeperPage";

// Second book-page bookmark: the LINEAGE spread. The dwarf plugin's /lore/family
// returns the figure plus grandparents → parents → subject+spouses → children.
// Rendered on a SHARED TIME AXIS: one row per person, grouped by generation,
// each bar spanning birth→death across a common year scale (approved layout).
// Data comes from the dsh-director-dwarf-fortress plugin, same session plumbing
// as the lorekeeper page.

interface FamNode {
  id: number;
  name: string;
  race?: string | null;
  birth_year: number | null;
  death_year: number | null;
  relation: "self" | "spouse" | "parent" | "grandparent" | "child" | string;
  generation: number;
  viewer_path: string;
}

interface FamEdge {
  source: number;
  target: number;
  type: "parent" | "spouse" | string;
}

const COLORS: Record<string, string> = {
  self: "#8a3b2f",
  spouse: "#a9743f",
  parent: "#6a5a44",
  grandparent: "#8b8577",
  child: "#4f6b4a",
};

const GEN_ORDER = [-2, -1, 0, 1];
// Within a generation: subject first, then spouses, then the rest by birth year.
const REL_ORDER: Record<string, number> = { self: 0, spouse: 1, parent: 2, grandparent: 3, child: 4 };

export function FamilyTreePage({ queries, label, forceOpen }: { queries: string[]; label: string; forceOpen?: boolean }) {
  const [openState, setOpen] = useState(false);
  const open = forceOpen ?? openState;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [nodes, setNodes] = useState<FamNode[]>([]);
  const [edges, setEdges] = useState<FamEdge[]>([]);
  const [figureName, setFigureName] = useState("");
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
      } catch {
        if (!alive) return;
        setStatus("error");
        setError("Lorekeeper service unreachable — the running DSH server needs an idle restart to load it.");
        return;
      }
      const names = queries.map((item) => item.trim()).filter(Boolean);
      let lastDetail = "";
      for (const query of names) {
        try {
          const out = await getJson(`/dwarf-fortress/lore/family?query=${encodeURIComponent(query)}&session=${session}`);
          if (!alive) return;
          setViewerBase(base);
          setFigureName(String(out.name ?? query));
          setNodes((out.nodes as FamNode[]) ?? []);
          setEdges((out.edges as FamEdge[]) ?? []);
          setStatus("ready");
          return;
        } catch (e) {
          lastDetail = e instanceof Error ? e.message : String(e);
        }
      }
      if (!alive) return;
      setStatus("error");
      if (/Not found/i.test(lastDetail)) setError("The lineage routes are not active in the running DSH server yet — it needs an idle restart.");
      else if (/no df-universe/i.test(lastDetail)) setError("This workspace has no df-universe/corpus canon export.");
      else if (/No matching figure/i.test(lastDetail)) setError(`No canon figure matches “${names[0] ?? label}” in this world.`);
      else setError(lastDetail || "Nothing to look up — the asset has no name yet.");
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Timeline geometry: one row per person grouped by generation, x = year.
  const layout = useMemo(() => {
    if (!nodes.length) return null;
    const rows: FamNode[] = [];
    for (const gen of GEN_ORDER) {
      const group = nodes
        .filter((n) => n.generation === gen)
        .sort((a, b) => (REL_ORDER[a.relation] ?? 5) - (REL_ORDER[b.relation] ?? 5) || (a.birth_year ?? 1e9) - (b.birth_year ?? 1e9) || a.id - b.id);
      rows.push(...group);
    }
    // relatives outside the planned generations (unexpected canon shapes) still render
    for (const n of nodes) if (!GEN_ORDER.includes(n.generation)) rows.push(n);
    const dated = nodes.filter((n) => n.birth_year != null);
    const min = Math.min(...dated.map((n) => n.birth_year as number));
    const max = Math.max(...dated.map((n) => n.death_year ?? (n.birth_year as number)), ...dated.map((n) => n.birth_year as number));
    const span = max - min || 1;
    const pad = span * 0.04;
    const plotW = 860;
    const x = (year: number) => Math.round(46 + ((year - (min - pad)) / (span + 2 * pad)) * plotW);
    const rowH = 46;
    const barH = 14;
    const top = 10;
    const rowIndex = new Map<FamNode["id"], number>();
    rows.forEach((person, i) => rowIndex.set(person.id, i));
    const barEnd = (n: FamNode) => x(n.death_year ?? max);
    const midX = (n: FamNode) => Math.round((x(n.birth_year as number) + barEnd(n)) / 2);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const height = top + rows.length * rowH + 34;
    return { rows, rowIndex, byId, min, max, x, rowH, barH, top, barEnd, midX, plotW, height, width: 46 + plotW + 60 };
  }, [nodes]);

  const openViewer = (node: FamNode) => {
    if (viewerBase) window.open(viewerBase + node.viewer_path, "_blank", "noopener");
  };

  const yearsOf = (n: FamNode) => (n.birth_year == null ? "dates lost" : n.death_year == null ? `${n.birth_year}– alive` : `${n.birth_year}–${n.death_year}`);

  return (
    <>
      <button
        type="button"
        className={"page-bookmark lineage" + (open ? " open" : "")}
        aria-expanded={open}
        title={`Lineage page for ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        lineage
      </button>
      {open ? (
        <aside className="lore-page lineage-page" aria-label={`Lineage page for ${label}`}>
          <header className="lore-page-header">
            <h2>Lineage</h2>
            <span className="lore-page-subject">{figureName || label}</span>
            <button type="button" className="lore-page-close" aria-label="Turn back" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          {status === "loading" ? <p className="empty-copy">Tracing the family lines…</p> : null}
          {status === "error" ? <div className="banner error">{error}</div> : null}
          {status === "ready" && layout ? (
            <div className="family-scroll">
              <svg className="family-tree" width={layout.width} height={layout.height} role="img" aria-label={`Family timeline of ${figureName}`}>
                {/* year gridlines: start, middle, end of the recorded age of the world slice */}
                {[layout.min, Math.round((layout.min + layout.max) / 2), layout.max].map((year, i) => (
                  <g key={i}>
                    <line className="family-grid" x1={layout.x(year)} y1={layout.top - 4} x2={layout.x(year)} y2={layout.height - 26} />
                    <text className="family-axis" x={layout.x(year)} y={layout.height - 10} textAnchor="middle">
                      {year}
                    </text>
                  </g>
                ))}
                {/* connectors first so bars sit on top */}
                {edges.map((edge, i) => {
                  const a = layout.byId.get(edge.source);
                  const b = layout.byId.get(edge.target);
                  if (!a || !b || a.birth_year == null || b.birth_year == null) return null;
                  const ai = layout.rowIndex.get(a.id);
                  const bi = layout.rowIndex.get(b.id);
                  if (ai === undefined || bi === undefined) return null;
                  const ay = layout.top + ai * layout.rowH + layout.barH + 3;
                  const by = layout.top + bi * layout.rowH - 4;
                  if (edge.type === "spouse") {
                    const joint = (ay + by) / 2;
                    return <polyline key={i} className="family-link family-spouse-link" points={`${layout.midX(a)},${ay} ${layout.midX(a)},${joint} ${layout.midX(b)},${joint} ${layout.midX(b)},${by < ay ? by + layout.barH + 7 : by}`} />;
                  }
                  // parent (a) → child (b): drop from the parent bar's middle, elbow into the child's birth point
                  const joint = (ay + by) / 2;
                  return <polyline key={i} className="family-link" points={`${layout.midX(a)},${ay} ${layout.midX(a)},${joint} ${layout.x(b.birth_year)},${joint} ${layout.x(b.birth_year)},${by}`} />;
                })}
                {layout.rows.map((n, i) => {
                  const y = layout.top + i * layout.rowH;
                  const color = COLORS[n.relation] ?? "#777";
                  const alive = n.death_year == null && n.birth_year != null;
                  return (
                    <g key={n.id} className="family-node" onClick={() => openViewer(n)}>
                      <title>
                        {n.name}
                        {n.race ? ` · ${n.race}` : ""} · {yearsOf(n)} — open in LegendsViewer
                      </title>
                      <text className="family-name" x={n.birth_year != null ? layout.x(n.birth_year) : 46} y={y - 4}>
                        {n.name}
                      </text>
                      {n.birth_year != null ? (
                        <>
                          <rect
                            className={"family-bar" + (alive ? " alive" : "")}
                            x={layout.x(n.birth_year)}
                            y={y}
                            width={Math.max(3, layout.barEnd(n) - layout.x(n.birth_year))}
                            height={layout.barH}
                            rx={3}
                            fill={color}
                          />
                          <text className="family-years" x={layout.barEnd(n) + 5} y={y + layout.barH - 3}>
                            {yearsOf(n)}
                          </text>
                        </>
                      ) : (
                        <text className="family-years" x={46 + n.name.length * 7.5} y={y + layout.barH - 3}>
                          {yearsOf(n)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              <p className="family-hint">bars span birth→death on a shared year scale · rows are generations (top: grandparents → bottom: children) · click a bar to open the canon page</p>
            </div>
          ) : null}
          {status === "ready" && nodes.length === 0 ? <p className="empty-copy">No recorded family lines for {figureName || label}.</p> : null}
        </aside>
      ) : null}
    </>
  );
}
