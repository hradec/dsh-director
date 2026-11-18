import { useState } from "react";

// Small inline control on every asset text field: type an instruction ("merge the notes into it",
// "shorten", "add the wing canon") and it is sent to DSH with the field's current value quoted.
// DSH applies the change through the director_studio asset.update action; reload shows it.

interface AskProps {
  field: string;
  value: string;
  kind: "actors" | "scenes" | "props";
  kindLabel: string;
  name: string;
  assetId: string;
  send: (text: string) => Promise<void>;
}

export function AskDshField({ field, value, kind, kindLabel, name, assetId, send }: AskProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    const instruction = draft.trim();
    if (!instruction || busy) return;
    setBusy(true);
    try {
      await send(
        `Director Studio — edit the ${kindLabel} "${name}" (kind ${kind}, asset_id ${assetId}). ` +
          `Field "${field}" current value:\n"""\n${value}\n"""\n` +
          `Human request: ${instruction}\n` +
          `Apply the change with the director_studio asset.update action for this asset, then state briefly what changed.`,
      );
      setDraft("");
      setOpen(false);
      setSent(true);
      setTimeout(() => setSent(false), 2500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ask-dsh">
      <button type="button" className="btn secondary sm" onClick={() => setOpen(!open)}>
        Ask DSH about this…
      </button>
      {sent ? <span className="field-hint">Sent to DSH — reload the page once it answers.</span> : null}
      {open ? (
        <div className="ask-dsh-row">
          <input
            value={draft}
            placeholder={`what to do with the ${field.toLowerCase()}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button type="button" className="btn primary sm" disabled={!draft.trim() || busy} onClick={() => void submit()}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
