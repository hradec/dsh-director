import {useState} from 'react';
import {CompareWipe,ZoomPanImage} from './studio/vendor/shared/components/ImageCanvas.tsx';

// Takes over a DSH GenUI media fence: the same images/videos the pretty fence showed,
// but live — one tab per image, wipe-compare between any two, wheel zoom + right-drag pan.
// ponytail: videos play below the image viewer (no wipe for video frames yet); upgrade path: frame-pick compare.
export function ChatMediaCard({items}) {
  const images = items.filter((i) => i.type === "image");
  const videos = items.filter((i) => i.type === "video");
  const [active, setActive] = useState(0);
  const [compare, setCompare] = useState(false);
  const label = (i) => i.label || i.alt || `image ${images.indexOf(i) + 1}`;
  return (
    <div className="dsh-fence-card">
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
        </div>
      ) : null}
      {images.length ? (compare && images.length > 1
        ? <CompareWipe tabs images={images.map((i) => ({src: i.src, label: label(i)}))} />
        : <ZoomPanImage src={images[active]?.src} alt={label(images[active] ?? {})} className="dsh-fence-canvas" />) : null}
      {videos.length ? <div className="dsh-fence-videos">{videos.map((v, n) => <video key={n} src={v.src} controls preload="metadata" />)}</div> : null}
    </div>
  );
}
