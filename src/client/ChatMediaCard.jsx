import {useState} from "react";
import {CompareWipe,ZoomPanImage} from "./studio/vendor/shared/components/ImageCanvas.tsx";

export const MEDIA_TRANSFER = "application/x-director-media";

// Takes over a DSH GenUI media fence: the same images/videos the pretty fence showed,
// but live — one tab per image, wipe-compare between any two, wheel zoom + right-drag pan.
// Left-drag carries this card's media (drop on another card = merge); right-drag stays pan.
// ponytail: videos play below the image viewer (no wipe for video frames yet); upgrade path: frame-pick compare.
export function ChatMediaCard({items, onMerge, onReset, merged}) {
  const images = items.filter((i) => i.type === "image");
  const videos = items.filter((i) => i.type === "video");
  const [active, setActive] = useState(0);
  const [compare, setCompare] = useState(false);
  const [over, setOver] = useState(false);
  const label = (i) => i.label || i.alt || `image ${images.indexOf(i) + 1}`;
  const dragStart = (e) => {
    e.dataTransfer.clearData?.(); // drop the native img ghost payload; this card's JSON is the transfer
    e.dataTransfer.setData(MEDIA_TRANSFER, JSON.stringify(items));
    e.dataTransfer.effectAllowed = "copy";
  };
  const dragOver = (e) => {
    const types = e.dataTransfer?.types;
    if (types && ![...types].includes(MEDIA_TRANSFER)) return;
    e.preventDefault();
    setOver(true);
  };
  const drop = (e) => {
    const raw = e.dataTransfer?.getData?.(MEDIA_TRANSFER);
    if (!raw) return;
    e.preventDefault();
    setOver(false);
    try { onMerge?.(JSON.parse(raw)); } catch {}
  };
  return (
    <div className={`dsh-fence-card${over ? " drop-over" : ""}`} draggable onDragStart={dragStart} onDragOver={dragOver} onDragLeave={() => setOver(false)} onDrop={drop}>
      {images.length ? (
        <div className="dsh-fence-bar">
          {images.length > 1 ? (
            <div className="dsh-fence-tabs" role="tablist" aria-label="Card images">
              {images.map((i, n) => (
                <button key={n} type="button" role="tab" aria-selected={!compare && active === n} onClick={() => { setCompare(false); setActive(n); }}>{label(i)}</button>
              ))}
            </div>
          ) : <span className="dsh-fence-title">{label(images[0])}</span>}
          {images.length > 1 ? <button type="button" className="dsh-fence-mode" aria-pressed={compare} onClick={() => setCompare((v) => !v)}>{compare ? "Viewer" : "Compare"}</button> : null}
          {merged ? <button type="button" className="dsh-fence-reset" title="Back to this card's original media" onClick={onReset}>↺ original</button> : null}
        </div>
      ) : null}
      {images.length ? (compare && images.length > 1
        ? <CompareWipe tabs images={images.map((i) => ({src: i.src, label: label(i)}))} />
        : <ZoomPanImage src={images[active]?.src} alt={label(images[active] ?? {})} className="dsh-fence-canvas" />) : null}
      {videos.length ? <div className="dsh-fence-videos">{videos.map((v, n) => <video key={n} src={v.src} controls preload="metadata" draggable={false} />)}</div> : null}
    </div>
  );
}
