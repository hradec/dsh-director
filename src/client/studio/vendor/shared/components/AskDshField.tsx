import { useState } from "react";

// Small inline control on every asset text field: type an instruction ("merge the notes into it",
// "shorten", "add the wing canon") and it rides the shared background task queue (same FIFO as the
// Footage AI-tag queue) to DSH, with the field's current value quoted. DSH applies it through the
// director_studio asset.update action; the toolbar chip shows the queue.

interface AskProps {
  field: string;
  value: string;
  kind: "actors" | "scenes" | "props";
  kindLabel: string;
  name: string;
  assetId: string;
  send: (text: string, label: string) => void;
}

export function AskDshField({ field, value, kind, kindLabel, name, assetId, send }: AskProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);

  function submit() {
    const instruction = draft.trim();
    if (!instruction) return;
    send(
      `Director Studio — edit the ${kindLabel} "${name}" (kind ${kind}, asset_id ${assetId}). Field "${field}" current value:\n"""\n${value}\n"""\nHuman request: ${instruction}\nApply the change with the director_studio asset.update action, then state briefly what changed.`,
      `${kindLabel} ${name} · ${field.toLowerCase()}`,
    );
    setDraft("");
    setOpen(false);
    setSent(true);
    setTimeout(() => setSent(false), 2500);
  }

  return (
    <div className="ask-dsh">
      <button type="button" className="btn secondary sm" onClick={() => setOpen(!open)}>
        Ask DSH about this…
      </button>
      {sent ? <span className="field-hint">Queued — watch the DSH queue chip.</span> : null}
      {open ? (
        <div className="ask-dsh-row">
          <input
            value={draft}
            placeholder={`what to do with the ${field.toLowerCase()}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button type="button" className="btn primary sm" disabled={!draft.trim()} onClick={submit}>
            Send
          </button>
        </div>
      ) : null}
    </div>
  );
}
