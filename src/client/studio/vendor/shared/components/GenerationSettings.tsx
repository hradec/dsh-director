import { useState } from "react";

interface Props {
  initial: string;
  onSave: (text: string) => Promise<void>;
  disabled?: boolean;
}

// Plugin: gear button opening free-form instructions the DSH agent follows for future generations of this kind.
export function GenerationSettings({ initial, onSave, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-start", gap: "0.5rem", flexWrap: "wrap" }}>
      <button
        type="button"
        className="btn ghost sm"
        title="How DSH should generate this kind"
        aria-label="Generation settings"
        aria-expanded={open}
        style={{ width: "2rem", height: "2rem", fontSize: "1.15rem", padding: 0, borderRadius: "999px", lineHeight: 1 }}
        onClick={() => setOpen((v) => !v)}
      >
        ⚙
      </button>
      {open ? (
        <span className="field" style={{ display: "inline-flex", flexDirection: "column", gap: "0.35rem", minWidth: "min(22rem, 90%)" }}>
          <textarea
            rows={3}
            value={text}
            disabled={disabled || busy}
            placeholder="Instructions for DSH: which ComfyUI template, model, LoRAs, framing rules…"
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
          />
          <span style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center" }}>
            <button
              type="button"
              className="btn secondary sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onSave(text)
                  .then(() => setSaved(true))
                  .finally(() => setBusy(false));
              }}
            >
              Save
            </button>
            {saved ? <span className="field-hint">Saved — DSH will follow it on the next generation.</span> : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}
