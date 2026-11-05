import type { JobStatus, OutputSlot } from "../api/types";

const DEFAULT_MAIN_KEYS = ["master", "bust_threeview", "fullbody_threeview", "asset_sheet"] as const;

const DEFAULT_LABELS: Record<string, string> = {
  master: "Actor Master",
  bust_threeview: "Bust Three-view",
  fullbody_threeview: "Full-body Three-view",
  asset_sheet: "Asset Sheet",
  wardrobe_ref: "Wardrobe Reference",
};

interface Props {
  status: JobStatus | "idle";
  outputs: Record<string, OutputSlot | null | undefined> | null;
  mainKeys?: readonly string[];
  labels?: Record<string, string>;
  featuredKey?: string | null;
  secondaryKey?: string | null;
  showSecondary?: boolean;
  onOpen: (slot: OutputSlot, all: OutputSlot[]) => void;
  // Plugin: when provided, each filled card gets a ✕ (top-right) to delete that stored render.
  onRemove?: ((key: string) => void) | null;
}

export function OutputGrid({
  status,
  outputs,
  mainKeys = DEFAULT_MAIN_KEYS,
  labels = DEFAULT_LABELS,
  featuredKey = null,
  secondaryKey = "wardrobe_ref",
  showSecondary = false,
  onOpen,
  onRemove = null,
}: Props) {
  const running = status === "queued" || status === "uploading" || status === "running";

  const mainSlots = mainKeys.map((key) => {
    const slot = outputs?.[key] || null;
    return { key, label: slot?.label || labels[key] || key, slot };
  });

  const featured = featuredKey ? mainSlots.find(({ key }) => key === featuredKey) || null : null;
  const supporting = featured ? mainSlots.filter(({ key }) => key !== featured.key) : mainSlots;
  const secondary = secondaryKey ? outputs?.[secondaryKey] || null : null;
  const openable = (featured ? [featured, ...supporting] : supporting)
    .map(({ slot }) => slot)
    .filter((slot): slot is OutputSlot => !!slot?.url)
    .concat(showSecondary && secondary?.url ? [secondary] : []);
  const dense = supporting.length > 4;

  return (
    <div className="output-grid-wrap">
      {featured ? (
        <div className="output-featured" role="group" aria-label="Final output">
          <OutputCard
            label={featured.label}
            slot={featured.slot}
            running={running}
            featured
            onRemove={onRemove}
            onOpen={() => featured.slot?.url && onOpen(featured.slot, openable)}
          />
        </div>
      ) : null}

      <div
        className={`output-grid ${dense ? "dense" : ""} ${featured ? "supporting" : ""}`}
        role="group"
        aria-label={featured ? "Supporting outputs" : "Outputs"}
      >
        {supporting.map(({ key, label, slot }) => (
          <OutputCard
            key={key}
            label={label}
            slot={slot}
            running={running}
            onRemove={onRemove}
            onOpen={() => slot?.url && onOpen(slot, openable)}
          />
        ))}
      </div>

      {showSecondary ? (
        <div className="output-secondary" role="group" aria-label="Reference input">
          <OutputCard
            label={secondary?.label || (secondaryKey ? labels[secondaryKey] : "") || secondaryKey || ""}
            slot={secondary}
            running={running}
            compact
            onOpen={() => secondary?.url && onOpen(secondary, openable)}
          />
        </div>
      ) : null}
    </div>
  );
}

function OutputCard({
  label,
  slot,
  running,
  compact,
  featured,
  onRemove,
  onOpen,
}: {
  label: string;
  slot: OutputSlot | null | undefined;
  running: boolean;
  compact?: boolean;
  featured?: boolean;
  onRemove?: ((key: string) => void) | null;
  onOpen: () => void;
}) {
  return (
    <article className={`output-card ${compact ? "compact" : ""} ${featured ? "featured" : ""}`} style={{ position: "relative" }}>
      {slot?.url && onRemove ? (
        <button
          type="button"
          className="btn ghost sm"
          title={`Delete ${label}`}
          aria-label={`Delete ${label}`}
          style={{ position: "absolute", top: "-0.5rem", right: "-0.5rem", width: "1.5rem", height: "1.5rem", padding: 0, borderRadius: "999px", border: "1px solid currentColor", lineHeight: 1, zIndex: 1 }}
          onClick={() => slot.key && onRemove(slot.key)}
        >
          ✕
        </button>
      ) : null}
      <div className="output-card-label">{label}</div>
      <div className="output-card-body">
        {slot?.url ? (
          <button type="button" className="output-thumb" onClick={onOpen}>
            <img src={slot.url} alt={label} />
          </button>
        ) : running ? (
          <div className="output-skeleton">
            <div className="pulse" />
          </div>
        ) : (
          <div className="output-empty">—</div>
        )}
      </div>
      {slot?.url ? (
        <div className="output-card-actions">
          <a className="btn ghost sm" href={slot.url} download={slot.filename || undefined}>
            Download
          </a>
        </div>
      ) : null}
    </article>
  );
}
