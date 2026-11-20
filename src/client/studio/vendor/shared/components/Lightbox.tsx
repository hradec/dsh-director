import { useEffect } from "react";
import type { OutputSlot } from "../api/types";
import { ZoomPanImage } from "./ImageCanvas";

interface Props {
  slots: (OutputSlot & { tags?: string[] })[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
  onApprove?: () => void;    // when set and not approved: Approve button over the image, top-right
}

export function Lightbox({ slots, index, onClose, onIndex }: Props) {
  const slot = slots[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex((index + 1) % slots.length);
      if (e.key === "ArrowLeft") onIndex((index - 1 + slots.length) % slots.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onClose, onIndex, slots.length]);

  if (!slot?.url) return null;

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-top">
          <span>{slot.label}</span>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="lightbox-stage">
          <ZoomPanImage src={slot.url} alt={slot.label} className="lightbox-canvas" />
          {slots.length > 1 ? (
            <>
              <button type="button" className="lightbox-arrow left" title="Previous" aria-label="Previous"
                onClick={() => onIndex((index - 1 + slots.length) % slots.length)}>‹</button>
              <button type="button" className="lightbox-arrow right" title="Next" aria-label="Next"
                onClick={() => onIndex((index + 1) % slots.length)}>›</button>
            </>
          ) : null}
          {slot.tags?.length ? (
            <div className="lightbox-tags">
              {slot.tags.map((tag) => (
                <span key={tag} className={`reference-chip${tag === "approved" ? " approved" : ""}`}>{tag}</span>
              ))}
              <span className="lightbox-counter">{index + 1} / {slots.length}</span>
            </div>
          ) : null}
          {onApprove && !slot.tags?.includes("approved") ? (
            <button type="button" className="btn sm lightbox-approve" onClick={onApprove}>✓ Approve</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
