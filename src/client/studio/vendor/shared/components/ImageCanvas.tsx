import { useEffect, useRef, useState } from "react";

// Shared image-canvas widget: wheel zooms toward the cursor, right-drag pans, double-click resets.
export interface ImageView {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY: ImageView = { scale: 1, x: 0, y: 0 };

// ponytail: naive anchored zoom — keeps the image point under the cursor fixed; scale clamped to 1..8;
// snapping back to 1 recenters. Upgrade path: clamp pan to image bounds when scale > 1.
export function zoomAt(view: ImageView, factor: number, cx: number, cy: number): ImageView {
  const scale = Math.min(8, Math.max(1, view.scale * factor));
  const k = scale / view.scale;
  const x = cx - (cx - view.x) * k;
  const y = cy - (cy - view.y) * k;
  return scale === 1 ? { ...IDENTITY } : { scale, x, y };
}

function useWheelZoom(ref: React.RefObject<HTMLDivElement>, apply: (update: (prev: ImageView) => ImageView) => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      apply((prev) => zoomAt(prev, event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - rect.left, event.clientY - rect.top));
    };
    // wheel must be non-passive to preventDefault (page must not scroll while zooming the canvas).
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, apply]);
}

export function ZoomPanImage({ src, alt, className, view, onView }: { src: string; alt: string; className?: string; view?: ImageView; onView?: (update: (prev: ImageView) => ImageView) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [inner, setInner] = useState<ImageView>(IDENTITY);
  const current = view ?? inner;
  const apply = onView ?? setInner;
  const drag = useRef<{ x: number; y: number } | null>(null);
  useWheelZoom(host, apply);
  return (
    <div
      ref={host}
      className={`image-canvas${className ? ` ${className}` : ""}`}
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={() => apply(() => IDENTITY)}
      onPointerDown={(event) => {
        if (event.button !== 2) return;
        event.preventDefault();
        drag.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y;
        drag.current = { x: event.clientX, y: event.clientY };
        apply((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <img src={src} alt={alt} draggable={false} style={{ transform: `translate(${current.x}px, ${current.y}px) scale(${current.scale})` }} />
      {current.scale !== 1 ? <button type="button" className="image-canvas-reset" onClick={() => apply(() => IDENTITY)}>{`×${current.scale.toFixed(1)} reset`}</button> : null}
    </div>
  );
}

// Compare two (pick from more): A sits clipped over B; the slider wipes A; pan/zoom is shared so matching
// details stay registered. ponytail: assumes similar aspect ratios — mismatched pairs letterbox.
export function CompareWipe({ images }: { images: { src: string; label: string }[] }) {
  const [a, setA] = useState(0);
  const [b, setB] = useState(1);
  const [wipe, setWipe] = useState(50);
  const [view, setView] = useState<ImageView>(IDENTITY);
  const options = images.map((image, index) => ({ image, index })).filter(({ image }) => image.src);
  if (options.length < 2) return null;
  const ia = options.find((o) => o.index === a) ?? options[0];
  const ib = options.find((o) => o.index === b && o.index !== ia.index) ?? options.find((o) => o.index !== ia.index)!;
  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  return (
    <div className="image-compare">
      <div className="image-canvas image-compare-stage">
        <StageWheel setView={setView} />
        <img src={ib.src} alt={`${ib.label} (B)`} draggable={false} className="compare-bottom" style={{ transform }} />
        <img src={ia.src} alt={`${ia.label} (A)`} draggable={false} className="compare-top" style={{ transform, clipPath: `inset(0 ${100 - wipe}% 0 0)` }} />
        <div className="compare-line" style={{ left: `${wipe}%` }} />
        {view.scale !== 1 ? <button type="button" className="image-canvas-reset" onClick={() => setView(() => IDENTITY)}>{`×${view.scale.toFixed(1)} reset`}</button> : null}
      </div>
      <div className="image-compare-bar">
        <select value={ia.index} onChange={(event) => setA(Number(event.target.value))}>{options.map(({ image, index }) => <option key={index} value={index}>{`A · ${image.label}`}</option>)}</select>
        <input type="range" min={0} max={100} value={wipe} onChange={(event) => setWipe(Number(event.target.value))} aria-label="Wipe between A and B" />
        <select value={ib.index} onChange={(event) => setB(Number(event.target.value))}>{options.map(({ image, index }) => <option key={index} value={index}>{`B · ${image.label}`}</option>)}</select>
        <button type="button" onClick={() => { setA(ib.index); setB(ia.index); }} aria-label="Swap A and B">⇄</button>
      </div>
    </div>
  );
}

// internal: wheel/right-drag/dblclick on the compare stage; functional view updates mean the
// listeners attach once and never interfere mid-gesture.
function StageWheel({ setView }: { setView: (update: (prev: ImageView) => ImageView) => void }) {
  const host = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = host.current?.parentElement;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((prev) => zoomAt(prev, event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - rect.left, event.clientY - rect.top));
    };
    const onContext = (event: MouseEvent) => event.preventDefault();
    let drag: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => { if (event.button !== 2) return; event.preventDefault(); drag = { x: event.clientX, y: event.clientY }; };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag = { x: event.clientX, y: event.clientY };
      setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    };
    const up = () => { drag = null; };
    const dbl = () => setView(() => IDENTITY);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onContext);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("dblclick", dbl);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onContext);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("dblclick", dbl);
    };
  }, [setView]);
  return <span ref={host} />;
}
